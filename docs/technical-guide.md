# Aegis Technical Guide

[日本語版](technical-guide.ja.md)

A deep dive into the deterministic algorithms and architectural design decisions inside Aegis.

## Table of Contents

1. [4-Step Context Compilation Routing](#1-4-step-context-compilation-routing)
2. [Deterministic Sorting by Specificity and Priority](#2-deterministic-sorting-by-specificity-and-priority)
3. [Layer Resolution Algorithm](#3-layer-resolution-algorithm)
4. [Init Profile Scoring](#4-init-profile-scoring)
5. [Snapshots and Content-Addressable Versioning](#5-snapshots-and-content-addressable-versioning)
6. [Pessimistic Claim Pattern (Concurrency Safety)](#6-pessimistic-claim-pattern-concurrency-safety)
7. [Proposal Deduplication (Semantic Key)](#7-proposal-deduplication-semantic-key)
8. [Preview Hash for TOCTOU Prevention](#8-preview-hash-for-toctou-prevention)
9. [SLM Intent Tagging and Grammar-Constrained Generation](#9-slm-intent-tagging-and-grammar-constrained-generation)
10. [Invariants](#10-invariants)

---

## 1. 4-Step Context Compilation Routing

The core feature of Aegis. `compile_context` deterministically resolves which documents are needed for given file paths — **via graph traversal, not search**.

### Algorithm

```
Input: target_files, target_layers?, command?, plan?

Step 1: path_requires
  ├─ Fetch all path_requires edges
  ├─ Match each edge's source_value (glob) against target_files (picomatch)
  └─ Matched edges → sort → collect target doc_ids

Step 2: layer_requires
  ├─ Resolve target layer names (→ §3)
  ├─ Match all layer_requires edge source_values against layer names
  └─ Matched edges → sort → collect target doc_ids

Step 3: command_requires
  ├─ Only if request.command is present
  ├─ Exact-match all command_requires edge source_values
  └─ Matched edges → sort → collect target doc_ids

Step 4: doc_depends_on transitive closure
  ├─ Starting from doc_ids collected in Steps 1-3
  ├─ Recursively traverse doc_depends_on edges (BFS / transitive closure)
  └─ Collect all reachable doc_ids

Output: documents[] + resolution_path[] + templates[]
```

### Determinism Guarantee

Given the same input, **always returns the same output**. This is the fundamental difference from RAG.

- P-1 covers: `base` (documents, resolution_path, templates), `expanded`, `warnings`
- P-1 excluded: `compile_id` (UUID), `notices` (operational metadata such as adapter version status)
- `notices` may vary by server runtime state and is not recorded in compile_log
- Edge sorting is deterministic (→ §2)
- Document display order is deterministic

### Complexity

- Step 1: O(E_path × F) — E_path: number of path_requires edges, F: number of target_files
- Step 2: O(R × F + E_layer × L) — R: number of layer_rules, L: number of resolved layers
- Step 3: O(E_cmd) — E_cmd: number of command_requires edges
- Step 4: O(V + E_dep) — standard graph traversal

For typical projects, all steps combined run in O(hundreds) — more than fast enough.

---

## 2. Deterministic Sorting by Specificity and Priority

When multiple edges point to the same document, a unique display order must be determined.

### Sort Keys (3 levels)

```
1. specificity DESC  — more specific patterns take priority
2. priority ASC      — lower numbers = higher priority
3. edge_id ASC       — final tiebreaker (UUID lexicographic order)
```

### Specificity Calculation

Scores the "specificity" of a glob pattern:

```
src/**              → low specificity (matches broadly)
src/core/**         → medium specificity
src/core/store/*.ts → high specificity (matches narrowly)
```

Calculation logic:
- Based on the number of `/` path separators
- `**` is generic, so it carries less weight
- Literal directory names carry more weight

### Importance of the edge_id Tiebreaker

Edges with identical specificity and priority can exist. The edge_id (UUID) lexicographic order serves as the final tiebreaker. Since **template seed_edges have deterministic IDs generated in order**, this effectively reflects the template definition order.

---

## 3. Layer Resolution Algorithm

Infers the architecture layer from file paths.

### Algorithm

```
Input: target_files[], layer_rules[]

1. Sort layer_rules:
   specificity DESC → priority ASC → rule_id ASC

2. For each target_file:
   a. Match against sorted rules top-down
   b. Adopt the layer_name of the first matching rule
   c. Skip if no match

3. Result: deduplicated set of layer names
```

### Design Rationale for First-Match Wins

Rules are sorted so the most specific rule matches first. Even if `src/core/store/*.ts` → `infrastructure` and `src/**` → `application` coexist, the former takes precedence.

### Explicit Override

If `target_layers` is explicitly provided, inference is skipped entirely (respecting the user's explicit intent).

---

## 4. Init Profile Scoring

Detects the project's stack and selects the optimal template.

### Stack Detection

```
detectStack(projectRoot):
  ├─ package.json exists? → has_npm = true
  ├─ tsconfig.json exists? → has_typescript = true
  ├─ composer.json exists? → has_composer = true
  ├─ requirements.txt / pyproject.toml exists? → has_python = true
  └─ src/ exists? → has_src = true
```

### Profile Scoring

Each template has `detection_rules` in its `manifest.yaml`:

```yaml
detection_rules:
  - check: file_exists
    target: package.json
    weight: 3
  - check: file_contains
    target: package.json
    pattern: "@modelcontextprotocol/sdk"
    weight: 5
```

Score = Σ(weight of matched rules)

### Determinism in Profile Selection

```
1. Sort by score DESC
2. If scores are tied → sort by profile_id ASC (lexicographic tiebreaker)
3. If top confidence is 'high' and multiple ties → block (ambiguous)
4. If top confidence is 'low' → warn (proceed with caution)
5. If tied (non-high) → warn and auto-select the first lexicographically
```

---

## 5. Snapshots and Content-Addressable Versioning

### Design

Canonical Knowledge versions are managed as **immutable Snapshots**.

```
knowledge_meta.current_version = 1, 2, 3, ...  (monotonically increasing)

Snapshot #3:
  ├─ snapshot_docs: [{doc_id, content_hash}, ...]
  ├─ snapshot_edges: [{edge_id, source_type, ...}, ...]
  └─ snapshot_layer_rules: [{rule_id, path_pattern, ...}, ...]
```

### Monotonically Increasing Version (INV-4)

```
approveProposal():
  1. Read current_version
  2. new_version = current_version + 1
  3. Create Snapshot with new_version
  4. Update knowledge_meta.current_version
  → Executed atomically within a SQLite transaction
```

Rollback is not possible. The version never decreases.

### Content Hash

Document `content_hash` is SHA-256. Same content → same hash → change detection is possible.

### Auditability (INV-5)

The `compile_log` table records every compilation:
- Which Snapshot was used
- Which documents were returned (base + expanded)
- The request contents

→ "Why was this document returned?" can be traced after the fact.

---

## 6. Pessimistic Claim Pattern (Concurrency Safety)

### Problem

`analyzeAndPropose` is asynchronous. If multiple MCP clients call it simultaneously, the same Observation risks being processed twice.

### Solution: Pessimistic Claim

```
analyzeAndPropose():
  1. Fetch unanalyzed Observations
  2. Immediately SET analyzed_at (= take the claim)
  3. Run analyzer.analyze() asynchronously
  4. Success → create proposals
  5. Failure → reset analyzed_at to NULL (= release the claim)
```

```
Timeline →
────────────────────────────────────────────
Call A: [claim] ─── [analyze] ─── [propose] ✓
Call B:         [claim: empty] → done immediately (nothing to process)
────────────────────────────────────────────
```

### Recovery

Both analyze() and propose() failures are caught, releasing the claim. This prevents Observations from being permanently stuck due to transient errors.

---

## 7. Proposal Deduplication (Semantic Key)

### Problem

If semantically identical Proposals are created multiple times, administrators are forced into redundant reviews.

### Semantic Key

For each proposal_type, a key is extracted to determine "semantic identity":

```
add_edge:   → "{source_type}:{source_value}:{target_doc_id}:{edge_type}"
new_doc:    → "{doc_id}"
update_doc: → "{doc_id}"
deprecate:  → "{entity_type}:{entity_id}"
bootstrap:  → "bootstrap"
```

### Global Scope

Deduplication checks run against **all pending proposals** (not scoped to a single Observation). This means:

- Even if different Observations propose the same `update_doc`, only one proposal is created
- Administrators only need to review once

---

## 8. Preview Hash for TOCTOU Prevention

### Problem

`init_detect` and `init_confirm` are separate calls. If template files change between them, the preview the user confirmed and the data actually materialized could differ.

### Solution

```
init_detect():
  1. Resolve templates
  2. Serialize all generated data (docs, edges, layer_rules) to JSON
  3. Compute SHA-256 hash = preview_hash
  4. Store preview_hash and data in an in-memory cache

init_confirm(preview_hash):
  1. Look up by preview_hash in cache
  2. No match → error (TOCTOU detected)
  3. Match → use the cached data as-is
```

The preview_hash encompasses document contents, edge structure, and placeholder values. If even a single bit changes, the hash differs.

---

## 9. SLM Intent Tagging and Grammar-Constrained Generation

### Purpose

Extract user intent from the `plan` parameter of `compile_context` and return documents unreachable via DAG routing as "expanded context."

### Prerequisite: SLM is Opt-in

SLM is explicitly enabled via the `--slm` flag. It is disabled by default — Base Context (deterministic DAG) operates without it. This design decision (ADR-004) ensures core functionality works with zero external dependencies.

### Algorithm

```
1. Feed the plan text to the SLM
2. From a tag list dynamically fetched from the tag_mappings table,
   have the SLM output relevant tags in JSON format
3. Map tags → documents via the tag_mappings table
4. Return only documents not already in the base context as expanded
```

The tag list is not a hardcoded constant — it is dynamically fetched from the `tag_mappings` table. Tags are registered during template bootstrap and proposal approval, growing the tag vocabulary as the project evolves.

### Grammar-Constrained Generation (llama.cpp)

Using node-llama-cpp's Grammar feature, the SLM output is constrained **at the token generation level** to a JSON schema:

```typescript
const grammar = await llama.createGrammarForJsonSchema({
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } }
  }
});
```

This ensures:
- JSON parse failures are structurally impossible
- No need to handle "almost-JSON but broken" output
- High success rate even with small models

### Model Management

```
~/.aegis/models/             ← shared across all projects
  ├─ qwen3.5-4b-instruct-q4_k_m.gguf
  └─ ...

Downloaded from HuggingFace on first SLM-enabled startup (resolveModelFile)
No download or initialization occurs when SLM is disabled (default)
```

---

## 10. Invariants

The six invariants Aegis maintains:

### INV-1: Data Integrity
- Every edge's `target_doc_id` references an existing document
- `doc_depends_on` forms a DAG (no cycles)
- FK constraints + application-level validation

### INV-2: DAG Integrity
- Verified at transaction time that `doc_depends_on` edges do not form cycles
- Guarantees that transitive closure computation terminates in finite steps

### INV-3: Snapshot Immutability
- Once created, Snapshot contents cannot be modified
- `snapshot_docs`, `snapshot_edges`, `snapshot_layer_rules` are INSERT-only

### INV-4: Monotonically Increasing Version
- `knowledge_meta.current_version` always increments by +1
- Never decreases or skips
- Atomicity guaranteed by SQLite transactions

### INV-5: Auditability
- Every `compile_context` call is recorded in `compile_log`
- Every Proposal is traceable from creation to resolution
- Evidence chain from Observation → Proposal (`proposal_evidence`)

### INV-6: Privilege Separation
- Agent Surface: read and Observation writes only (4 tools)
- Admin Surface: all operations including Canonical mutations (15 tools: 4 shared + 11 admin-only)
- Structurally prevents AI agents from directly modifying architecture rules
