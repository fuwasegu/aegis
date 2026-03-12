# MCP Server & Tool Guidelines

## Surface Separation (INV-6)

Tools are divided into two surfaces with strict permission boundaries:

- **Agent Surface**: Read-only operations that cannot modify Canonical Knowledge.
- **Admin Surface**: All agent tools plus Canonical-mutating operations (approve, init_confirm).

When adding a new MCP tool, decide which surface it belongs to BEFORE implementation.

## Adding a New Tool

1. **Define the tool in `src/mcp/server.ts`** — Registration only, no business logic.
2. **Implement logic in `src/mcp/services.ts`** — The `AegisService` facade delegates to Core modules.
3. **Guard admin tools** — Call `this.assertAdmin(toolName, surface)` at the start of admin-only methods.
4. **Use zod schemas** for input validation at the MCP boundary.
5. **Return JSON via `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`**.

## Tool Naming Convention

- Prefix all tools with `aegis_`.
- Use snake_case: `aegis_compile_context`, `aegis_observe`, `aegis_approve_proposal`.

## Service Facade Pattern

`AegisService` is the single entry point between MCP handlers and Core logic. It enforces:

- Surface authorization (INV-6)
- Input validation (discriminated union for observe events)
- Delegation to Core modules (ContextCompiler, Repository, Init Engine)

No business logic should exist in `server.ts`. If a handler needs more than parameter mapping, the logic belongs in `services.ts` or deeper in Core.

## Error Handling

- Validation errors: Return `{ isError: true }` with a human-readable message.
- Internal errors: Let them propagate (MCP SDK handles the error response).
- Never expose internal stack traces to the agent.
