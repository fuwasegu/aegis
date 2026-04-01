---
name: aegis-bulk-import
description: Bulk-import existing project documents into Aegis knowledge base. Use when the user wants to import many documents at once, populate the knowledge base from existing docs, or batch-import architecture documentation.
---
<!-- aegis:managed-skill -->

# Aegis Bulk Import Guide

Import existing project documentation into Aegis in bulk. Requires the **admin** surface (`aegis-admin`).

For single-document import basics, see the [aegis-setup skill](../aegis-setup/SKILL.md) Step 3.

## Step 1: Discover Documents

List architecture documentation files in the project:

```
find docs/ -name "*.md" -type f | sort
```

Typical targets: ADRs, architecture guides, coding conventions, API specs, design patterns, infrastructure docs.

## Step 2: Design Metadata

For each file, determine the following fields:

### `doc_id`

Derive from filename in kebab-case:

| File path | doc_id |
|-----------|--------|
| `docs/adr/001-use-cqrs.md` | `adr-001-use-cqrs` |
| `docs/guides/layer-naming.md` | `layer-naming` |
| `docs/patterns/cte-query.md` | `cte-query-pattern` |

### `kind`

| Kind | Use for |
|------|---------|
| `guideline` | Design principles, layer rules, architecture guides |
| `pattern` | Implementation patterns, code examples, recipes |
| `constraint` | Coding conventions, naming rules, validation rules |
| `template` | Scaffold templates, boilerplate generators |
| `reference` | API specs, infrastructure configs, external references |

### `edge_hints`

Connect documents to the DAG so `aegis_compile_context` returns them for relevant files:

| source_type | edge_type | When to use | Example |
|-------------|-----------|-------------|---------|
| `path` | `path_requires` | Document applies to specific file paths | `src/domain/**` |
| `layer` | `layer_requires` | Document applies to an architecture layer | `Application` |
| `command` | `command_requires` | Document applies to specific commands | `review` |
| `doc` | `doc_depends_on` | Document depends on another document | `architecture-overview` |

Use `doc_depends_on` for inter-document relationships (e.g., a pattern doc that presumes knowledge of an architecture guideline).

**Multiple edge_hints** can be combined on a single document:

```
edge_hints: [
  { source_type: "path", source_value: "modules/*/Application/**", edge_type: "path_requires" },
  { source_type: "layer", source_value: "Application", edge_type: "layer_requires" },
  { source_type: "doc", source_value: "clean-architecture-guide", edge_type: "doc_depends_on" }
]
```

## Step 3: Loop Import

Call `aegis_import_doc` for each file. Use **absolute paths** for `file_path`. Accumulate the returned `proposal_ids`.

```
collected_proposal_ids = []

for each file in document_list:
  result = aegis_import_doc({
    file_path: "/absolute/path/to/project/docs/guide.md",  # must be absolute
    doc_id: "guide",
    title: "Architecture Guide",
    kind: "guideline",
    tags: ["architecture"],
    edge_hints: [
      { source_type: "path", source_value: "src/**", edge_type: "path_requires" }
    ]
  })
  collected_proposal_ids.push(...result.proposal_ids)
```

Key points:
- `file_path` reads content directly from disk — avoids LLM truncation of large documents
- `source_path` is auto-set from `file_path`, enabling later `aegis_sync_docs`
- Each call returns `proposal_ids` — collect them for batch approval

## Step 4: Batch Approve

Approve **only the collected proposal_ids** from Step 3. Do not use `aegis_list_proposals({ status: "pending" })` to approve all pending proposals — that risks approving unrelated proposals.

```
for each proposal_id in collected_proposal_ids:
  aegis_approve_proposal({ proposal_id: proposal_id })
```

## Step 5: Verify

Test that documents are returned by `aegis_compile_context`. Use `target_files` and `command` values that **match the `edge_hints` you configured** in Step 2:

```
aegis_compile_context({
  command: "review",
  target_files: ["src/domain/SomeEntity.ts"],
  plan: "Verify architecture documents are returned"
})
```

If `edge_hints` used `path_requires` with `src/domain/**`, pass a file under `src/domain/`. If documents are not returned, check that the edge_hints match the target paths or layers.

## Step 6: Ongoing Sync

When source documents are updated on disk, use `aegis_sync_docs` to detect and propagate changes:

```
aegis_sync_docs()                               # sync all documents with source_path
aegis_sync_docs({ doc_ids: ["my-doc-id"] })     # sync specific documents
```

This compares content hashes and creates `update_doc` proposals for stale documents. Approve the generated proposals to apply updates.
