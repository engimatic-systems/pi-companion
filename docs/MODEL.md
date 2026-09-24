# Companion model

Companion preserves conversational context through independently accessible
conversations doing bounded work. History remains local unless information is
explicitly exchanged. Every conversation has the same operations, without
ownership roles. Terms are defined in the [glossary](GLOSSARY.md); the
[architecture](ARCHITECTURE.md) describes how this model is implemented.

## Identity and local knowledge

Let $I$ be the set of valid conversation IDs. A reference is the ID itself.
For each conversation $c \in I$, its persistent state currently contains only
its local destination collection:

```math
S_c \coloneqq \langle D_c \rangle,
\qquad D_c \subseteq I \setminus \{c\}.
```

Within the host's identity namespace, define resolved transport and state
locations:

```math
\mathrm{dest}: I \to L_{\mathrm{transport}},
\qquad \mathrm{state}: I \to L_{\mathrm{state}}.
```

$\mathrm{dest}(c)$ is where to contact $c$;
$\mathrm{state}(c)$ is where $S_c$ belongs. Both locations are derived from
identity, not independently chosen identities. Resolution establishes neither
existence, accessibility nor validity at either location. Address agreement
assumes a shared addressing convention; references confer neither authority
nor availability.

Keep three facts separate: **identity**, **local introduction**, and current
**availability**. Destination sets form a directed graph of knowledge, not an
ownership tree, access-control list or registry of running conversations.

## State transitions

Introducing $d \ne c$ to $c$, and locally forgetting it, respectively:

```math
\begin{aligned}
\mathrm{introduce}(c,d)&: S_c' = \langle D_c \cup \{d\} \rangle, \\
\mathrm{forget}(c,d)&: S_c' = \langle D_c \setminus \{d\} \rangle.
\end{aligned}
```

Introduction is idempotent; self-introduction does nothing. Forgetting changes
neither the other conversation nor its knowledge, and does not forbid later
reintroduction.

Successful creation chooses a fresh identity $d$ and introduces both peers,
with the creator as the fresh conversation's initial destination:

```math
S_c' = \langle D_c \cup \{d\} \rangle,
\qquad S_d' = \langle \{c\} \rangle.
```

Receiving a message introduces its sender before local delivery. The sender need
not already belong to the receiver's destination set. Thus a message from a
forgotten peer can introduce it again.

## Persistence and lifetime

Transitions above describe successful saves: changed knowledge is stored before
being adopted or reported as successful. A failed save leaves the prior
collection authoritative and reports the failure; it does not roll back external
effects such as a conversation already created.

$S_c$ belongs to the native identity, not one running instance or a branch of
its history. Reload and clean exit/same-ID resume load $S_c$ from
$\mathrm{state}(c)$. Missing state starts with
$S_c = \langle \varnothing \rangle$; unreadable or corrupt state is a failure,
not empty knowledge. Different identities have independent collections.

## Messaging and outcomes

For an ordinary message $m$ from $c$ to $d$, write host submission as:

```math
\mathrm{submit}(c,d,m) \rightsquigarrow o,
\qquad o \in \{\mathrm{accepted},\mathrm{unavailable},
              \mathrm{rejected},\mathrm{indeterminate}\}.
```

The public send operation requires $d \in D_c$. The notation above describes
the host exchange, not local validation or persistence failures. Optional text
after creation uses the same ordinary submission; a failed send does not undo
successful creation.

Acceptance means the host accepted the submission, not that the agent read it,
finished work, or processed it exactly once. Indeterminate delivery expresses
uncertainty at the sender; it does not imply that $S_d$ stayed unchanged.
No message is automatically replayed.

An $\mathrm{unavailable}$ outcome invokes $\mathrm{forget}(c,d)$, subject
to the persistence rule. The other outcomes cause no submission-induced change
to $D_c$. Availability can change without changing identity, and knowing a peer
does not keep it running.

## Assumptions and limits

One active instance per ID is assumed, not enforced exclusivity. Creation and
mutual introduction are not an atomic transaction: failure can leave a created
conversation running. There is no external-effect rollback, automatic relaunch,
strong crash-durability guarantee, or resumption of interrupted work. Independent
conversation histories are not a filesystem or same-user security sandbox.
