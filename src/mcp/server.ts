/**
 * Aegis MCP Server
 * Tool registration only. All business logic delegated to AegisService.
 *
 * Surface separation (INV-6):
 * - Agent Surface: compile_context, observe, get_compile_audit, init_detect (4 tools)
 * - Admin Surface: agent tools + init_confirm,
 *                  list/get/approve/reject_proposals (10 tools total)
 * - propose is NOT exposed (internal only)
 *
 * init_detect is on both surfaces (read-only preview).
 * init_confirm is admin-only (mutates Canonical).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AegisService, SurfaceViolationError, ObserveValidationError, type Surface } from './services.js';

const WORKFLOW_GUIDE = `# Aegis Workflow Guide

## Core Workflow: Read → Write → Approve

1. **Read** — Before editing, call \`aegis_compile_context\` with your target files.
   Aegis returns relevant guidelines, patterns, constraints, and templates.

2. **Write** — After coding, report what happened via \`aegis_observe\`:
   - \`compile_miss\`: context didn't cover what was needed
   - \`review_correction\`: reviewer corrected an agent's output
   - \`pr_merged\`: PR merged with file changes
   - \`manual_note\`: freeform knowledge capture

3. **Approve** — Admin reviews proposals generated from observations:
   - \`aegis_list_proposals\` → \`aegis_get_proposal\` → \`aegis_approve_proposal\` / \`aegis_reject_proposal\`

## Admin Operations

- \`aegis_init_detect\` + \`aegis_init_confirm\`: Initialize a project
- \`aegis_import_doc\`: Import existing documents with explicit metadata
- \`aegis_process_observations\`: Run the analyzer pipeline on pending observations
- \`aegis_check_upgrade\` + \`aegis_apply_upgrade\`: Template version upgrades

## Key Principles

- **Observation → Proposal → Canonical**: No direct writes to Canonical Knowledge
- **Agent surface is read-only**: Agents can read context and record observations, but cannot approve
- **Deterministic context**: Same inputs always produce the same compiled context
`;

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
    'Compile deterministic context for target files. Returns base documents, resolution path, and templates.',
    {
      target_files: z.array(z.string()).describe('File paths being edited (required)'),
      target_layers: z.array(z.string()).optional().describe('Explicit layer names (optional, inferred from path if omitted)'),
      command: z.string().optional().describe('Command name: scaffold, refactor, review, etc.'),
      plan: z.string().optional().describe('Natural-language plan text for expanded context (requires IntentTagger)'),
    },
    async (params) => {
      const result = await service.compileContext({
        target_files: params.target_files,
        target_layers: params.target_layers,
        command: params.command,
        plan: params.plan,
      }, surface);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'aegis_observe',
    'Record an observation event. Writes to Observation Layer only (never Canonical).',
    {
      event_type: z.enum(['compile_miss', 'review_correction', 'pr_merged', 'manual_note', 'document_import']).describe('Event type'),
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
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
        return { content: [{ type: 'text', text: `Compile log not found for compile_id: ${params.compile_id}` }], isError: true };
      }
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
    },
    async (params) => {
      const preview = service.initDetect(params.project_root, surface);
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
        modifications: z.record(z.string(), z.unknown()).optional().describe('Optional modifications to the proposal payload before approval'),
      },
      async (params) => {
        const result = service.approveProposal(params.proposal_id, params.modifications, surface);
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
        const hint = '\n\nNext: run `npx @fuwasegu/aegis deploy-adapters` in the terminal to generate IDE adapter rules (Cursor .mdc, CLAUDE.md, AGENTS.md).';
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
          return { content: [{ type: 'text', text: 'Project not initialized or template not found.' }], isError: true };
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
        days: z.number().int().min(1).optional().describe('Archive observations older than this many days (default: 90)'),
      },
      async (params) => {
        const result = service.archiveObservations(params.days ?? 90, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_import_doc',
      'Import an existing document into Canonical Knowledge. Creates a document_import observation and generates new_doc/add_edge proposals. Content and metadata must be provided by the caller.',
      {
        content: z.string().describe('Document content (Markdown body)'),
        doc_id: z.string().describe('Document ID (lowercase alphanumeric, hyphens, underscores)'),
        title: z.string().describe('Document title'),
        kind: z.enum(['guideline', 'pattern', 'constraint', 'template', 'reference']).describe('Document kind'),
        edge_hints: z.array(z.object({
          source_type: z.enum(['path', 'layer', 'command', 'doc']),
          source_value: z.string(),
          edge_type: z.enum(['path_requires', 'layer_requires', 'command_requires', 'doc_depends_on']),
          priority: z.number().int().optional(),
        })).optional().describe('DAG edge hints for connecting the document'),
        tags: z.array(z.string()).optional().describe('Tags for tag_mappings (applied on approve)'),
        source_path: z.string().optional().describe('Original file path (provenance metadata)'),
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
      'aegis_process_observations',
      'Process pending observations through the analyzer pipeline, generating proposals. Per ADR-003: admin-only explicit operation.',
      {
        event_type: z.enum(['compile_miss', 'review_correction', 'pr_merged', 'manual_note', 'document_import']).optional().describe('Process only this event type (default: all types)'),
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

  }

  // ============================================================
  // MCP Resources — Aegis usage guides (ADR-005 D-2)
  // ============================================================

  server.resource(
    'aegis-workflow',
    'aegis://guide/workflow',
    { mimeType: 'text/markdown' },
    async () => ({
      contents: [{
        uri: 'aegis://guide/workflow',
        mimeType: 'text/markdown',
        text: WORKFLOW_GUIDE,
      }],
    }),
  );

  return server;
}
