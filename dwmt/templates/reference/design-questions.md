# dwmt architect: design questions v1

Answer every question the sprint touches before you split it into tasks. The terms are standard (DDD strategic design, Enterprise Integration Patterns, PoEAA); this file says what to decide, not what the terms mean. dwmt does not expect the project to have written any of this down: infer the current state from explorer facts and the code, and cite a project document only when it exists.

## Ownership and boundaries
- Which bounded context or module owns each new or changed piece of data and each rule? New vertical slice or part of an existing one, and why there?
- Relations between the contexts involved (context map): customer–supplier, conformist, anti-corruption layer, open host service with a published language, shared kernel, separate ways. Does the change add a dependency against the allowed direction?
- Where does each boundary contract live (API, event, port, extension point), and who may change it?

## Consistency
- Aggregate and consistency boundary: what must change atomically in one transaction, and what may be eventually consistent (and what the user sees meanwhile)?
- Each invariant: the one place that enforces it, and what backs it in storage (constraint, unique key).
- Concurrent changes: lost updates, ordering, optimistic locking or versions.

## Integration
- In-process call through a port, or a message? Synchronous request–reply or asynchronous?
- With messages (EIP): point-to-point or publish–subscribe channel, message translator, content enricher, content-based router, splitter and aggregator, idempotent receiver, transactional outbox, process manager (saga) with compensation, dead letter channel, correlation identifier.
- External systems: one adapter each, anti-corruption at the boundary, timeouts, retries with backoff, what happens when it is down.

## Failure and change
- What can fail, and what the user sees then; duplicates and retries (idempotency keys).
- Contract evolution: backward compatible or versioned; generated clients, snapshots and documents that must follow.
- Data: migration, backfill, rollback, risk of data loss.

## Reads and writes
- Read models shaped for screens vs the write model (CQRS when they diverge); where derived values are computed and why.
- Volume: pagination, N+1 queries, indexes, payload size.

## Quality attributes
- Security (authorisation at the boundary), observability, testability (seams for tests), cost. Name the trade-off you accept.

## Reuse
- Which existing element already does this, or nearly? A new element needs a reason.

## From decisions to plans
- Each decision becomes a D-n with its reason and tactical change lines in the task plans. Example: "Catalog supplies Billing through an anti-corruption layer" becomes "[new adapter] X in module billing — translates the catalog contract into value object Y" and "[event] Z emitted by aggregate A".
- Invariants, idempotency, migrations and contract changes become risks R-n with a method.
- `## Design` in the sprint plan: 3–8 lines at capability level for the user (contexts and slices touched, their relations and integration style, consistency choices, the main trade-off); no classes.
