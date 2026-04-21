/**
 * Aegis MCP Server
 * Tool registration only. All business logic delegated to AegisService.
 *
 * Surface separation (INV-6):
 * - Agent Surface: compile_context, observe, get_compile_audit, get_known_tags, init_detect (5 tools)
 * - Admin Surface: same 5 plus 18 admin-only (list/get proposals, approve/reject, bundle preflight/approve,
 *                  init_confirm, check_upgrade, apply_upgrade, archive_observations, get_stats, import_doc,
 *                  analyze_doc, analyze_import_batch, execute_import_plan, list/process_observations, sync_docs)
 *                  → 23 tools total on admin surface (5 shared + 18 admin-only)
 * - propose is NOT exposed (internal only)
 *
 * init_detect is on both surfaces (read-only preview).
 * init_confirm is admin-only (mutates Canonical).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BudgetExceededError } from '../core/types.js';
import { type AegisService, ObserveValidationError, type Surface } from './services.js';

type TextContent = { type: 'text'; text: string };

/** Build MCP content blocks for aegis_observe response. Exported for testing. */
export function buildObserveContent(result: { observation_id: string }, eventType: string): TextContent[] {
  const content: TextContent[] = [{ type: 'text', text: JSON.stringify(result) }];
  if (eventType === 'compile_miss') {
    content.push({
      type: 'text',
      text: 'Hint: An admin should run `aegis_list_observations({ outcome: "skipped" })` periodically to triage compile misses that the analyzer could not automatically resolve.',
    });
  }
  return content;
}

const WORKFLOW_GUIDE = `# Aegis Workflow Guide

## Core Workflow: Read → Write → Approve

1. **Read** — Before editing, call \`aegis_compile_context\` with your target files.
   Aegis returns relevant guidelines, patterns, constraints, and templates.

   Each document has a \`delivery\` field:
   - \`inline\`: Full content is included in the response. Read it directly.
   - \`deferred\`: Content is NOT included. You MUST Read the file via \`source_path\` before proceeding. Prioritize by \`relevance\` score (high first); skip only documents with very low relevance (< 0.25) unless specifically needed.
   - \`omitted\`: Excluded by budget or policy. Increase \`max_inline_bytes\` or use \`content_mode: "always"\` if needed.

   The default \`content_mode\` is \`auto\`: documents with \`source_path\` are deferred (except small ones ≤ 4KB),
   documents without \`source_path\` are always inlined. Use \`content_mode: "always"\` to force all documents inline.

2. **Write** — After coding, report what happened via \`aegis_observe\`:
   - \`compile_miss\`: context didn't cover what was needed
   - \`review_correction\`: reviewer corrected an agent's output
   - \`pr_merged\`: PR merged with file changes
   - \`manual_note\`: freeform knowledge capture
   - \`document_import\`: propose importing a document into Canonical (admin pipeline)
   - \`doc_gap_detected\`: diagnostic gap record (ADR-015 \`DocGapPayload\`; no proposal)

3. **Approve** — Admin reviews proposals generated from observations:
   - \`aegis_list_proposals\` → \`aegis_get_proposal\` → \`aegis_approve_proposal\` / \`aegis_reject_proposal\`

## Admin Operations

- \`aegis_init_detect\` + \`aegis_init_confirm\`: Initialize a project
- \`aegis_import_doc\`: Import existing documents with explicit metadata
- \`aegis_process_observations\`: Run the analyzer pipeline on pending observations
- \`aegis_list_observations\`: Triage observations by outcome (proposed/skipped/pending)
- \`aegis_check_upgrade\` + \`aegis_apply_upgrade\`: Template version upgrades

## Key Principles

- **Observation → Proposal → Canonical**: No direct writes to Canonical Knowledge
- **Agent surface is read-only**: Agents can read context and record observations, but cannot approve
- **Deterministic context**: Same inputs always produce the same compiled context
`;

const sourceRefSchema = z
  .object({
    asset_path: z.string(),
    anchor_type: z.enum(['file', 'section', 'lines']),
    anchor_value: z.string().optional().default(''),
  })
  .refine((r) => r.anchor_type === 'file' || (typeof r.anchor_value === 'string' && r.anchor_value.trim() !== ''), {
    message: 'anchor_value is required when anchor_type is section or lines',
  });

