/**
 * Deterministic Context Compiler
 * Implements §3.2 (4-step deterministic routing) of プロジェクト計画v2.md
 *
 * base: deterministic DAG routing
 * expanded: best-effort SLM-inferred context via IntentTagger + tag_mappings
 */

import picomatch from 'picomatch';
import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../store/repository.js';
import type { IntentTagger } from '../tagging/tagger.js';
import type { CompiledContext, CompileRequest, Edge, ResolvedDoc, ResolvedEdge } from '../types.js';

/**
 * Deterministic sort for edges: specificity DESC → priority ASC → edge_id ASC.
 * The edge_id tiebreaker guarantees a fully deterministic order (P-1).
 */
function sortEdges(edges: Edge[]): Edge[] {
  return [...edges].sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.edge_id.localeCompare(b.edge_id);
  });
}

export class ContextCompiler {
  constructor(
    private repo: Repository,
    private tagger: IntentTagger | null = null,
  ) {}

  /**
   * compile_context — deterministic base routing + best-effort expanded context.
   * Steps: path_requires → layer_requires → command_requires → doc_depends_on closure
   * Then: if plan + tagger → expanded via tag_mappings
   */
  async compile(request: CompileRequest): Promise<CompiledContext> {
    const snapshot = this.repo.getCurrentSnapshot();
    if (!snapshot) {
      return this.emptyResult(request, ['Project not initialized (no snapshot exists)']);
    }

    const collectedEdges: Edge[] = [];
    const collectedDocIds = new Set<string>();

    // ── Step 1: path_requires ──
    const pathMatched: Edge[] = [];
    const pathEdges = this.repo.getApprovedEdgesByType('path_requires');
    for (const edge of pathEdges) {
      const matcher = picomatch(edge.source_value);
      for (const file of request.target_files) {
        if (matcher(file)) {
          pathMatched.push(edge);
          break; // one match per edge is enough
        }
      }
    }
    for (const edge of sortEdges(pathMatched)) {
      collectedEdges.push(edge);
      collectedDocIds.add(edge.target_doc_id);
    }

    // ── Step 2: layer_requires ──
    const resolvedLayers = this.resolveLayers(request);
    if (resolvedLayers.length > 0) {
      const layerMatched: Edge[] = [];
      const layerEdges = this.repo.getApprovedEdgesByType('layer_requires');
      for (const edge of layerEdges) {
        if (resolvedLayers.includes(edge.source_value)) {
          layerMatched.push(edge);
        }
      }
      for (const edge of sortEdges(layerMatched)) {
        collectedEdges.push(edge);
        collectedDocIds.add(edge.target_doc_id);
      }
    }

    // ── Step 3: command_requires ──
    if (request.command) {
      const cmdMatched: Edge[] = [];
      const commandEdges = this.repo.getApprovedEdgesByType('command_requires');
      for (const edge of commandEdges) {
        if (edge.source_value === request.command) {
          cmdMatched.push(edge);
        }
      }
      for (const edge of sortEdges(cmdMatched)) {
        collectedEdges.push(edge);
        collectedDocIds.add(edge.target_doc_id);
      }
    }

    // ── Step 4: doc_depends_on transitive closure ──
    const startDocIds = [...collectedDocIds];
    const deps = this.repo.getTransitiveDependencies(startDocIds);

    // Add dependency edges to resolution_path
    const depDocIds = deps.map((d) => d.doc_id);
    const newDepDocIds = depDocIds.filter((id) => !collectedDocIds.has(id));
    if (newDepDocIds.length > 0) {
      const depMatched: Edge[] = [];
      const allDocEdges = this.repo.getApprovedEdgesByType('doc_depends_on');
      const reachableSet = new Set(depDocIds);
      for (const edge of allDocEdges) {
        if (reachableSet.has(edge.source_value) && reachableSet.has(edge.target_doc_id)) {
          depMatched.push(edge);
        }
      }
      for (const edge of sortEdges(depMatched)) {
        collectedEdges.push(edge);
      }
      for (const id of newDepDocIds) {
        collectedDocIds.add(id);
      }
    }

    // ── Fetch documents ──
    const allDocIds = [...collectedDocIds];
    const docs = this.repo.getApprovedDocumentsByIds(allDocIds);

    // Separate templates from regular documents
    const regularDocs: ResolvedDoc[] = [];
    const templateDocIds: string[] = [];
    const templates: { name: string; content: string }[] = [];

    // Sort by specificity DESC → priority ASC → doc_id ASC for deterministic display order
    const docOrderMap = this.buildDocOrderMap(collectedEdges);
    const sortedDocs = [...docs].sort((a, b) => {
      const orderA = docOrderMap.get(a.doc_id) ?? { specificity: 0, priority: 100 };
      const orderB = docOrderMap.get(b.doc_id) ?? { specificity: 0, priority: 100 };
      if (orderB.specificity !== orderA.specificity) return orderB.specificity - orderA.specificity;
      if (orderA.priority !== orderB.priority) return orderA.priority - orderB.priority;
      return a.doc_id.localeCompare(b.doc_id);
    });

    for (const doc of sortedDocs) {
      if (doc.kind === 'template') {
        templateDocIds.push(doc.doc_id);
        templates.push({ name: doc.title, content: doc.content });
      } else {
        regularDocs.push({
          doc_id: doc.doc_id,
          title: doc.title,
          kind: doc.kind,
          content: doc.content,
        });
      }
    }

    // ── Build resolution_path (deduplicated, phase-ordered) ──
    const seenEdgeIds = new Set<string>();
    const resolutionPath: ResolvedEdge[] = [];
    for (const edge of collectedEdges) {
      if (!seenEdgeIds.has(edge.edge_id)) {
        seenEdgeIds.add(edge.edge_id);
        resolutionPath.push({
          edge_id: edge.edge_id,
          source_type: edge.source_type,
          source_value: edge.source_value,
          target_doc_id: edge.target_doc_id,
          edge_type: edge.edge_type,
        });
      }
    }

    // ── Build result ──
    const compileId = uuidv4();
    const warnings: string[] = [];
    const result: CompiledContext = {
      compile_id: compileId,
      snapshot_id: snapshot.snapshot_id,
      knowledge_version: snapshot.knowledge_version,
      base: {
        documents: regularDocs,
        resolution_path: resolutionPath,
        templates,
      },
      warnings,
    };

    // ── Expanded context (best-effort, non-fatal) ──
    let expandedDocIds: string[] | null = null;

    if (request.plan && this.tagger) {
      try {
        const knownTags = this.repo.getAllTags();
        const tags = await this.tagger.extractTags(request.plan, knownTags);
        const tagNames = tags.map((t) => t.tag);

        if (tagNames.length > 0) {
          const candidates = this.repo.getDocumentsByTags(tagNames);

          // Exclude docs already in base (both documents and templates)
          const baseDocIdSet = new Set([...regularDocs.map((d) => d.doc_id), ...templateDocIds]);
          const filtered = candidates.filter((c) => !baseDocIdSet.has(c.doc_id));

          // Fetch full documents, preserving getDocumentsByTags order
          const expandedIds = filtered.map((c) => c.doc_id);
          const fetchedDocs = this.repo.getApprovedDocumentsByIds(expandedIds);
          const fetchedMap = new Map(fetchedDocs.map((d) => [d.doc_id, d]));

          // Re-order to match getDocumentsByTags deterministic order
          const expandedDocs: ResolvedDoc[] = [];
          for (const id of expandedIds) {
            const doc = fetchedMap.get(id);
            if (doc) {
              expandedDocs.push({
                doc_id: doc.doc_id,
                title: doc.title,
                kind: doc.kind,
                content: doc.content,
              });
            }
          }

          // Build confidence & reasoning from tag match data
          const avgConfidence =
            filtered.length > 0 ? filtered.reduce((sum, c) => sum + c.max_confidence, 0) / filtered.length : 0;
          const reasoning = filtered.map((c) => `${c.doc_id} matched [${c.matched_tags.join(', ')}]`).join('; ');

          result.expanded = {
            documents: expandedDocs,
            confidence: Math.round(avgConfidence * 100) / 100,
            reasoning: reasoning || 'No additional documents matched',
            resolution_path: [],
          };

          expandedDocIds = expandedDocs.map((d) => d.doc_id);
        } else {
          // Tagger returned no tags
          result.expanded = {
            documents: [],
            confidence: 0,
            reasoning: 'Tagger returned no tags for the given plan',
            resolution_path: [],
          };
          expandedDocIds = [];
        }
      } catch (err) {
        warnings.push(`Expanded context skipped: tagger failed (${(err as Error).message})`);
        // expanded stays undefined, expandedDocIds stays null
      }
    }
    // else: no plan or no tagger → expanded stays undefined, expandedDocIds stays null

    // ── Record compile_log (INV-5) ──
    this.repo.insertCompileLog({
      compile_id: compileId,
      snapshot_id: snapshot.snapshot_id,
      request: JSON.stringify(request),
      base_doc_ids: JSON.stringify(regularDocs.map((d) => d.doc_id)),
      expanded_doc_ids: expandedDocIds !== null ? JSON.stringify(expandedDocIds) : null,
    });

    return result;
  }

