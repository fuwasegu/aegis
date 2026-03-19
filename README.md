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
| **agent** | Read-only tools for AI coding agents | 4 tools (compile, observe, audit, detect) |
| **admin** | Initialization, approval, triage | 16 tools (4 shared + 12 admin-only) |

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

The agent surface provides tools for your AI coding agent:

```
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "Add a new query method for archived observations"
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

### MCP Tools — Agent Surface (4 tools)

| Tool | Description |
|------|-------------|
| `aegis_compile_context` | Compile deterministic context for target files |
| `aegis_observe` | Record observations (compile_miss, review_correction, pr_merged, manual_note, document_import) |
| `aegis_get_compile_audit` | Retrieve audit log of a past compile |
| `aegis_init_detect` | Analyze a project to generate initialization preview |

### MCP Tools — Admin Surface (additional 12 tools, 16 total)

| Tool | Description |
|------|-------------|
| `aegis_init_confirm` | Confirm initialization using preview hash |
| `aegis_list_proposals` | List proposals with optional status filter |
| `aegis_get_proposal` | Get full proposal details with evidence |
| `aegis_approve_proposal` | Approve a pending proposal |
| `aegis_reject_proposal` | Reject a pending proposal with reason |
| `aegis_check_upgrade` | Check for template version upgrades |
| `aegis_apply_upgrade` | Generate proposals for template upgrades |
| `aegis_archive_observations` | Archive old observations |
| `aegis_list_observations` | List observations with outcome-based filtering (proposed / skipped / pending) |
| `aegis_import_doc` | Import a document into Canonical Knowledge (from `content` or `file_path`) |
| `aegis_process_observations` | Trigger observation analysis pipeline for pending observations |
| `aegis_sync_docs` | Synchronize imported documents with their source files |

### CLI Subcommands

| Subcommand | Description |
|------------|-------------|
| `deploy-adapters` | Deploy IDE adapter configurations (Cursor rules, CLAUDE.md, AGENTS.md) and Agent Skills |

```bash
npx @fuwasegu/aegis deploy-adapters                         # Deploy all adapters
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # Deploy specific adapters
npx @fuwasegu/aegis deploy-adapters --project-root /path    # Specify project root
npx @fuwasegu/aegis deploy-adapters --db /path/to/aegis.db  # Use custom DB path
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
| `--ollama-url` | `http://localhost:11434` | Ollama API URL (with `--ollama`) |

---

## Development

### Building

```bash
npm run build    # Compile TypeScript
npm test         # Run all tests (335+)
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
