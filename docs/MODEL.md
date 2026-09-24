# Companion model

Companion preserves conversational context through independently accessible
conversations doing bounded work. History remains local unless information is
explicitly exchanged. Every conversation has the same operations, without
ownership roles. Terms are defined in the [glossary](GLOSSARY.md); the
[architecture](ARCHITECTURE.md) describes how this model is implemented.

## Identity and local knowledge

Let `I` be the set of valid conversation IDs. A reference is the ID itself.
Conversation `c ∈ I` has local destination knowledge:

```text
D_c ⊆ I \ {c}
```

Identity determines addressing and the key for stored knowledge; these are not
independently chosen identities. Address agreement assumes a shared addressing
convention. References confer neither authority nor availability.

Keep three facts separate: **identity**, **local introduction**, and current
**availability**. Destination sets form a directed graph of knowledge, not an
ownership tree, access-control list or registry of running conversations.

## State transitions

Introducing `d ≠ c` to `c`, and locally forgetting it, respectively:

```text
introduce(c, d):  D_c' = D_c ∪ {d}
forget(c, d):     D_c' = D_c \ {d}
```

Introduction is idempotent; self-introduction does nothing. Forgetting changes
neither the other conversation nor its knowledge, and does not forbid later
reintroduction.

Successful creation chooses a fresh identity `d` and introduces both peers:

```text
D_c' = D_c ∪ {d}
D_d' = {c}          # initial knowledge of the fresh conversation
```

Receiving a message introduces its sender before local delivery. The sender need
not already belong to the receiver's destination set. Thus a message from a
forgotten peer can introduce it again.

## Persistence and lifetime

Transitions above describe successful saves: changed knowledge is stored before
being adopted or reported as successful. A failed save leaves the prior
collection authoritative and reports the failure; it does not roll back external
effects such as a conversation already created.

Knowledge belongs to the native identity, not one running instance or a branch
of its history. Reload and clean exit/same-ID resume load that identity's stored
collection. Missing state starts empty; unreadable or corrupt state is a failure,
not empty knowledge. Different identities have independent collections.

## Messaging and outcomes

Submission targets a locally known destination. All messages are ordinary,
including optional text submitted after creation. Creation and that submission
are separate operations: a failed send does not undo successful creation.

Acceptance means the host accepted the submission, not that the agent read it,
finished work, or processed it exactly once. A failed exchange after possible
delivery can be indeterminate; no message is automatically replayed.

Reported unavailability causes local forgetting, subject to the same persistence
rule. Rejection and indeterminate delivery retain the destination. Availability
can change without changing identity, and knowing a peer does not keep it running.

## Assumptions and limits

One active instance per ID is assumed, not enforced exclusivity. Creation and
mutual introduction are not an atomic transaction: failure can leave a created
conversation running. There is no external-effect rollback, automatic relaunch,
strong crash-durability guarantee, or resumption of interrupted work. Independent
conversation histories are not a filesystem or same-user security sandbox.
