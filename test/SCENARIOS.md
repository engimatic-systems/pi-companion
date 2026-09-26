# Companion behavioral coverage

Durable coverage follows the conversation-local `Companion` model, `Runtime`
orchestration, command composition, `HostConnection` live-session access, and
the deep `Transport` module. Real Pi/Herdr behavior is checked separately with
actual package loading and owned isolated resources. See
[contribution guidance](../docs/CONTRIBUTING.md) for the test commands.

## Companion model and persistence

- Identity is local model state and requires no HostConnection.
- A missing identity-keyed state file under `<agentDir>/companion/` starts empty
  without creating a file. Other directories neither supply fallback state nor
  get rewritten or deleted.
- Introduction and forgetting synchronously replace a JSON reference array
  before adopting a real mutation in memory; same-ID construction loads it and
  another ID remains isolated.
- Introduction is idempotent and self-excluding, including duplicate/self values
  loaded from otherwise valid state; no-op mutations do not write.
- Forgetting is local; a later introduction restores the destination.
- Read, parse, validation and save failures preserve the exact state path and
  underlying cause. Corrupt input remains untouched, and failed saves leave the
  prior in-memory and stored collections authoritative without temp artifacts.
- Destination snapshots do not imply availability.

## Runtime orchestration

- Startup routes incoming HostConnection introductions to Companion; shutdown
  coordinates only connection lifecycle.
- Successful creation introduces and returns the created reference.
- Creation failure propagates without inserting the attempted reference.
- Explicit introduction changes only local state, persists before success, and
  does not contact Host; repetition and self-introduction are no-ops.
- Submission validates ordinary non-empty bounded text and excludes self-send
  before effects. An unknown reference is introduced and saved locally before
  one Host submission; failed persistence blocks submission.
- Host-reported unavailability forgets only that destination, including one
  first introduced by this send.
- Rejected or indeterminate submission retains the destination, including one
  first introduced by this send, and is not replayed.

## Human command language

- Human command parsing exposes the same `open`, `list`, `send`, and `forget`
  action shapes used by structured input.
- Ordinary open text remains one literal message, including internal/trailing
  whitespace, newlines, quotes, backslashes, and embedded option-looking text.
- A leading-hyphen open tail uses strict native `parseArgs` option grammar;
  separated and equals forms work, standalone `--` starts one literal message,
  and missing delimiters, unknown/duplicate/valueless options, invalid levels,
  and extra arguments fail.
- Send retains its exact destination token and untouched literal message tail;
  list and forget enforce their fixed arity without shell tokenization.

## Actions and launch selection

- One canonical per-action schema derives the TypeScript action type and rejects
  structured fields that are illegal for the selected action. `introduce` requires
  a valid reference, with no message or launch selection; `send` validates its
  supplied reference and no longer requires existing local knowledge. Pi still
  advertises the existing broader flattened tool parameter object.
- Human and structured open actions resolve through the same execution path.
- Open without text invokes ordinary `Runtime.open` and does not submit. Open
  with text stops on creation failure; after successful creation it invokes
  ordinary `Runtime.submit`.
- Failure after successful creation preserves both the created reference and the
  original typed submission failure in the structured action outcome.
- Omitted provider, model, and thinking independently inherit invoking values.
  Provider-only, model-only, thinking-only, and complete overrides resolve one
  exact configuration without changing the invoking selection.
- Unknown and registered-but-unavailable final model pairs are distinct errors.
  The final thinking level, including `max`, must be supported by that model and
  is never silently clamped.
- Missing invoking selection and every malformed or unsupported selection fail
  before `Runtime.open`, so no Host launch effect occurs.

## Pi integration

- Registration exposes exactly the `companion` human command and structured
  tool, with the advertised schema and notification/tool-response rendering.
  The tool accepts and renders local `introduce`; the human parser is unchanged.
- Human handling checks for an active Runtime before parsing. Structured handling
  validates the canonical action before reporting an inactive Runtime.
- Human parsing and structured decoding both invoke the same action execution;
  Pi integration owns presentation rather than action meaning.