  /**
   * get_compile_audit — retrieve a past compile_context invocation.
   */
  getCompileAudit(compileId: string):
    | {
        compile_id: string;
        snapshot_id: string;
        knowledge_version: number;
        request: object;
        base_doc_ids: string[];
        expanded_doc_ids: string[] | null;
        created_at: string;
      }
    | undefined {
    const log = this.repo.getCompileLog(compileId);
    if (!log) return undefined;

    const snapshot = this.repo.getSnapshotById(log.snapshot_id);

    return {
      compile_id: log.compile_id,
      snapshot_id: log.snapshot_id,
      knowledge_version: snapshot?.knowledge_version ?? 0,
      request: JSON.parse(log.request),
      base_doc_ids: JSON.parse(log.base_doc_ids),
      expanded_doc_ids: log.expanded_doc_ids ? JSON.parse(log.expanded_doc_ids) : null,
      created_at: log.created_at,
    };
  }

  // ── Private helpers ──

  /**
   * Resolve layers from request.
   * If target_layers is explicitly provided, use that.
   * Otherwise, infer from target_files using layer_rules.
   */
  private resolveLayers(request: CompileRequest): string[] {
    if (request.target_layers && request.target_layers.length > 0) {
      return request.target_layers;
    }

    const rules = this.repo.getApprovedLayerRules();
    if (rules.length === 0) return [];

    // Sort by specificity DESC → priority ASC → rule_id ASC (deterministic)
    const sortedRules = [...rules].sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.rule_id.localeCompare(b.rule_id);
    });

    const layers = new Set<string>();
    for (const file of request.target_files) {
      for (const rule of sortedRules) {
        const matcher = picomatch(rule.path_pattern);
        if (matcher(file)) {
          layers.add(rule.layer_name);
          break;
        }
      }
    }

    return [...layers];
  }

  /**
   * Build a map of doc_id → best (highest specificity, lowest priority) edge ordering.
   * Used only for display order.
   */
  private buildDocOrderMap(edges: Edge[]): Map<string, { specificity: number; priority: number }> {
    const map = new Map<string, { specificity: number; priority: number }>();
    for (const edge of edges) {
      const existing = map.get(edge.target_doc_id);
      if (
        !existing ||
        edge.specificity > existing.specificity ||
        (edge.specificity === existing.specificity && edge.priority < existing.priority)
      ) {
        map.set(edge.target_doc_id, { specificity: edge.specificity, priority: edge.priority });
      }
    }
    return map;
  }

  private emptyResult(_request: CompileRequest, warnings: string[]): CompiledContext {
    return {
      compile_id: '',
      snapshot_id: '',
      knowledge_version: 0,
      base: { documents: [], resolution_path: [], templates: [] },
      warnings,
    };
  }
}