export function createAegisServer(service: AegisService, surface: Surface): McpServer {
  const server = new McpServer({
    name: `aegis-${surface}`,
    version: '0.1.0',
  });

  // ============================================================
  // Agent Surface Tools
  // ============================================================

  server.tool(
    'aegis_compile_context',
    'Compile deterministic context for target files. Returns base documents, resolution path, and templates. v2: delivery-aware with budget control.',
    {
      target_files: z.array(z.string()).describe('File paths being edited (required)'),
      target_layers: z
        .array(z.string())
        .optional()
        .describe('Explicit layer names (optional, inferred from path if omitted)'),
      command: z.string().optional().describe('Command name: scaffold, refactor, review, etc.'),
      plan: z.string().optional().describe('Natural-language plan text for expanded context (requires IntentTagger)'),
      intent_tags: z
        .array(z.string())
        .optional()
        .describe(
          'Explicit intent tags for expanded context. When set (including []), the SLM tagger is not used. ' +
            'Omit for SLM fallback from plan.',
        ),
      max_inline_bytes: z
        .number()
        .optional()
        .describe('Inline content budget in UTF-8 bytes (default: 131072 = 128KB)'),
      content_mode: z.enum(['auto', 'always', 'metadata']).optional().describe('Content delivery mode (default: auto)'),
    },
    async (params) => {
      try {
        const result = await service.compileContext(
          {
            target_files: params.target_files,
            target_layers: params.target_layers,
            command: params.command,
            plan: params.plan,
            intent_tags: params.intent_tags,
            max_inline_bytes: params.max_inline_bytes,
            content_mode: params.content_mode,
          },
          surface,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'BUDGET_EXCEEDED_MANDATORY',
                  compile_id: e.compile_id,
                  message: e.message,
                  mandatory_bytes: e.mandatory_bytes,
                  max_inline_bytes: e.max_inline_bytes,
                  offending_doc_ids: e.offending_doc_ids,
                }),
              },
            ],
            isError: true,
          };
        }
        throw e;
      }
    },
  );

  server.tool(
    'aegis_observe',
    'Record an observation event. Writes to Observation Layer only (never Canonical).',
    {
      event_type: z
        .enum([
          'compile_miss',
          'review_correction',
          'pr_merged',
          'manual_note',
          'document_import',
          'doc_gap_detected',
          'staleness_detected',
        ])
        .describe('Event type'),
      related_compile_id: z.string().optional().describe('Required for compile_miss'),
      related_snapshot_id: z.string().optional().describe('Required for compile_miss, optional for review_correction'),
      payload: z.record(z.string(), z.unknown()).describe('Event-specific payload (JSON object)'),
    },
    async (params) => {
      const event = {
        event_type: params.event_type,
        ...(params.related_compile_id && { related_compile_id: params.related_compile_id }),
        ...(params.related_snapshot_id && { related_snapshot_id: params.related_snapshot_id }),
        payload: params.payload,
      } as any;
      try {
        const result = service.observe(event, surface);
        return { content: buildObserveContent(result, params.event_type) };
      } catch (e) {
        if (e instanceof ObserveValidationError) {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
        throw e;
      }
    },
  );

  server.tool(
    'aegis_get_compile_audit',
    'Retrieve details of a past compile_context invocation.',
    {
      compile_id: z.string().describe('The compile_id from a previous compile_context call'),
    },
    async (params) => {
      const result = service.getCompileAudit(params.compile_id, surface);
      if (!result) {
        return {
          content: [{ type: 'text', text: `Compile log not found for compile_id: ${params.compile_id}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'aegis_get_known_tags',
    'List distinct intent tags from tag_mappings (approved-resolvable only) with knowledge_version and a SHA-256 tag_catalog_hash of the tag list for client-side caching.',
    {},
    async () => {
      const result = service.getKnownTags(surface);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ============================================================
  // init_detect — available on both surfaces (read-only preview)
  // ============================================================

  server.tool(
    'aegis_init_detect',
    'Analyze a project and generate an initialization preview. Does not modify Canonical.',
    {
      project_root: z.string().describe('Absolute path to the project root directory'),
      skip_template: z
        .boolean()
        .optional()
        .describe('Skip template detection and create an empty knowledge base. Use aegis_import_doc to add documents.'),
    },
    async (params) => {
      const preview = service.initDetect(params.project_root, surface, {
        skip_template: params.skip_template,
      });
      const { _placeholders, ...publicPreview } = preview;
      return { content: [{ type: 'text', text: JSON.stringify(publicPreview, null, 2) }] };
    },
  );

  // ============================================================
  // Admin Surface Tools — only registered when surface === 'admin'
  // ============================================================

  if (surface === 'admin') {
    server.tool(
      'aegis_list_proposals',
      'List proposals with optional status filter.',
      {
        status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional().describe('Filter by status'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      async (params) => {
        const result = service.listProposals(params, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_get_proposal',
      'Get full details of a proposal including evidence.',
      {
        proposal_id: z.string().describe('The proposal ID'),
      },
      async (params) => {
        const result = service.getProposal(params.proposal_id, surface);
        if (!result) {
          return { content: [{ type: 'text', text: `Proposal not found: ${params.proposal_id}` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_approve_proposal',
      'Approve a pending proposal, applying it to Canonical Knowledge.',
      {
        proposal_id: z.string().describe('The proposal ID to approve'),
        modifications: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional modifications to the proposal payload before approval'),
      },
      async (params) => {
        const result = service.approveProposal(params.proposal_id, params.modifications, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_preflight_proposal_bundle',
      'Dry-run all pending proposals sharing a bundle_id: validates ordering and mutations; rolls back (no Canonical change).',
      {
        bundle_id: z.string().describe('The bundle_id shared by pending proposals'),
      },
      async (params) => {
        const result = service.preflightProposalBundle(params.bundle_id, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_approve_proposal_bundle',
      'Approve every pending proposal in the bundle in one transaction (one knowledge_version / one snapshot). All-or-nothing.',
      {
        bundle_id: z.string().describe('The bundle_id shared by pending proposals'),
      },
      async (params) => {
        const result = service.approveProposalBundle(params.bundle_id, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_reject_proposal',
      'Reject a pending proposal with a reason.',
      {
        proposal_id: z.string().describe('The proposal ID to reject'),
        reason: z.string().describe('Reason for rejection'),
      },
      async (params) => {
        const result = service.rejectProposal(params.proposal_id, params.reason, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_init_confirm',
      'Confirm initialization using a preview hash from init_detect.',
      {
        preview_hash: z.string().describe('The preview_hash from a prior init_detect call'),
      },
      async (params) => {
        const result = service.initConfirm(params.preview_hash, surface);
        const hint =
          '\n\nNext: run `npx @fuwasegu/aegis deploy-adapters` in the terminal to generate IDE adapter rules (Cursor .mdc, CLAUDE.md, AGENTS.md).';
        return { content: [{ type: 'text', text: JSON.stringify(result) + hint }] };
      },
    );

    server.tool(
      'aegis_check_upgrade',
      'Check if a template upgrade is available for the initialized project.',
      {},
      async () => {
        const result = service.checkUpgrade(surface);
        if (!result) {
          return { content: [{ type: 'text', text: 'Project not initialized.' }], isError: true };
        }
        if ('not_found' in result) {
          const msg =
            result.template_id === 'none'
              ? 'This project was initialized without a template. Template upgrades are not applicable — use aegis_import_doc to manage documents directly.'
              : `Template '${result.template_id}' is no longer bundled. Bundled templates have been removed in favor of aegis_import_doc-based onboarding. Your existing documents are unaffected.`;
          return { content: [{ type: 'text', text: msg }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_apply_upgrade',
      'Generate proposals for template upgrade changes. Proposals must still be approved.',
      {},
      async () => {
        const result = service.applyUpgrade(surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_archive_observations',
      'Archive observations older than the specified number of days (default: 90).',
      {
        days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Archive observations older than this many days (default: 90)'),
      },
      async (params) => {
        const result = service.archiveObservations(params.days ?? 90, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_get_stats',
      'Aggregate knowledge counts, compile_log usage metrics, and health signals (stale file-anchored docs, unanalyzed observations, orphaned tag_mappings). Admin read-only.',
      {},
      async () => {
        const result = service.getStats(surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_import_doc',
      'Import an existing document into Canonical Knowledge. Creates a document_import observation and generates new_doc/add_edge proposals. Provide content directly or file_path to read from disk.',
      {
        content: z
          .string()
          .optional()
          .describe('Document content (Markdown body). Either content or file_path is required.'),
        file_path: z
          .string()
          .optional()
          .describe('Absolute path to a file to read as document content. Takes priority over content.'),
        doc_id: z.string().describe('Document ID (lowercase alphanumeric, hyphens, underscores)'),
        title: z.string().describe('Document title'),
        kind: z.enum(['guideline', 'pattern', 'constraint', 'template', 'reference']).describe('Document kind'),
        edge_hints: z
          .array(
            z.object({
              source_type: z.enum(['path', 'layer', 'command', 'doc']),
              source_value: z.string(),
              edge_type: z.enum(['path_requires', 'layer_requires', 'command_requires', 'doc_depends_on']),
              priority: z.number().int().optional(),
            }),
          )
          .optional()
          .describe('DAG edge hints for connecting the document'),
        tags: z.array(z.string()).optional().describe('Tags for tag_mappings (applied on approve)'),
        source_path: z
          .string()
          .optional()
          .describe('Original file path (provenance metadata). Auto-set from file_path if not provided.'),
        source_refs: z
          .array(sourceRefSchema)
          .optional()
          .describe(
            'ADR-015 §015-10: repo asset references for N:M mapping (stored as documents.source_refs_json on approve).',
          ),
      },
      async (params) => {
        try {
          const result = await service.importDoc(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Import failed: ${e.message}` }], isError: true };
        }
      },
    );

    server.tool(
      'aegis_analyze_doc',
      'ADR-015: deterministic import analysis (read-only). Returns ImportPlan with suggested_units, overlap_warnings, coverage_delta. Provide content or file_path.',
      {
        content: z.string().optional().describe('Markdown body (when not using file_path).'),
        file_path: z.string().optional().describe('Absolute path to a markdown file to analyze.'),
        source_label: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Optional provenance label only — never stored as Canonical source_path (use file_path if you need file anchoring).',
          ),
        source_refs: z
          .array(sourceRefSchema)
          .optional()
          .describe('Optional refs echoed on ImportPlan for execute_import_plan (015-10).'),
      },
      async (params) => {
        try {
          const result = service.analyzeDoc(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Analyze failed: ${e.message}` }], isError: true };
        }
      },
    );

    server.tool(
      'aegis_analyze_import_batch',
      'ADR-015: batch import analysis — one ImportPlan per item plus cross_doc_overlap between sources.',
      {
        items: z
          .array(
            z.object({
              content: z.string().optional(),
              file_path: z.string().optional(),
              source_label: z.string().nullable().optional(),
              source_refs: z.array(sourceRefSchema).optional(),
            }),
          )
          .describe('Non-empty list of documents to analyze (each needs content or file_path).'),
      },
      async (params) => {
        try {
          const result = service.analyzeImportBatch(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Batch analyze failed: ${e.message}` }], isError: true };
        }
      },
    );

    server.tool(
      'aegis_execute_import_plan',
      'ADR-015: create document_import-backed proposals sharing one bundle_id (use preflight/approve_proposal_bundle). Pass import_plan or batch_plan JSON from analyze_doc / analyze_import_batch. ' +
        'When resolved_source_path is set from file_path, source_path anchors are attached only if there is exactly one suggested unit whose slice matches the whole file after normalization — ' +
        'otherwise derived/split sections stay standalone; when anchored, stored document content is read from disk so sync_docs hashing matches.',
      {
        import_plan: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Single-document ImportPlan object (mutually exclusive with batch_plan).'),
        batch_plan: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('BatchImportPlan object from analyze_import_batch.'),
        bundle_id: z.string().optional().describe('Optional bundle id (UUID generated when omitted).'),
      },
      async (params) => {
        try {
          const result = service.executeImportPlan(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `execute_import_plan failed: ${e.message}` }], isError: true };
        }
      },
    );

    server.tool(
      'aegis_list_observations',
      'List observations with outcome-based filtering. Per ADR-008: helps admin triage skipped observations. Each row includes `payload` (parsed JSON) for full diagnostics (e.g. doc_gap_detected: scope_patterns, metrics, evidence ids, algorithm_version).',
      {
        event_type: z
          .enum([
            'compile_miss',
            'review_correction',
            'pr_merged',
            'manual_note',
            'document_import',
            'doc_gap_detected',
            'staleness_detected',
          ])
          .optional()
          .describe('Filter by event type'),
        outcome: z
          .enum(['proposed', 'skipped', 'pending'])
          .optional()
          .describe(
            'Filter by outcome: pending (not yet analyzed), proposed (generated proposals), skipped (analyzed but no proposals)',
          ),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      async (params) => {
        const result = service.listObservations(params, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_process_observations',
      'Process pending observations through the analyzer pipeline, generating proposals. Per ADR-003: admin-only explicit operation.',
      {
        event_type: z
          .enum([
            'compile_miss',
            'review_correction',
            'pr_merged',
            'manual_note',
            'document_import',
            'doc_gap_detected',
            'staleness_detected',
          ])
          .optional()
          .describe('Process only this event type (default: all types)'),
      },
      async (params) => {
        try {
          const result = await service.processObservations(params.event_type, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Processing failed: ${e.message}` }], isError: true };
        }
      },
    );

    server.tool(
      'aegis_sync_docs',
      'Synchronize file-anchored documents with their source files. Detects stale documents via content_hash and creates update_doc proposals. Returns skipped_invalid_anchor for unusable paths (missing, outside project, or resolve errors).',
      {
        doc_ids: z
          .array(z.string())
          .optional()
          .describe(
            'Subset of document IDs to sync. If omitted, syncs all approved documents with ownership=file-anchored.',
          ),
      },
      async (params) => {
        try {
          const result = await service.syncDocs({ doc_ids: params.doc_ids }, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: 'text', text: `Sync failed: ${e.message}` }], isError: true };
        }
      },
    );
  }

  // ============================================================
  // MCP Resources — Aegis usage guides (ADR-005 D-2)
  // ============================================================

  server.resource('aegis-workflow', 'aegis://guide/workflow', { mimeType: 'text/markdown' }, async () => ({
    contents: [
      {
        uri: 'aegis://guide/workflow',
        mimeType: 'text/markdown',
        text: WORKFLOW_GUIDE,
      },
    ],
  }));

  return server;
}
