# Companion design

Companion preserves conversational context and isolates responsibility through
independently accessible conversations. Work and history stay local unless
explicitly communicated. Conversational separation is not a filesystem sandbox.

Terms are defined in the [glossary](GLOSSARY.md); the [README](../README.md) owns
installation, command spelling, launch-selection rules and operational limits.
This document owns the model and its implementation responsibilities.

## Principles

**Define the constraints; make them true by construction.**

**Keep one fact; derive the next.**

Prefer fewer independent choices over machinery that keeps separately chosen
facts consistent. These principles call for less state, not automatically more
types or validation layers.

## Identity and state

Let `I` be the set of valid conversation IDs. A conversation's identity and its
reference are the same value `c ∈ I`. Its local model is `(c, D_c)`, where:

```text
D_c ⊆ I \ {c}
```

References are safe, bounded native session IDs. HostConnection chooses a fresh
ID before launch, passes it through Pi `--session-id`, and derives its socket
address from it. Session state is also keyed by that ID. Transcript paths,
addresses, process handles and status are not additional identities.

For processes agreeing on a socket root:

```text
address : I → Address
```

Each connection resolves `socketRoot = tmpdir()` once. Addresses take the form
`<socketRoot>/pi-companion-<uid>/<id>.sock`, with a checked platform path limit.
The listener directory is private to the user. There is no socket-root setting
or propagation channel. This establishes address correspondence, not availability
or enforced exclusivity of an ID.

### Introductions and forgetting

Successful creation of a fresh conversation `d` by `c` introduces both peers:

```text
D_c' = D_c ∪ {d}
D_d' = {c}
```

Every received message from `e` to `d` introduces its sender before local Pi
delivery:

```text
D_d' = D_d ∪ {e}       # e ≠ d
```

Introduction is idempotent; self-introduction has no effect. A sender does not
need to be in the receiver's destination set. References are knowledge, not
credentials, and destination sets are not inbound access-control lists.

Forgetting is local:

```text
D_c' = D_c \ {d}
```

It changes neither `d` nor `D_d` and does not prevent reintroduction. The resulting
structure is a directed graph of knowledge, not a tree of owned conversations.
Every conversation has the same operations, without roles or spawning privileges.

These transitions describe successful saves, not a cross-conversation transaction.
A receiving save or creator-side save can fail after a process was launched.
The process may remain; there is no external-effect rollback or silent relaunch.

### Persistent collection

Companion owns synchronous load/save at
`<getAgentDir()>/companion/<native-session-id>.json`. The Pi entrypoint supplies
the configured agent directory; tests supply isolated directories. The file is
a JSON array of destination references, not an envelope repeating the owner,
socket path or status. Identity is derived from its filename.

Construction loads and validates the complete array, deduplicating and excluding
self without rewriting the file. A missing file starts empty. Other read errors,
invalid JSON and invalid references throw an exception with exact path and
underlying cause; the file is not replaced with guessed empty state.

A real introduction or forgetting computes the next set, writes a temporary
sibling file, renames it over the state file, then adopts the change in memory.
A failed save throws and leaves the prior in-memory set authoritative. No-op
mutations do not require writable storage. Temporary-file cleanup must not mask
the original failure.

This is a concrete implementation inside Companion, not a generic storage
framework or Runtime mutate/save/rollback protocol. It assumes one active
instance per native ID without locking. No journal, retries, automatic repair,
fsync or strong crash-durability guarantee is provided.

The file is current conversation knowledge, not transcript-branch state. Every
startup, reload or same-ID resume loads it through ordinary construction. New
IDs address different files. Shutdown stops communication resources; it does not
capture destination state. Persistence cannot establish availability or recover
interrupted operations.

## Modules and reading path

Start at [`src/index.ts`](../src/index.ts), then read actions, command spelling
or Runtime as needed:

```text
Pi integration → Command language → Action contract
               → Actions → Runtime → Companion
                                   → HostConnection → Transport
```

- **Pi integration** constructs Companion, HostConnection and Runtime on session
  start; stops the active Runtime on shutdown; and registers the human command
  and structured tool with explicit handlers. It owns notifications, tool
  rendering and attributed incoming Pi messages.
- **Actions**, [`src/actions.ts`](../src/actions.ts), owns the canonical action
  schema, its derived TypeScript type, structured-input decoding, selection
  preflight, execution and outcomes. Pi's flattened tool advertisement reuses
  field definitions, but the action schema decides legal field combinations.
- **Command language**, [`src/command.ts`](../src/command.ts), translates human
  text to an action. It owns raw-text framing, small fixed-command dispatch,
  native `util.parseArgs` option parsing and syntax diagnostics, not Runtime or
  model availability. It never tokenizes and rejoins the message tail.
- **Runtime**, [`src/runtime.ts`](../src/runtime.ts), coordinates model changes
  with HostConnection outcomes. It owns no socket or storage mechanics.
- **Companion**, [`src/companion.ts`](../src/companion.ts), owns identity,
  destination rules and their synchronous persistence, with no HostConnection
  dependency or asynchronous workflow.
- **HostConnection**, [`src/host.ts`](../src/host.ts), integrates one
  conversation with Pi and Herdr: launch, incoming destination checks,
  introductions, delivery and meaningful operation outcomes.
- **Transport**, [`src/socket-transport.ts`](../src/socket-transport.ts), owns
  the listener, accepted sockets, framing, parsing, exchange and cleanup.

