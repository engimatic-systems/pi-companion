# Companion style guide

Implementation and documentation practices for Companion. Read the
[model](MODEL.md) for semantics and the [architecture](ARCHITECTURE.md) for
responsibility placement. Development setup and validation belong in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Define the constraints; make them true by construction

**Keep one fact; derive the next.** Prefer fewer independent choices over
machinery that keeps separately chosen facts consistent. These principles call
for less state, not automatically more types or validation layers.

Derive addresses from identity rather than reconciling independent facts. Parse
untrusted input into values whose construction establishes downstream guarantees
instead of repeatedly checking envelopes. Types do not guarantee external
availability; resource ownership and fallible effects still belong at explicit
owning seams.

## Document consequential contracts

Document semantic module interfaces and consequential behavior that signatures
do not reveal. JSDoc explains caller-relevant guarantees, effects, obligations
and failure behavior. Local comments explain non-obvious rationale. Avoid
redundant narration, comment quotas and documentation of incidental mechanics
as promises.

## Keep contracts readable and local

Keep schemas and their derived types together. Collect command/tool names,
descriptions, usage and schema references in declarative contracts, with explicit
registration handlers. Parsing and execution remain separate from presentation.
Reuse meaningful field definitions without building a schema framework.

Prefer directly readable record shapes or composition of meaningful named
values. Do not hide fields behind inheritance or intersection chains solely to
deduplicate declarations. Genuine subtype contracts are not prohibited.

## Prefer functions over unnecessary factories

A direct function accepting configuration and inputs is preferable to two-step
callback construction when the factory adds no meaningful contract. Do not add
production interfaces solely to enable test instrumentation.

## Compose failures explicitly

Use NeverThrow `Result`/`ResultAsync` for expected operation outcomes, composing
with `map`, `mapErr` and `andThen` where they clarify flow. Match alternatives
exhaustively with `ts-pattern`; do not use unchecked unwrap as ordinary control
flow or introduce a generic Result framework.

Preserve meaningful failure variants rather than renaming them without new
meaning. Results do not erase cancellation, resource ownership or delivery
uncertainty. Programmer exceptions and the model's explicitly exceptional storage
failures remain thrown/rejected instead of being mislabeled as expected transport
outcomes. Keep exact storage path and underlying cause visible.
