# UseCase Guidelines

## Rules

1. A UseCase represents a single application operation.
2. UseCases orchestrate — they call domain objects and repositories, but contain no business logic themselves.
3. One public method per UseCase class (`execute` or `__invoke`).
4. UseCases must not depend on HTTP, CLI, or other delivery mechanisms.
