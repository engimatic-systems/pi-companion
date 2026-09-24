# Contributing to Companion

Before changing behavior, read the [model](MODEL.md), [glossary](GLOSSARY.md),
[architecture](ARCHITECTURE.md) and [style guide](STYLE_GUIDE.md). The
[README](../README.md) owns installation and operation; keep maintained docs
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

## Preparing a change

Keep the change bounded and identify the obligation it serves. Ask:

- Does it implement a model rule, Runtime policy, HostConnection operation or
  Transport guarantee at the module that owns it?
- Does it maintain independent facts that can instead be derived from one ID?
- Does it enforce a consistency guarantee the workflow does not require?
- Does it confuse identity, local introduction, or current availability?

Update the authoritative document for any changed contract and link to it rather
than repeating it elsewhere. Keep the model small; implementation mechanics
belong in architecture or source documentation. Maintain the corresponding
behavior tests and obligation inventory.

Present the scope, checks performed, results and remaining limitations for
review. Attribute validation to the actual tested revision; distinguish new
red/green tests from existing conformance checks. For documentation-only edits,
verify local links, stale references and the docs-only diff rather than implying
that a prior runtime check was performed again.
