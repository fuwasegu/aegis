# Testing Guidelines

## Framework

Use **Vitest** with `globals: true`. Tests are co-located with source files using `*.test.ts` suffix.

## Test Structure

- Each module has its own test file (e.g., `compiler.test.ts`, `repository.test.ts`).
- Use `describe` blocks to group related tests by feature or method.
- Test names should describe the behavior, not the implementation.

## Database in Tests

- Create a fresh in-memory SQLite database for each test suite (`:memory:`).
- Initialize schema via `createDatabase(':memory:')`.
- Never share database state across test cases — each test should set up its own data.

## What to Test

1. **Happy paths**: Normal operation with valid inputs.
2. **Invariant enforcement**: Verify INV-1 through INV-6 hold under mutations.
3. **Edge cases**: Empty inputs, missing optional fields, boundary values.
4. **Error conditions**: Invalid inputs, constraint violations, cycle detection.
5. **Async behavior**: Tagger failures, concurrent claim patterns, rollback scenarios.

## Test Patterns

- **Arrange-Act-Assert**: Set up data, execute operation, verify result.
- For async code, always use `await` — never rely on implicit promise resolution.
- Use `rejects.toThrow` for testing async error paths.
- Fake implementations (e.g., `FakeTagger`) should live in test files, not in source.

## Coverage Goals

- All Repository CRUD methods must have at least one test.
- All MCP tool handlers must have surface-separation tests (agent vs admin).
- All automation analyzers must test the skip/propose decision boundary.