## Pi lifecycle and persisted state

- Startup, reload, new, fork, and same-ID resume use ordinary Companion
  construction and load that ID's state without launching a replacement.
- Clean shutdown and reload stop the current listener. Transcript entries
  neither supply destination state nor receive persistence writes.
- Repeated reload retains ordinary and inbound introductions while preserving
  stored local forgetting; ordinary messages and steering continue after
  rebinding the same identity.
- A different native ID addresses a different state file and does not inherit
  destinations.
- Corrupt state prevents Runtime/listener activation with its exact path and
  cause, while preserving the bad file. Listener bind failure cleans its
  candidate and leaves stored knowledge unchanged.
- Incoming introduction persists before attributed Pi delivery. Isolated
  two-conversation composition shows explicit introduction changes only the
  sender's state; reciprocal knowledge arises on ordinary receipt, and a reply
  can follow without another introduction exchange.
- Persistence makes no fsync/crash-recovery, concurrent same-ID writer, locking,
  journal, repair, replay, supervision, or peer-relaunch guarantee.

## Pi delivery

- Incoming ordinary messages retain visible sender attribution.
- Delivery uses Pi steering with turn triggering.
- Steering can affect active work but does not promise immediate interruption,
  completed execution, persistence, or exactly-once processing.

## HostConnection

- One preselected native ID drives direct Herdr launch, Pi `--session-id`, and
  derived socket addressing.
- Local setup resolves one `tmpdir()` socket root and derives full-ID paths under
  the private `pi-cmp-<uid>` directory. The shared Linux/macOS 103-byte UTF-8
  pathname guard accepts 103, rejects 104 (including multibyte roots), and
  allows the reported macOS temporary root with a full native ID.
- Address resolution agrees between sender and receiver; owned sockets are
  removed on shutdown and the per-user directory retains private permissions.
- Successful creation introduces the creator at the created Runtime before
  returning its reference.
- Incoming messages introduce unknown senders before local Pi delivery;
  references are not an access-control list.
- One-pane launch splits the invoker right without taking focus.
- Multi-pane launch splits the first returned pane right of the leftmost pane
  down, or uses the invoker/down fallback, without taking focus.
- Missing panes, malformed geometry, and an absent invoker fail before split.
- Partial creation reports failure without rollback or relaunch.
- Inactive creation fails without launching.

## Transport

- Listener creation and cleanup own the socket path and accepted sockets.
- Explicit close destroys incomplete accepted connections and removes the owned
  path.
- Requests and acknowledgements use bounded newline-delimited JSON framing.
- Matching acknowledgement accepts only the submitted operation.
- A valid negative acknowledgement is rejected.
- Pre-connect failure is unavailable.
- Post-connect timeout, close, malformed/oversized response, or other uncertainty
  is indeterminate and never replayed.

## Package consumption

- A real Pi process discovers `src/index.ts` through the package manifest,
  registering exactly the Companion command and tool from that entrypoint.
- The same package supplies `skills/companions/SKILL.md`, discovered as
  `skill:companions` with that file's provenance and no external skill dependency.
- Root test scripts include strict typechecking, behavior tests and the real
  package-discovery seam.
- A standalone production checkout resolves its runtime dependencies at the
  package root while Pi supplies its documented core peer packages.

## Real Pi/Herdr behavior

Owned isolated checks cover:

- root-package loading with the default socket root;
- exact native IDs and ID-derived sockets;
- one-pane right placement and right-hand downward placement with preserved
  focus;
- direct access and mutual introduction;
- steering an attributed incoming message into active work;
- ordinary message submission and processing;
- a selected child launch tuple with the invoking tuple unchanged;
- representative selection preflight rejection without pane creation;
- local forgetting retained through reload, then ordinary reintroduction;
- clean exit/same-ID resume with retained destinations and no replacement peer;
- listener removal, unavailable classification, and local forgetting; and
- cleanup of owned workspaces, sessions, panes, and sockets.

Custom parent/child `TMPDIR` disagreement is unsupported and is not treated as a
successful integration configuration.
