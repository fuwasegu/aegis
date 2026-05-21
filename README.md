<div align="center">
  <img src="docs/assets/logo.png#gh-light-mode-only" alt="Aegis" width="500" />
  <img src="docs/assets/logo-dark.png#gh-dark-mode-only" alt="Aegis" width="500" />
</div>

# Aegis

**DAG-based Deterministic Context Compiler for AI Coding Agents**

[日本語版 README](README.ja.md) | [Technical Guide](docs/technical-guide.md)

Aegis is an MCP server that enforces architecture guidelines on AI coding agents. Instead of RAG, it uses a DAG of dependency edges to deterministically compile exactly which documents an agent needs for a given set of target files. No search. No ranking. Deterministic.

## Quick Start

1. Add Aegis to your IDE's MCP config (see [Installation](#installation))
2. Ask your AI agent: *"Initialize Aegis for this project and deploy the adapter rules."*
3. The agent runs `aegis_init_detect` → `aegis_init_confirm` → `npx @fuwasegu/aegis deploy-adapters` automatically

The database is stored at `.aegis/aegis.db` in the project root. The `.aegis/` directory includes its own `.gitignore` — no manual configuration needed.

## Installation

Aegis uses two MCP surfaces — both are required:

| Surface | Role | Tools |
|---------|------|-------|
| **agent** | Context compilation, observation recording, and related reads — no Canonical mutations | 6 tools (compile, observe, audit, known_tags, workspace_status, detect) |
| **admin** | Initialization, approval, triage | 24 tools (6 shared + 18 admin-only) |

> The agent surface alone cannot initialize a project or approve proposals. This separation ensures AI agents cannot modify architecture rules without human approval. ([INV-6](docs/technical-guide.md))

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

After initialization, `deploy-adapters` generates `.cursor/rules/aegis-process.mdc` — a Cursor rule that instructs the agent to consult Aegis before writing code and report violations afterward.

### Claude Code

```bash
claude mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
claude mcp add aegis-admin -- npx -y @fuwasegu/aegis --surface admin
```

<details>
<summary>Or add to <code>.mcp.json</code> manually</summary>

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

</details>

After initialization, `deploy-adapters` appends an `<!-- aegis:start -->` section to `CLAUDE.md` (creates it if missing).

### Codex

```bash
codex mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
codex mcp add aegis-admin -- npx -y @fuwasegu/aegis --surface admin
```

<details>
<summary>Or add to <code>.mcp.json</code> manually</summary>

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

</details>

After initialization, `deploy-adapters` appends an `<!-- aegis:start -->` section to `AGENTS.md` (creates it if missing).

> **Note:** Codex MCP support depends on the CLI version. If MCP is not available, agents can still follow Aegis guidelines via the generated `AGENTS.md` instructions.

## Usage

### 1. Initialize your project

Using the admin surface, initialize Aegis with an empty knowledge base:

```
aegis_init_detect({ project_root: "/path/to/your/project", skip_template: true })
aegis_init_confirm({ preview_hash: "<hash from detect>" })
```

This creates an empty knowledge base. You'll populate it with architecture documents in the next step.

Then deploy adapter rules and Agent Skills for your AI coding tool via CLI:

```bash
npx @fuwasegu/aegis deploy-adapters
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # specific adapters only
```

### 2. Use during development

The agent surface provides tools for your AI coding agent. Recommended flow for **expanded** context (tag-driven documents): call `aegis_get_known_tags` once per session (cache `tag_catalog_hash`), then pass `intent_tags` into compile:

```
aegis_get_known_tags({})
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "Add a new query method for archived observations",
  intent_tags: ["<tags from known_tags>"]
})
```

Omit `intent_tags` only if you want the optional server-side SLM tagger (when `--slm` is enabled) to infer tags from `plan` instead ([ADR-004](docs/adr/004-slm-role-and-strategy.md)). Pass `intent_tags: []` to skip expanded context without SLM.

Base DAG only (skip expanded context; works the same with or without `--slm` because `intent_tags: []` disables expanded and skips SLM tagging):

```
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "Add a new query method for archived observations",
  intent_tags: []
})
```

Returns architecture guidelines, patterns, and constraints relevant to the files being edited.

### 3. Add architecture documents

After initialization, populate the knowledge base by analyzing your codebase. Use `aegis_import_doc` on the **admin** surface to add architecture documents with `edge_hints` that connect them to file paths:

```
aegis_import_doc({
  file_path: "/absolute/path/to/docs/architecture-guide.md",
  doc_id: "architecture-guide",
  title: "Architecture Guide",
  kind: "guideline",
  tags: ["architecture"],
  edge_hints: [
    { source_type: "path", source_value: "src/domain/**", edge_type: "path_requires" }
  ]
})
```

