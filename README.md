# Aegis

**DAG-based Deterministic Context Compiler for AI Coding Agents**

[日本語版 README](README.ja.md)

Aegis is an MCP server that enforces architecture guidelines on AI coding agents. Instead of RAG, it uses a DAG of dependency edges to deterministically compile exactly which documents an agent needs for a given set of target files. No search. No ranking. Deterministic.

## Installation

### via npx (recommended)

No cloning or building needed. Just add Aegis to your MCP config:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    }
  }
}
```

The database is stored at `.aegis/aegis.db` in the project root. The `.aegis/` directory includes its own `.gitignore` — no manual configuration needed.

### From source

```bash
git clone https://github.com/yourname/aegis.git
cd aegis
npm install && npm run build
```

### Add to Cursor

Add to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    }
  }
}
```

After running `aegis_init_confirm`, Aegis automatically generates `.cursor/rules/aegis-process.mdc` — a Cursor rule that instructs the agent to consult Aegis before writing code and report violations afterward. No manual rule writing needed.

### Add to Claude Code

```bash
claude mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    }
  }
}
```

After running `aegis_init_confirm`, Aegis automatically appends an `<!-- aegis:start -->` section to your `CLAUDE.md` that instructs Claude Code to follow the Aegis workflow. If `CLAUDE.md` doesn't exist, it creates one.

### Add to Codex

OpenAI Codex CLI reads instructions from `AGENTS.md`. After `aegis_init_confirm`, you can manually add the Aegis workflow to your `AGENTS.md`:

```markdown
## Aegis Process Enforcement

Before writing code:
1. Create a plan describing what you intend to do.
2. Call `aegis_compile_context` with target_files and your plan.
3. Read and follow the returned architecture guidelines.

After writing code:
4. Self-review against the returned guidelines.
5. Report compile misses via `aegis_observe` if guidelines were missing.
```

If Codex supports MCP, configure it the same way:

```bash
codex mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
```

> **Note:** Codex MCP support depends on the CLI version. If MCP is not available, agents can still follow Aegis guidelines via `AGENTS.md` instructions, though without direct tool access.

### Admin Surface (for initialization & approval)

For operations that modify Canonical Knowledge (init, approve/reject proposals), add a separate admin instance:

```json
{
  "mcpServers": {
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

> **Surface separation (INV-6):** The agent surface provides 4 read-only tools. The admin surface provides all 13 tools including Canonical-mutating operations. AI agents cannot modify architecture rules without human approval.

### SLM for Expanded Context (Intent Tagging)

Aegis includes a built-in llama.cpp engine for SLM inference. On first startup, it automatically downloads a small model (~1 GB) to `~/.aegis/models/` (shared across all projects).

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent", "--model", "qwen3.5-4b"]
    }
  }
}
```

Available models (`--list-models` to see all):

| Name | Size | Description |
|------|------|-------------|
| `qwen3.5-4b` | ~2.5 GB | Recommended default — fast and lightweight |
| `qwen3.5-9b` | ~5.5 GB | Higher quality — benchmark-topping |

You can also pass a HuggingFace URI directly: `--model hf:user/repo:file.gguf`

To disable SLM: add `"--no-slm"` to args. Base context (deterministic DAG) always works without SLM.

> **Legacy:** `--ollama` flag is available for Ollama-based inference if preferred.

## Usage

### 1. Initialize your project

Using the admin surface, detect your project's architecture and bootstrap Canonical Knowledge:

```
aegis_init_detect({ project_root: "/path/to/your/project" })
aegis_init_confirm({ preview_hash: "<hash from detect>" })
```

This creates seed documents, DAG edges, and layer rules based on your project structure. It also generates `.cursor/rules/aegis-process.mdc` and a CLAUDE.md section to enforce the Aegis workflow.

### 2. Use during development

The agent surface provides tools for your AI coding agent:

```
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "Add a new query method for archived observations"
})
```

Returns architecture guidelines, patterns, and constraints relevant to the files being edited.

### 3. Report observations

When the agent notices a missing guideline or a correction:

```
aegis_observe({
  event_type: "compile_miss",
  related_compile_id: "<from compile_context>",
  related_snapshot_id: "<from compile_context>",
  payload: { target_files: ["..."], review_comment: "Missing error handling guideline" }
})
```

### 4. Review proposals

Observations are analyzed into proposals. Review and approve via admin surface:

```
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## MCP Tools Reference

### Agent Surface (4 tools)

| Tool | Description |
|------|-------------|
| `aegis_compile_context` | Compile deterministic context for target files |
| `aegis_observe` | Record observations (compile_miss, review_correction, pr_merged, manual_note) |
| `aegis_get_compile_audit` | Retrieve audit log of a past compile |
| `aegis_init_detect` | Analyze a project to generate initialization preview |

### Admin Surface (additional 10 tools)

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
| `aegis_import_doc` | Import existing Markdown file as a new_doc proposal |

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--surface` | `agent` | `agent` or `admin` |
| `--db` | `.aegis/aegis.db` | SQLite database path |
| `--templates` | `./templates` | Templates directory |
| `--model` | `qwen3.5-4b` | SLM model name or HuggingFace URI |
| `--no-slm` | false | Disable SLM (no expanded context) |
| `--list-models` | | Show available models and exit |
| `--ollama` | false | Use Ollama instead of built-in llama.cpp |
| `--ollama-url` | `http://localhost:11434` | Ollama API URL (with `--ollama`) |

## Templates

Aegis ships with pre-built architecture templates:

| Template | Detection | Description |
|----------|-----------|-------------|
| `laravel-ddd` | `composer.json` + Laravel | Domain-Driven Design with Clean Architecture |
| `generic-layered` | Any `src/` project | Language-agnostic layered architecture |
| `typescript-mcp` | `package.json` + `tsconfig.json` + MCP SDK | TypeScript MCP server with layered architecture |

---

## Development

### Building

```bash
npm run build    # Compile TypeScript
npm test         # Run all tests (207+)
npm run test:watch
```

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
