# Developing Companion

Read the [glossary](GLOSSARY.md) and [design](DESIGN.md) before changing behavior.
The [README](../README.md) owns installation and operation; keep maintained docs
about the current system, not candidate history or review-run narratives.

## Setup and validation

The supported integration baseline is Pi 0.85.1, Herdr 0.9.0 and Node.js 22.
From the repository root:

```sh
npm ci
npm run typecheck
npm test
```

`npm test` runs strict TypeScript checking, the TypeScript behavior tests, and a
real Pi extension-and-skill discovery test. `npm run test:runtime` and
`npm run test:package` run those suites separately. The discovery test uses the
installed development Pi binary by default; set `PI_PACKAGE_TEST_PI` to an
absolute Pi executable path to exercise another supported installation.

Run tests as an ordinary user on a Unix-socket-capable filesystem. Persistence
failure tests deliberately use temporary-file permissions; root bypasses those
permissions. Tests own their temporary directories and conversation IDs and must
not write into an operator's state or replace their settings.

Pi supplies its core packages and TypeBox at extension load time; they are
optional `*` peers. Pinned development dependencies support typechecking and
tests. `neverthrow` and `ts-pattern` are runtime dependencies. A production
checkout can use `npm ci --omit=dev` and must still load through Pi without any
sibling checkout or development dependencies.

### Behavior coverage

Durable tests follow the semantic interfaces, not private helpers:

| Seam | Tests |
| --- | --- |
| Companion state and persistence | `test/companion.test.ts` |
| Runtime orchestration | `test/runtime.test.ts` |
| Human text → action | `test/command.test.ts` |
| Structured actions, selection and execution | `test/actions.test.ts` |
| Pi registration, presentation and lifecycle | `test/index.test.ts` |
| HostConnection and launch | `test/host.test.ts` |
| Transport exchange and ownership | `test/transport.test.ts` |
| Real Pi extension and skill discovery | `test/package-consumption.test.mjs` |

The detailed obligation inventory is [test/SCENARIOS.md](../test/SCENARIOS.md).
Keep it aligned with the tests; do not encode implementation machinery as a
behavior guarantee. A private temporary directory is the persistence test seam,
not a reason to invent a generic store adapter.

Real Pi/Herdr validation uses an isolated installed package, conversations and
owned resources. Check parent package discovery and the child's exact entrypoint,
mutual introduction, messaging/steering, selection, placement, local forgetting,
reload, clean same-ID resume and cleanup. Mock-only tests do not establish these
integration claims. Record the exact tested source revision or manifest, checks,
results and cleanup evidence with the ticket/review, not in maintained docs.
Never use operator sessions or change global settings for a test. Remove only
resources whose ownership is established by that test.

## Implementation practices

### Document consequential contracts

Document semantic module interfaces and consequential behavior that signatures
do not reveal. JSDoc explains caller-relevant guarantees, effects, obligations
and failure behavior. Local comments explain non-obvious rationale. Avoid
redundant narration, comment quotas and documentation of incidental mechanics
as promises.

### Keep contracts readable and local

Keep schemas and their derived types together. Collect command/tool names,
descriptions, usage and schema references in declarative contracts, with explicit
registration handlers. Parsing and execution remain separate from presentation.
Reuse meaningful field definitions without building a schema framework.

Prefer directly readable record shapes or composition of meaningful named
values. Do not hide fields behind inheritance or intersection chains solely to
deduplicate declarations. Genuine subtype contracts are not prohibited.

### Prefer functions over unnecessary factories

A direct function accepting configuration and inputs is preferable to two-step
callback construction when the factory adds no meaningful contract. Do not add
production interfaces solely to enable test instrumentation.

### Establish constraints at construction

Apply the design's construction-first principles: derive addresses from identity
rather than reconciling independent facts. Parse untrusted input into values
whose construction establishes downstream guarantees instead of repeatedly
checking envelopes. Types do not guarantee external availability; resource
ownership and fallible effects still belong at explicit owning seams.

### Compose failures explicitly

Use NeverThrow `Result`/`ResultAsync` for expected operation outcomes, composing
with `map`, `mapErr` and `andThen` where they clarify flow. Match alternatives
exhaustively with `ts-pattern`; do not use unchecked unwrap as ordinary control
flow or introduce a generic Result framework.

Preserve meaningful failure variants rather than renaming them without new
meaning. Results do not erase cancellation, resource ownership or delivery
uncertainty. Programmer exceptions and the model's explicitly exceptional storage
failures remain thrown/rejected instead of being mislabeled as expected transport
outcomes. Keep exact storage path and underlying cause visible.
