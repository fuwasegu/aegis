# Entity Guidelines

## Rules

1. Entities are identified by a unique ID, not by their attributes.
2. Entities encapsulate business rules. No anemic models.
3. Use Value Objects for attributes that have domain meaning.
4. Entities must not depend on infrastructure (no Eloquent in Domain).
