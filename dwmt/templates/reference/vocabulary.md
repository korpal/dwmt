# dwmt vocabulary v1 (explorer, architect)

The terms are standard; this file fixes which names to use and settles the pairs that are easy to confuse. dwmt does not expect the project to describe its architecture.

## Label rules
- Every element gets one term from the lists below, with evidence `path:line` (build file, folder, annotation, signature, base type, import, call).
- The project's own name goes after it as an alias: `layer: application (project: "service")`.
- No term fits: `other: <name> — <evidence>`. Not decidable from the code: `unclear — <why>`.
- At most one pattern tag, only with evidence.

## Terms
- Structure: module, public API (of a module), layer (presentation, application, domain, infrastructure), vertical slice, bounded context, port, adapter, extension point, shared kernel, anti-corruption layer. Style tag of an area: layered, ports and adapters, vertical slices, modular monolith, MVC or MVVM, CQRS, event-driven, pipeline.
- Elements: entity, value object, aggregate root, repository, query (read model), application service, policy (domain service), factory, endpoint, contract (DTO), mapper, event, handler, job, configuration, guard, test (unit, integration, end-to-end).
- User interface: screen, container, presentational component, hook, module state, API client, form schema, route parameter validator (parses and cleans the address's parameters), undoable action (a change the client can reverse, e.g. "Undo" in a notice), i18n, glue.
- Pattern tags: GoF (strategy, factory method, builder, adapter, decorator, facade, observer, command, template method), DDD (specification, domain event), PoEAA (unit of work, data mapper, service layer, identity map, lazy load).
- Relations: calls, depends on, reads, writes, emits, handles, fills (extension point), implements (port), inside or outside a transaction.

## Pairs easy to confuse
- entity vs value object: identity kept across changes vs equality by all fields.
- value object vs contract (DTO): a value object carries domain meaning and may hold rules; a DTO only crosses a boundary.
- policy vs application service: a policy decides or computes without I/O or a transaction; an application service orchestrates I/O and owns the transaction.
- repository vs query: a repository loads and saves domain objects; a query only reads, shaped for a screen or report.
- port vs any interface: a port is owned by the module that needs it and implemented outside that module.
- extension point vs port: a higher module fills an extension point so the lower one need not import it (UI slots, registries); an adapter serves a port.
- module vs vertical slice: a module has a declared public surface and boundary rules; a slice is a capability folder, often inside a module.
- container vs presentational component: a container fetches data or owns state; a presentational component only renders its inputs.
- guard vs test: a guard enforces an architecture or project rule (boundaries, forbidden calls, contract snapshot); a test checks behaviour.
