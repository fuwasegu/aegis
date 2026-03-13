# Aegis — DAG-based Deterministic Context Compiler

## Architecture

Aegis is an MCP server that compiles deterministic context for AI coding agents.
Instead of RAG (retrieval-augmented generation), it uses a DAG (directed acyclic graph)
of edges to resolve exactly which documents an agent needs for a given set of target files.

## Running

```bash
npm run build          # compile TypeScript
npm run start:agent    # start agent surface (default: ./aegis.db)
npm run start:admin    # start admin surface
npm test               # run all tests
```

## Agent Surface Tools (4 tools)

- `aegis_compile_context` — Primary tool. Given target_files, returns deterministic context.
- `aegis_observe` — Record observations (compile_miss, review_correction, pr_merged, manual_note).
- `aegis_get_compile_audit` — Retrieve audit log of a past compile invocation.
- `aegis_init_detect` — Analyze a project to generate initialization preview (read-only).

## Admin Surface Tools (9 additional tools, includes all agent tools)

- `aegis_init_confirm` — Confirm initialization using preview_hash from init_detect.
- `aegis_list_proposals` / `aegis_get_proposal` — Review pending proposals.
- `aegis_approve_proposal` / `aegis_reject_proposal` — Approve or reject with optional modifications.
- `aegis_check_upgrade` — Check for template version upgrades.
- `aegis_apply_upgrade` — Generate proposals for template upgrade changes.
- `aegis_archive_observations` — Archive old observations.

## Key Invariants

- **INV-6**: Agent surface cannot modify Canonical Knowledge. Admin tools are not registered on agent surface.
- **P-1**: All context compilation is deterministic. Same input + same knowledge_version = same output.
- **P-3**: All Canonical mutations require human approval (Observation → Proposed → Canonical).

## Tag Mappings Layer (Outside Canonical DAG)

- **Storage**: `tag_mappings` table — separate from Canonical Knowledge, no approval workflow
- **CRUD**: Direct repository methods (`upsertTagMapping`, `setTagMappings`, `getDocumentsByTags`, etc.)
- **Approved filter**: `getDocumentsByTags` JOIN-filters on `documents.status = 'approved'`
- **Source**: `slm` (small language model) or `manual` (human-curated)
- **IntentTagger port**: `extractTags(plan) → IntentTag[]` (async, FakeTagger for tests, OllamaIntentTagger for production)
- **Wired to ContextCompiler**: `plan` + tagger → expanded context via tag_mappings lookup

## Project Structure

```
src/
  core/
    store/      — SQLite repository, schema, database
    read/       — ContextCompiler (deterministic DAG routing)
    init/       — Stack detection, template loading, bootstrap, upgrade
    automation/ — ObservationAnalyzer port, RuleBasedAnalyzer, ReviewCorrectionAnalyzer,
                  PrMergedAnalyzer, ManualNoteAnalyzer, ProposeService
    tagging/    — IntentTagger port (tag extraction interface)
    types.ts    — All TypeScript type definitions
  mcp/
    server.ts   — MCP tool registration (surface-conditional)
    services.ts — Service facade (INV-6 enforcement)
  adapters/
    cursor/     — .cursor/rules/ rule generation
    Codex/     — AGENTS.md section injection
    types.ts    — Adapter shared types
  expansion/
    ollama-client.ts — Ollama REST API client
    intent-tagger.ts — OllamaIntentTagger (IntentTagger implementation)
  e2e/          — End-to-end integration tests
  main.ts       — Entry point (--surface, --db, --templates, --ollama-*)
templates/      — Init templates (laravel-ddd, generic-layered, typescript-mcp)
```

## Design Decisions

- Agent surface registers 4 tools (compile_context, observe, get_compile_audit, init_detect)
- Admin surface registers 13 tools (agent 4 + admin 9)
- init_detect is on both surfaces (read-only). init_confirm is admin-only (mutates Canonical)
- init_confirm must run in the admin process (previewCache is in-memory)
- After init_confirm, adapters are auto-deployed (.cursor/rules/, AGENTS.md) — non-fatal if deployment fails
- SQLite + recursive CTE for DAG traversal (no graph DB needed)
- content_hash is always server-computed (never trust client-provided hashes)
- observe events are validated per event_type at service boundary
- Automation: `compile_miss` → `add_edge` (RuleBasedAnalyzer), `review_correction` → `update_doc` (ReviewCorrectionAnalyzer)
- `review_correction` requires both `target_doc_id` + `proposed_content` for automation (otherwise skipped)
- `pr_merged` → `add_edge` for uncovered paths (PrMergedAnalyzer)
- `manual_note` → `update_doc` or `new_doc` depending on hints (ManualNoteAnalyzer)
- Ollama integration for SLM-powered intent tagging with graceful degradation
- Template upgrade detection and proposal generation via `check_upgrade` / `apply_upgrade`
- **Bootstrap proposal has no evidence**: `proposal_type='bootstrap'` is the sole exception to P-3's "1+ Observation per Proposal" rule. Bootstrap proposals are created by the init engine, not derived from observations. This is an intentional design decision — init is a controlled bootstrapping process, not an observation-driven workflow.

<!-- aegis:start -->
## Aegis Process Enforcement

You MUST follow this process for every coding task. No exceptions.

### Before Writing Code

1. **Create a Plan** — Before touching any file, articulate what you intend to do.
2. **Consult Aegis** — Call `aegis_compile_context` with:
   - `target_files`: the files you plan to edit
   - `plan`: your natural-language plan (optional but recommended)
   - `command`: the type of operation (scaffold, refactor, review, etc.)
3. **Read and follow** the returned architecture guidelines.

### After Writing Code

4. **Self-Review** — Check your implementation against the returned guidelines.
5. **Report Compile Misses** — If Aegis failed to provide a needed guideline:
   ```
   aegis_observe({
     event_type: "compile_miss",
     related_compile_id: "<from step 2>",
     related_snapshot_id: "<from step 2>",
     payload: {
       target_files: ["<files>"],
       review_comment: "<what was missing>"
     }
   })
   ```

### Rules

- NEVER skip the Aegis consultation step.
- NEVER ignore guidelines returned by Aegis.
- The compile_id and snapshot_id from step 2 are required for observation reporting.
<!-- aegis:end -->
