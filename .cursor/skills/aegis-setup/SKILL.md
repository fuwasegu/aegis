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
1. aegis_init_detect({ project_root: "<absolute path to project>" })
   → Review the output: template match, confidence, seed documents
```

**Important: Before confirming, present the seed documents to the user.**

The preview includes `seed_documents` — architecture guidelines that will be added to the knowledge base. These are generic best practices for the detected stack (e.g. Next.js App Router, Laravel DDD). They may not match the project's actual conventions.

**You MUST ask the user:**
> "Aegis detected **{template_name}** and will add these seed documents:
> - {doc_id}: {title}
> - {doc_id}: {title}
> - ...
>
> Do you want all of them, or should I exclude any?"

If the user wants to exclude documents, note the `doc_id`s to exclude. If the user wants no template documents at all, skip to Step 3 and use `import_doc` instead.

```
2. aegis_init_confirm({ preview_hash: "<hash from step 1>" })
   → Creates seed documents, edges, layer rules

3. Deploy adapter rules (run in terminal, not an MCP tool):
   npx @fuwasegu/aegis deploy-adapters
   → Generates .cursor/rules/aegis-process.mdc
   → Generates CLAUDE.md / AGENTS.md sections
```

After init, `.aegis/` directory is created with the database. It self-manages its `.gitignore`.

## Step 3: Import Existing Docs (Optional)

If the project has existing architecture documentation, read the file content and pass it directly:

```
aegis_import_doc({
  content: "<full markdown content of the document>",
  doc_id: "my-doc-id",
  title: "My Document",
  kind: "guideline",
  tags: ["architecture", "patterns"],
  edge_hints: [
    { source_type: "doc_depends_on", target_doc_id: "other-doc-id" }
  ]
})
```

Required fields: `content`, `doc_id`, `title`, `kind`.
Optional fields: `tags`, `edge_hints`, `source_path` (for provenance tracking only).

Each import creates a **proposal** (with full evidence chain via observation) that must be approved:

```
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## Step 4: Verify

Test the setup by compiling context:

```
aegis_compile_context({
  target_files: ["src/main.ts"],
  plan: "Add error handling to the main entry point"
})
```

Should return architecture documents relevant to the target files.

## Step 5: Claude Code / Codex (Optional)

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
| `--template-dir <path>` | Additional template search path (local overrides bundled) |

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
| `No matching architecture profile` | Project structure doesn't match any template. Check detection evidence in init_detect output. |
| `Ambiguous profile selection` | Multiple templates matched equally. May need to add template or adjust project structure. |
| `Compile returns empty` | Run init first. Or check that edges exist for your file paths. |
| SLM download fails | Remove `--slm` flag. Base context works without SLM. |