Using `file_path` reads content directly from disk, avoiding truncation by LLM context windows. Each import returns `proposal_ids` — approve them to activate the documents.

To keep imported documents in sync with source files:

```
aegis_sync_docs()   # detects changes via content hash, creates update_doc proposals
```

Both `aegis_import_doc` and `aegis_sync_docs` require the **admin** surface. For a detailed step-by-step bulk import workflow, see the `aegis-bulk-import` skill (deployed via `deploy-adapters`).

### 4. Report observations

When the agent notices a missing guideline or a correction:

```
aegis_observe({
  event_type: "compile_miss",
  related_compile_id: "<from compile_context>",
  related_snapshot_id: "<from compile_context>",
  payload: { target_files: ["..."], review_comment: "Missing error handling guideline" }
})
```

### 5. Review proposals

Observations are analyzed into proposals. Review and approve via admin surface:

```
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## Project Sharing (Team Workflow)

Aegis supports sharing approved Canonical Knowledge across team members via Git-committed bundle artifacts. This eliminates the need for each developer to build the knowledge base from scratch.

### How it works

| Directory | Purpose | Git-tracked? |
|-----------|---------|:------------:|
| `.aegis/` | Local runtime database (observations, proposals, compile log) | No |
| `aegis-share/` | Shared snapshot of approved Canonical Knowledge | **Yes** |

### Authoring workspace (knowledge maintainer)

After approving proposals, export the current Canonical state:

```bash
npx @fuwasegu/aegis share-export                # writes aegis-share/manifest.json + canonical.json
npx @fuwasegu/aegis share-export --out /path    # custom output directory
```

Then commit and push `aegis-share/`.

### Replica workspace (team members)

After pulling changes that include an updated `aegis-share/`:

```bash
npx @fuwasegu/aegis share-hydrate               # rebuild .aegis/aegis.db from aegis-share/
npx @fuwasegu/aegis share-hydrate --replace     # overwrite existing initialized DB
npx @fuwasegu/aegis share-hydrate --bundle-dir /path  # custom bundle directory
```

> **Warning:** `share-hydrate` performs a whole-DB replacement. Local operational state (observations, proposals, compile log) is **not preserved**. This is by design — replica workspaces are consumers of shared knowledge, not authors.

### Share status monitoring

Aegis automatically detects drift between your local DB and the shared bundle:

- **`npx @fuwasegu/aegis doctor`** — shows share state (`in_sync`, `bundle_newer`, `local_ahead`, `diverged`, `unreadable_bundle`); exits 1 for actionable states
- **`npx @fuwasegu/aegis stats`** — includes `project_share` in JSON output with full status details
- **`aegis_compile_context` notices** — agents receive actionable hints (e.g. "Run `share-hydrate` to update") when the bundle is out of sync

The `not_configured` state (no `aegis-share/` directory) is silent — no noise until sharing is set up.

### Typical team workflow

```
                    Authoring Workspace                    Replica Workspace
                    ───────────────────                    ─────────────────
  approve proposals ──► share-export ──► git push ──► git pull ──► share-hydrate
                                  aegis-share/ committed
```

1. **Author** works on the knowledge base (import docs, approve proposals, sync)
2. **Author** runs `share-export` and commits `aegis-share/`
3. **Team** runs `git pull` then `share-hydrate --replace`
4. `compile_context` on the replica now returns the same guidelines as the author

## Collaborative Authoring (Source-Native)

In addition to the DB-native workflow above (observe → propose → approve), Aegis supports a **source-native** collaborative authoring mode. Team members edit human-readable source files in `aegis-share/source/`, review changes via pull requests, and materialize them into the database.

> **Key rule:** `compile_context` always reads from the database, not from source files directly. Source files are the authoring format; the DB is the runtime format.

### Two approval lanes

| Lane | Entry point | Approval mechanism | Best for |
|------|------------|-------------------|----------|
| **DB-native** | Agent observes gap → `aegis_observe` → `aegis_approve_proposal` | Human approves proposal in admin surface | Reactive knowledge improvement driven by agent observations |
| **Source-native** | Human edits `aegis-share/source/` → PR → merge → `share-materialize` | PR merge = approval | Proactive collaborative editing with Git-based code review |

Both lanes coexist. Use whichever fits the situation — or both.

### Directory layout

```
aegis-share/
├── manifest.json              # Distribution bundle manifest (ADR-017)
├── canonical.json             # Distribution bundle data (ADR-017)
└── source/                    # Collaborative authoring source (ADR-018)
    ├── documents/
    │   └── <doc_id>.md        # Frontmatter + Markdown body
    ├── edges/
    │   ├── path-requires.json
    │   ├── layer-requires.json
    │   ├── command-requires.json
    │   └── doc-depends-on.json
    ├── layer-rules.json
    └── tag-mappings.json
