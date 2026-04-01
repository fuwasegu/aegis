---
name: aegis-triage
description: Triage skipped Aegis observations. Use when the user asks to triage observations, review compile misses, check skipped observations, or maintain Aegis knowledge quality.
---
<!-- aegis:managed-skill -->

# Aegis Observation Triage

Review observations that the analyzer could not automatically resolve, and decide on corrective actions. Requires the **admin** surface.

## Step 1: List Skipped Observations

```
aegis_list_observations({ outcome: "skipped" })
```

Focus on observations with `outcome: "skipped"` — these were analyzed but no proposal was generated.

## Step 2: Assess Each Observation

For each skipped observation, read:

- **`event_type`**: What kind of observation (usually `compile_miss`)
- **`review_comment`**: What the agent reported as missing or insufficient
- **`target_doc_id`**: Which document was insufficient (if provided, from `base.documents` only)

Determine the appropriate action:

| Situation | Action |
|-----------|--------|
| Document content is genuinely insufficient | Update the document (Step 3a) |
| Document is missing from compile result | Report as `missing_doc` (Step 3b) |
| False positive / not actionable | No action needed — will be archived automatically |

## Step 3a: Update an Existing Document

If an existing document's content is insufficient, report a `review_correction` with the improved content. This generates an `update_doc` proposal via the ReviewCorrectionAnalyzer:

```
aegis_observe({
  event_type: "review_correction",
  payload: {
    file_path: "<any relevant file path>",
    correction: "<what was insufficient and how it should be improved>",
    target_doc_id: "<the target_doc_id from the skipped observation>",
    proposed_content: "<full updated markdown content for the document>"
  }
})
```

Then process and approve:

```
aegis_process_observations({ event_type: "review_correction" })
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

**Note**: `aegis_import_doc` can also update existing documents (it generates `update_doc` if the `doc_id` already exists). For targeted content corrections based on review feedback, the `review_correction` flow above is preferred.

## Step 3b: Add Missing Edge

If the compile result should have included a document but didn't, report it as a compile_miss with `missing_doc`. Use the `related_compile_id`, `related_snapshot_id`, and `target_files` from the skipped observation (all available in `aegis_list_observations` output):

```
aegis_observe({
  event_type: "compile_miss",
  related_compile_id: "<related_compile_id from the skipped observation>",
  related_snapshot_id: "<related_snapshot_id from the skipped observation>",
  payload: {
    target_files: <target_files array from the skipped observation>,
    review_comment: "<why this doc should have been included>",
    missing_doc: "<doc_id that was missing>"
  }
})
```

Then run the analyzer to generate an `add_edge` proposal:

```
aegis_process_observations({ event_type: "compile_miss" })
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## Step 4: Check Pending Observations

Also check for unprocessed observations:

```
aegis_list_observations({ outcome: "pending" })
```

If any exist, run the analyzer:

```
aegis_process_observations()
```

## Recommended Cadence

Run triage after any significant development session, or when the project accumulates 5+ observations. This keeps the knowledge graph accurate and prevents compile misses from recurring.
