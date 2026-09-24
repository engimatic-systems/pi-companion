# Companion

Companion creates independently accessible Pi conversations for bounded work,
without merging their histories. Each conversation can create peers, remember
their references, and exchange ordinary messages. The operator can interact
with every conversation directly.

## Install

The supported baseline is **Pi 0.85.1**, **Herdr 0.9.0**, and **Node.js 22**.
Conversation creation requires Pi running inside Herdr and an available,
authenticated Pi model.

```sh
git clone https://github.com/engimatic-systems/pi-companion.git
cd pi-companion
npm ci --omit=dev
pi install "$PWD"
pi
```

Pi registers the local checkout as a package; it does not copy it or prepare its
dependencies. Keep that checkout at the revision you intend to run. Restart or
reload Pi after changing it. The package exposes the `/companion` command and
`companion` tool. It also includes the [companions skill](skills/companions/SKILL.md)
for scoping delegated work, exchanging selected context, and checking results.
Pi discovers it with the package; invoke `/skill:companions` to load it explicitly.

A local directory passed to `--extension` does not consume its package manifest.
Use `pi install` for the checkout. `--no-extensions` disables installed packages.
Created conversations instead load this package's exact source entrypoint with
`--no-extensions --extension <entrypoint>`, so unrelated extensions are not
automatically loaded in them.

## Use

```text
/companion open
/companion open Review this interface and report what matters.
/companion list
/companion send <conversation-id> Consider the failure path too.
/companion forget <conversation-id>
```

The agent has the same `open`, `list`, `send`, and `forget` actions through the
`companion` tool. Destinations are selected by their exact native Pi session IDs,
not local names.

Opening a conversation introduces both peers. Every incoming message introduces
its sender before delivery to local Pi. Introductions are idempotent. Forgetting
is local: it does not stop the other conversation, delete its history, or prevent
a later message from introducing it again. Destination knowledge is not an
access-control list or evidence of availability.

Optional text on `open` is submitted after creation through the ordinary message
path. No transcript history is implicitly copied. Messages appear with sender
attribution and use Pi steering with turn triggering, including during active
work. Acceptance means submission was accepted, not that the agent read it,
completed a turn, or processed it exactly once.

### Launch selection and literal text

```text
/companion open --thinking high -- Review this interface.
/companion open --provider openai-codex --model gpt-5.6-sol --thinking high -- Review the failure path.
/companion open --thinking=high
/companion open -- --model is literal message text here.
```

Each omitted provider, model, or thinking field independently inherits the
invoking conversation's value. The working directory is also inherited. A
model-only override uses the current provider and thinking level; it does not
reset thinking. Selection affects only the new conversation.

The exact provider/model pair must be registered and available. Thinking must
be supported by that model; the full token vocabulary is
`off|minimal|low|medium|high|xhigh|max`. Invalid selections fail before any pane
is created, without fuzzy matching or silent clamping. The structured tool
accepts the same optional fields only for `open` and uses the same selection
rules.

`open Review --thinking high` treats everything after `open` as literal message
text. A tail starting with `-` enters option mode: options accept separated or
equals-form values, and a standalone `--` must precede any message. Unknown,
duplicate and valueless options are errors.

Separating whitespace belongs to the grammar. Once a message starts, its
internal and trailing whitespace, newlines, quotes and backslashes are literal.
There is no shell quoting or expansion. `send` likewise preserves the message
after its destination token.

### Pane placement

Creation splits a one-pane tab to the right without taking focus. With multiple
panes it splits the first returned pane geometrically right of the leftmost pane
down; if none is to the right, it splits the invoker down. Invalid geometry fails
before splitting. Companion does not subsequently rearrange or clean up panes.

## Stored destinations

Each conversation stores its destination references in:

```text
<getAgentDir()>/companion/<native-session-id>.json
```

This is normally `~/.pi/agent/companion/`. Pi's configured agent directory is
respected. Startup, `/reload`, and resuming the same native ID after exit load
the same collection; another ID has a separate file.

A missing file means empty state. Unreadable or corrupt state throws with its
exact path and underlying error instead of silently starting empty. Introductions
and forgetting save synchronously before succeeding; a failed save does not
adopt the proposed change in memory. Inspect the reported path when diagnosing
storage failures.

Saves replace the file through a temporary sibling file. There are no locks,
retries, journals or automatic repairs, and no strong crash-durability guarantee.
Concurrent instances of the same ID are unsupported. Synchronous I/O can briefly
block Pi.

## Failures and limits

- Creation can fail after launching a Pi process or pane. It may remain; no
  rollback or automatic relaunch is attempted. If the optional message fails
  after successful creation, the result retains the created reference.
- Submission failure before connection is unavailable and causes local forgetting.
  A rejected submission or failure after connection retains the destination;
  delivery after connection can be indeterminate. Messages are never replayed
  automatically. Storage errors can prevent a requested forgetting operation.
- Peers may forget a conversation they find unavailable during downtime. Stored
  knowledge does not keep peers running, resume interrupted work, or reclaim
  stale sockets.
- All participants must resolve the same `tmpdir()` socket root. A custom
  `TMPDIR` is not forwarded through Herdr launch; different parent/child roots
  are unsupported and can cause failure after launch.
- There is no process supervision, event bridge, local naming, persistent
  extension settings, or isolation from hostile code running as the same user.

## Disable

Exit participating Pi sessions and remove the package's exact registration:

```sh
pi remove /absolute/path/to/pi-companion
```

Shutdown releases each conversation's listener. Removing the registration does
not stop already running peer conversations, close their panes, or delete
stored destinations. If removing it while Pi is running, reload or restart that
Pi instance to unload it.

## Development

```sh
npm ci
npm test
```

Tests include strict typechecking, behavior tests, and real Pi package discovery.
Further reading:

- [MODEL.md](docs/MODEL.md): the small semantic model and its limits.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): modules and host integration.
- [GLOSSARY.md](docs/GLOSSARY.md): authoritative vocabulary.
- [CONTRIBUTING.md](docs/CONTRIBUTING.md): development setup, tests and review.
- [STYLE_GUIDE.md](docs/STYLE_GUIDE.md): implementation and documentation practices.
