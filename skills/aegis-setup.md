---
name: aegis-setup
description: Guide for installing and initializing Aegis MCP server in a project. Use when setting up Aegis, adding architecture enforcement, initializing aegis, or when the user mentions aegis setup, onboarding, or project initialization with Aegis.
---

# Aegis Setup Guide

Step-by-step guide for adding Aegis to a project. Follow in order.

## Step 1: Add MCP Configuration

Add to the project's `.cursor/mcp.json` (create if missing):

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

**Key:** Agent surface for development, admin surface for initialization and approvals.

## Step 2: Initialize the Project

Using the **admin** surface tools:

```
1. aegis_init_detect({ project_root: "<absolute path to project>", skip_template: true })
   → Creates an empty knowledge base (no bundled templates)

2. aegis_init_confirm({ preview_hash: "<hash from step 1>" })
   → Initializes the project with an empty knowledge base

3. Deploy adapter rules (run in terminal, not an MCP tool):
   npx @fuwasegu/aegis deploy-adapters
   → Generates .cursor/rules/aegis-process.mdc
   → Generates CLAUDE.md / AGENTS.md sections
```

After init, `.aegis/` directory is created with the database. It self-manages its `.gitignore`.

## Step 3: Analyze Codebase and Create Documents

The knowledge base is empty after init. You need to analyze the codebase and create architecture documents.

**You MUST use the admin surface for this step.**

1. **Read the project structure** — List directories, identify key architectural patterns (e.g. layered architecture, domain modules, API routes).
2. **For each pattern, create a document** using `aegis_import_doc`:

```
aegis_import_doc({
  doc_id: "repo-pattern",
  title: "Repository Pattern",
  kind: "guideline",
  content: "## Repository Pattern\n\nAll data access goes through repository interfaces...",
  edge_hints: [
    { source_type: "path", source_value: "src/core/store/**", edge_type: "path_requires" }
  ]
})
```

**CRITICAL: Always include `edge_hints`.**
Without `edge_hints`, the document will be isolated in the DAG and `compile_context` will never return it. Each `edge_hint` connects the document to file path patterns so that `compile_context` can route queries to it.

If the project has existing architecture documentation files, use `file_path` to import directly from disk:

```
aegis_import_doc({
  file_path: "/absolute/path/to/doc.md",
  doc_id: "my-doc-id",
  title: "My Document",
  kind: "guideline",
  edge_hints: [
    { source_type: "path", source_value: "src/domain/**", edge_type: "path_requires" }
  ]
})
```

Required fields: `doc_id`, `title`, `kind`, and either `content` or `file_path`.
Optional fields: `tags`, `edge_hints`, `source_path` (auto-set from `file_path` if not provided).

For bulk-importing many documents at once, see the [aegis-bulk-import skill](aegis-bulk-import.md).

## Step 4: Approve Proposals

Each import creates a **proposal** that must be approved:

```
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## Step 5: Verify

Test the setup by compiling context:

```
aegis_compile_context({
  target_files: ["src/main.ts"],
  plan: "Add error handling to the main entry point"
})
```

Should return architecture documents relevant to the target files. If empty, check that your `edge_hints` patterns match the target file paths.

## Step 6: Claude Code / Codex (Optional)

For Claude Code projects, also add to `.mcp.json`:

```bash
claude mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
```

For Codex, add workflow to `AGENTS.md`:

```markdown
## Aegis Process
Before writing code:
1. Call `aegis_compile_context` with target_files and plan
2. Follow the returned guidelines
After writing code:
3. Report compile misses via `aegis_observe`
```

## SLM Configuration (Optional)

SLM is **disabled by default**. The deterministic DAG context works without it. To enable intent tagging:

| Flag | Effect |
|------|--------|
| `--slm` | Enable SLM (required for intent tagging) |
| `--model qwen3.5-4b` | Default model (~2.5 GB, requires `--slm`) |
| `--model qwen3.5-9b` | Higher quality model (~5.5 GB, requires `--slm`) |
| `--list-models` | Show all available models |
| `--ollama` | Use Ollama backend (implies `--slm`) |
| `--template-dir <path>` | Additional template search path (for custom templates) |

Models are stored in `~/.aegis/models/` and shared across all projects.

Example MCP config with SLM enabled:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent", "--slm"]
    }
  }
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Compile returns empty` | Check that edges exist for your file paths. Use `aegis_import_doc` with `edge_hints`. |
| `Ambiguous profile selection` | Use `skip_template: true` to bypass template detection. |
| SLM download fails | Remove `--slm` flag. Base context works without SLM. |
