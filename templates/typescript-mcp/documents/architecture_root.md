# Architecture Root: TypeScript MCP Server

This project is structured as an MCP (Model Context Protocol) server with a layered architecture.

## 3-Layer Model

```
┌─ MCP Layer (src/mcp/) ─────────────────────────────┐
│ Tool registration, request/response mapping.        │
│ No business logic. Delegates to Service Facade.     │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─ Core Layer (src/core/) ───────────────────────────┐
│ Business logic, domain types, algorithms.           │
│ Framework-agnostic. Testable without MCP runtime.   │
│ Sub-modules: store/, read/, init/, automation/,     │
│              tagging/                               │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─ Adapters Layer (src/adapters/) ───────────────────┐
│ External integrations (Cursor, Claude, Ollama).     │
│ Isolated from Core. Adapters can be swapped.        │
└─────────────────────────────────────────────────────┘
```

## Dependency Rule

Dependencies flow downward: MCP → Core → (nothing). Adapters depend on Core interfaces but Core never imports from Adapters or MCP.

## Key Design Principles

1. **Determinism (P-1)**: Same input + same knowledge version = same output. No LLM in the critical path.
2. **Trust Boundary (P-2)**: Deterministic results (`base`) and inferred results (`expanded`) are structurally separated.
3. **Human Approval (P-3)**: All Canonical Knowledge mutations require human approval via Proposed Layer.
4. **Auditability (P-4)**: Every compile_context call is logged with compile_id and snapshot_id.
5. **Agent Independence (P-5)**: Core logic has zero coupling to specific AI agents.

## Invariants

- **INV-1**: compile_context only reads `status='approved'` documents/edges.
- **INV-2**: `doc_depends_on` edges form a DAG (cycle detection on approve).
- **INV-3**: Snapshots are immutable (INSERT ONLY).
- **INV-4**: knowledge_version is monotonically increasing.
- **INV-5**: compile_id + snapshot_id provide full audit trail.
- **INV-6**: Agent Surface cannot modify Canonical. Only Admin Surface approve/init_confirm can.