```

### Source-native workflow

```bash
# 1. Bootstrap: export current DB to source format (one-time setup)
npx @fuwasegu/aegis share-source-export

# 2. Edit source files (documents, edges, rules, mappings)
#    Create a branch, make changes, open a PR

# 3. Validate before committing
npx @fuwasegu/aegis share-format                 # Normalize formatting (deterministic, in-place)
npx @fuwasegu/aegis share-lint                   # Check for errors (after formatting)

# 4. After PR merge: apply source to DB
npx @fuwasegu/aegis share-materialize            # Applies changes + auto-approves
npx @fuwasegu/aegis share-materialize --dry-run  # Preview changes without applying

# 5. Export updated bundle for replicas
npx @fuwasegu/aegis share-export
```

### CI integration

Add `share-lint` to your CI pipeline to catch errors before merge:

```bash
npx @fuwasegu/aegis share-lint  # exits 1 on errors — suitable for CI checks
```

### Phase 1 limitations

- Local overlays are not supported — all changes go through the shared source
- `share-materialize` is a full apply (not incremental patch)

## SLM for Expanded Context — Opt-in

Aegis includes a built-in llama.cpp engine for optional SLM-based intent tagging. SLM is **disabled by default** — the deterministic DAG-based context works perfectly without it.

To enable, add `--slm` to the **agent** surface:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent", "--slm", "--model", "qwen3.5-4b"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

On first SLM-enabled startup, the selected model is downloaded to `~/.aegis/models/` (shared across all projects).

| Model | Size | Description |
|-------|------|-------------|
| `qwen3.5-4b` | ~2.5 GB | Recommended default — fast and lightweight |
| `qwen3.5-9b` | ~5.5 GB | Higher quality — benchmark-topping |

You can also pass a HuggingFace URI directly: `--model hf:user/repo:file.gguf`

> **Legacy:** `--ollama` flag is available for Ollama-based inference if preferred. Using `--ollama` implicitly enables SLM.

## Reference

### MCP Tools — Agent Surface (6 tools)

| Tool | Description |
|------|-------------|
| `aegis_compile_context` | Compile deterministic context for target files. Supports `content_mode` (auto/always/metadata) and `max_inline_bytes` for output size control |
| `aegis_observe` | Record observations (compile_miss, review_correction, pr_merged, manual_note, document_import, doc_gap_detected) |
| `aegis_get_compile_audit` | Retrieve audit log of a past compile |
| `aegis_get_known_tags` | Distinct intent tags from tag_mappings (approved-linked) with `knowledge_version` and SHA-256 `tag_catalog_hash` for caching |
| `aegis_workspace_status` | Read-only workspace snapshot: recent compile regions, unresolved compile_miss backlog, pending proposal count, reconcile backlog (hash-sync/anchor-sync/semantic-review) |
| `aegis_init_detect` | Analyze a project to generate initialization preview |

### MCP Tools — Admin Surface (additional 18 tools, 24 total)

| Tool | Description |
|------|-------------|
| `aegis_init_confirm` | Confirm initialization using preview hash |
| `aegis_list_proposals` | List proposals with optional status filter |
| `aegis_get_proposal` | Get full proposal details with evidence |
| `aegis_approve_proposal` | Approve a pending proposal |
| `aegis_preflight_proposal_bundle` | Dry-run pending proposals sharing a `bundle_id` |
| `aegis_approve_proposal_bundle` | Approve all pending proposals in a bundle (atomic) |
| `aegis_reject_proposal` | Reject a pending proposal with reason |
| `aegis_check_upgrade` | Check for template version upgrades |
| `aegis_apply_upgrade` | Generate proposals for template upgrades |
| `aegis_archive_observations` | Archive old observations |
| `aegis_get_stats` | Aggregate knowledge counts and health signals |
| `aegis_list_observations` | List observations with outcome-based filtering (proposed / skipped / pending) |
| `aegis_import_doc` | Import a document into Canonical Knowledge (from `content` or `file_path`). Returns advisory warnings for large content, multiple sections, or semantic-review reconcile mode |
| `aegis_analyze_doc` | ADR-015: analyze content or `file_path` into an ImportPlan (read-only) |
| `aegis_analyze_import_batch` | ADR-015: batch import analysis with cross-doc overlap |
| `aegis_execute_import_plan` | ADR-015: create `document_import` proposals sharing a `bundle_id` |
| `aegis_process_observations` | Trigger observation analysis pipeline for pending observations |
| `aegis_sync_docs` | Synchronize file-anchored documents with their source files (reconcile-mode-aware: hash-sync, anchor-sync, semantic-review) |

### CLI Subcommands

| Subcommand | Description |
|------------|-------------|
| `deploy-adapters` | Deploy IDE adapter configurations (Cursor rules, CLAUDE.md, AGENTS.md) and Agent Skills |
| `maintenance` | Run observation processing, doc sync, archive, and upgrade check |
| `stats` | JSON output of knowledge counts, usage, health, and project share status |
| `doctor` | Human-readable health check (exits 1 if issues found) |
| `share-export` | Export approved Canonical Knowledge to `aegis-share/` |
| `share-hydrate` | Rebuild local DB from shared bundle (whole-DB replacement) |
| `share-source-export` | Bootstrap: export DB to human-editable `aegis-share/source/` |
| `share-lint` | Validate `aegis-share/source/` (parse errors, dangling references) |
| `share-format` | Deterministic normalization of `aegis-share/source/` (in-place) |
| `share-materialize` | Apply `aegis-share/source/` into DB (source-native approval) |

```bash
npx @fuwasegu/aegis deploy-adapters                         # Deploy all adapters
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # Deploy specific adapters
npx @fuwasegu/aegis deploy-adapters --project-root /path    # Specify project root
npx @fuwasegu/aegis deploy-adapters --db /path/to/aegis.db  # Use custom DB path
npx @fuwasegu/aegis maintenance                             # Process observations, sync, archive
npx @fuwasegu/aegis maintenance --dry-run                   # Report only (no writes)
npx @fuwasegu/aegis stats                                   # JSON health and usage data
npx @fuwasegu/aegis doctor                                  # Health check summary
npx @fuwasegu/aegis share-export                            # Export to aegis-share/
npx @fuwasegu/aegis share-hydrate --replace                 # Rebuild DB from bundle
npx @fuwasegu/aegis share-source-export                     # Export DB to aegis-share/source/
npx @fuwasegu/aegis share-lint                              # Validate shared source
npx @fuwasegu/aegis share-format                            # Normalize shared source
npx @fuwasegu/aegis share-materialize                       # Apply source to DB
npx @fuwasegu/aegis share-materialize --dry-run             # Preview changes
npx @fuwasegu/aegis --list-models                           # List available SLM models
```

> **Note**: Version tracking is only updated on full deployments (without `--targets`). Partial deployments will not update the version record, so the "adapter templates may be outdated" notice will persist until a full deployment is run.

### CLI Flags (MCP server mode)

| Flag | Default | Description |
|------|---------|-------------|
| `--surface` | `agent` | `agent` or `admin` |
| `--db` | `.aegis/aegis.db` | SQLite database path |
| `--templates` | `./templates` | Bundled templates directory |
| `--template-dir` | | Additional template search path (local overrides bundled) |
| `--slm` | false | Enable SLM for expanded context (Intent Tagging) |
| `--model` | `qwen3.5-4b` | SLM model name or HuggingFace URI (requires `--slm`) |
| `--list-models` | | Show available models and exit |
| `--ollama` | false | Use Ollama instead of built-in llama.cpp (implies `--slm`) |
| `--project-root` | `cwd()` | Project root for repo-relative source_path resolution and default DB path |
| `--ollama-url` | `http://localhost:11434` | Ollama API URL (with `--ollama`) |

