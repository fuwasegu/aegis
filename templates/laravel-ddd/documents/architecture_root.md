# Architecture Root: Laravel DDD

This project follows Domain-Driven Design (DDD) and Clean Architecture principles with Laravel.

## Core Principles

1. **Domain Layer** is the heart of the application. It contains business logic, entities, value objects, and domain services.
2. **UseCase Layer** orchestrates domain operations. UseCases are thin — they delegate to domain objects.
3. **Infrastructure Layer** implements interfaces defined in the domain. It handles persistence, external APIs, and framework concerns.

## Dependency Rule

Dependencies point inward: Infrastructure → UseCase → Domain. The Domain layer has zero external dependencies.
