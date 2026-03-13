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
   → Review the output: template match, confidence, warnings

2. If preview looks correct:
   aegis_init_confirm({ preview_hash: "<hash from step 1>" })
   → Creates seed documents, edges, layer rules
   → Auto-generates .cursor/rules/aegis-process.mdc
```

After init, `.aegis/` directory is created with the database. It self-manages its `.gitignore`.

## Step 3: Import Existing Docs (Optional)

If the project has existing architecture documentation:

```
aegis_import_doc({
  file_path: "/absolute/path/to/docs/architecture.md",
  kind: "guideline"
})
```

Supports YAML frontmatter for metadata:

```yaml
---
id: my-doc-id
title: My Document
kind: guideline
requires: [other-doc-id]
---
```

Each import creates a **proposal** that must be approved:

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

## SLM Configuration

By default, Aegis downloads and runs a local SLM (~1 GB) for intent tagging. To customize:

| Flag | Effect |
|------|--------|
| `--model qwen3.5-4b` | Default model (~2.5 GB) |
| `--model qwen3.5-9b` | Higher quality model (~5.5 GB) |
| `--no-slm` | Disable SLM entirely (base DAG still works) |
| `--list-models` | Show all available models |

Models are stored in `~/.aegis/models/` and shared across all projects.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `No matching architecture profile` | Project structure doesn't match any template. Check detection evidence in init_detect output. |
| `Ambiguous profile selection` | Multiple templates matched equally. May need to add template or adjust project structure. |
| `Compile returns empty` | Run init first. Or check that edges exist for your file paths. |
| SLM download fails | Use `--no-slm` to skip. Base context works without SLM. |