---

## Development

### Building

```bash
npm run build    # Compile TypeScript
npm test         # Run all tests (406+)
npm run test:watch
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/fuwasegu/aegis.git
cd aegis
npm install && npm run build
```

</details>

### Architecture

```
┌─ MCP Layer (src/mcp/) ──────────────────┐
│ Tool registration, surface separation   │
└──────────────┬──────────────────────────┘
               │
┌─ Core Layer (src/core/) ────────────────┐
│ ContextCompiler, Repository, Init,      │
│ Automation (Analyzers), Tagging         │
└──────────────┬──────────────────────────┘
               │
┌─ Adapters (src/adapters/) ──────────────┐
│ Cursor, Claude rule generation          │
└──────────────┬──────────────────────────┘
               │
┌─ Expansion (src/expansion/) ────────────┐
│ llama.cpp engine, IntentTagger          │
└─────────────────────────────────────────┘
```

Dependencies flow downward. Core never imports from MCP, Adapters, or Expansion.

### Key Concepts

- **Canonical Knowledge**: Approved architecture documents + DAG edges
- **Observation Layer**: Agent-reported events (compile misses, corrections, PR merges)
- **Proposed Layer**: Automated proposals requiring human approval
- **Snapshots**: Immutable, content-addressable versions of Canonical Knowledge

## License

ISC
