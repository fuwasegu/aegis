# Architecture Root: Layered Architecture

This project follows a layered architecture pattern.

## Layers (top to bottom)

1. **Presentation** — UI, controllers, CLI handlers
2. **Application** — Use cases, orchestration, DTOs
3. **Domain** — Business logic, entities, value objects
4. **Infrastructure** — Persistence, external services, framework glue

## Dependency Rule

Each layer may only depend on layers below it. Never depend upward.