The Host is the existing shared environment—Herdr, Pi processes and filesystem
resources—not an object created by the extension. Runtime holds one logical
HostConnection. Releasing it stops its listener, not the shared Host, conversation,
or other conversations.

## Operation composition

HostConnection's outbound operations are:

```text
HostConnection_c.create(configuration) → d
HostConnection_c.submit(d, message)
```

Configuration is a complete cwd/provider/model/thinking tuple, without an initial
message or unresolved options. Actions resolve and validate selection before
Runtime or Herdr effects, reading but not changing the invoking Pi selection.
Expected creation/submission failures use NeverThrow `ResultAsync`.

Creation chooses the ID, launches Pi and asks the new HostConnection to introduce
the creator. The receiving Runtime persists that introduction before positive
acknowledgement. Host creation failure does not add the attempted reference to
the creator. Runtime's successful open path is:

```text
d = connection.create(configuration)  # continue only on success
companion.introduce(d)
return d
```

Host supplies incoming introductions to Runtime, which routes them through
Companion. An incoming message is delivered only after introduction succeeds.
A storage exception can therefore become a remote rejection through the existing
handler-error path; it is not reported as a successful state change.

Runtime submission validates known destination and bounded, non-empty text,
then submits once:

```text
outcome = connection.submit(d, message)
if outcome is unavailable:
    companion.forget(d)
return outcome
```

Only unavailability causes automatic forgetting. Rejected or indeterminate
submissions retain the destination. A save error remains an exception, not a
successful forgetting or another expected transport-outcome variant.

Actions compose `open` with optional ordinary `submit`. There is no compound
Runtime operation, special first-message type, or different delivery semantics.
If submission fails after successful open, its structured outcome retains the
created reference and original typed submission failure. Pi integration renders
that partial success without claiming atomicity or rollback.

Human handlers check for an active Runtime before parsing. Structured handlers
decode action fields first, then require an active Runtime. Both invoke the same
action execution path and present errors explicitly.

## Pi lifecycle and Herdr integration

On session start, the entrypoint first clears and stops any previous Runtime.
Ordinary Pi replacement shuts down beforehand, but SDK `bindExtensions()` can
emit another start without shutdown. Clearing first prevents a stopped Runtime
from remaining accessible if replacement fails.

Construction/load must succeed before starting a candidate listener. The candidate
becomes active only after startup succeeds; failed startup performs owned cleanup
and rethrows. It does not remove a socket belonging to another listener. Shutdown
clears active before stopping the connection. In-flight opens, handlers, agent
work and submissions are not drained, resumed or replayed.

`launchHerdrConversation` directly inspects the invoking tab, selects launch-edge
placement, splits with `--no-focus`, and starts Pi with the preselected ID and
complete selection. No factory, injected launcher strategy or layout manager is
needed. Missing panes, incomplete/non-finite geometry, or an invoker outside the
reported layout fails before splitting. The generated Herdr and Pi display names
use `companion-<first-eight-ID-characters>`; they are not destination selectors.

Incoming messages use the `companion-message` custom context type with visible
sender attribution, `deliverAs: "steer"` and `triggerTurn: true`. Steering is a
local Pi delivery choice, not a wire field. It permits messages during active
work without guaranteeing immediate interruption or completed execution.

## Transport contract

The semantic interface is:

```text
listen(socketPath, handleRequest) → listener
listener.close()
exchange(socketPath, request, timeout) → acknowledgement or classified failure
```

The listener owns its server, accepted-socket set and socket path. Closing it
destroys accepted sockets, stops acceptance, closes the server and unlinks its
owned path. An incomplete frame cannot hold explicit shutdown open indefinitely.
Closing does not cancel a handler already executing.

Each connection carries one newline-delimited JSON request/response. Raw LF
terminates a frame; JSON string newlines are escaped. `FRAME_LIMIT` bounds the
encoded envelope; `MAX_MESSAGE_BYTES` separately bounds ordinary UTF-8 message
content. Escape-heavy text can satisfy the message limit and still exceed the
frame limit. Receive-side framing has no timeout.

`exchange` attempts once without replay. Its timeout covers connection and
acknowledgement waiting, not remote execution. Competing timeout, write, response,
error and close events settle the exchange once. Classification is:

| Observation | Outcome |
| --- | --- |
| Failure before connection | Unavailable |
| Valid negative acknowledgement | Rejected |
| Timeout, close, invalid/mismatched response or other failure after connection | Indeterminate |
| Matching positive acknowledgement | Accepted |

A positive acknowledgement establishes that the remote handler fulfilled and
its response reached the sender, not agent reading, completion, durability or
exactly-once execution. Lack of acknowledgement after connection cannot prove
non-delivery. HostConnection exposes these outcomes without variant-renaming;
Runtime alone decides their destination-state consequences.

Source JSDoc explains the precise framing and competing-event mechanics. These
obligations do not require a configurable transport framework or exposing every
private parser.

## Checking a change against the model

- Does it implement a model rule, Runtime policy, HostConnection operation or
  Transport guarantee at the module that owns it?
- Does it maintain independent facts that can instead be derived from one ID?
- Does it enforce a consistency guarantee the workflow does not require?
- Does it confuse identity, local introduction, or current availability?

Loss of availability does not change identity. Forgetting changes knowledge,
not the other conversation's existence. Keep those facts separate.
