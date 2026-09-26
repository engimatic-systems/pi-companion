# Companion model

Companion preserves conversational context through independently accessible
conversations doing bounded work. History remains local unless information is
explicitly exchanged. Every conversation has the same operations, without
ownership roles. Terms are defined in the [glossary](GLOSSARY.md); the
[architecture](ARCHITECTURE.md) describes how this model is implemented.

## Identity and local knowledge

Let $C$ be the set of conversations and $I$ the set of valid identifiers.
Each conversation $c \in C$ has a unique identifier $c_i \in I$. The subscript
$i$ means "identifier," not a sequence index. A reference is an identifier,
not the conversation itself.

Conversation $c$ maintains its own local destination knowledge:

```math
D_c \subseteq I \setminus \{c_i\}.
```

Within the host's identity namespace, define resolved transport and state
locations:

```math
\mathrm{dest}: I \to L_{\mathrm{transport}},
\qquad \mathrm{state}: I \to L_{\mathrm{state}}.
```

$\mathrm{dest}(c_i)$ is where to contact $c$;
$\mathrm{state}(c_i)$ is its persistent-state location. Both locations are
derived from $c_i$, not independently maintained facts. Resolution establishes
neither existence, accessibility nor validity at either location. Address
agreement assumes a shared addressing convention; references confer neither
authority nor availability.

Keep three facts separate: **identity**, **local introduction**, and current
**availability**. Destination sets form a directed graph of knowledge, not an
ownership tree, access-control list or registry of running conversations.
For $c,d \in C$, knowing $d_i \in D_c$ establishes neither $c_i \in D_d$ nor
the current availability of $d$.

## Model operations

For a reference $r \in I$ with $r \ne c_i$, model operations determine the
next destination collection $D_c'$:

```math
\begin{aligned}
\mathrm{introduce}(c,r)&: D_c' = D_c \cup \{r\}, \\
\mathrm{forget}(c,r)&: D_c' = D_c \setminus \{r\}.
\end{aligned}
```

Introduction is idempotent; self-introduction does nothing. Explicit introduction
changes only local knowledge: it does not contact the referenced conversation
or establish reciprocal knowledge. Forgetting changes neither the other
conversation nor its knowledge, and does not forbid later reintroduction.

Successful creation of conversation $d$ chooses a fresh identifier $d_i$ and
introduces both peers, with the creator as the new conversation's initial
destination:

```math
D_c' = D_c \cup \{d_i\},
\qquad D_d' = \{c_i\}.
```

Receiving a message from $c$ at $d$ invokes $\mathrm{introduce}(d,c_i)$ before
local delivery. The sender's identifier need not already belong to $D_d$.
Thus a message from a forgotten peer can introduce it again.

## Persistence and lifetime

Let $P_c$ denote the persistent representation belonging to $c$. It currently
contains only destination knowledge, derived from the model rather than chosen
independently:

```math
P_c = \langle D_c \rangle.
```

For a proposed model change $D_c'$, the corresponding representation is:

```math
P_c' = \langle D_c' \rangle.
```

Store $P_c'$ successfully at $\mathrm{state}(c_i)$ before adopting $D_c'$ or
reporting the change as successful. A failed save leaves the previous model
state authoritative and reports the failure; it does not roll back external
effects such as a conversation already created.

Stored knowledge is keyed by $c_i$, not one running instance or a branch of its
history. Reload and clean exit/same-ID resume recover $D_c$ from $P_c$ at
$\mathrm{state}(c_i)$. Missing state starts with $D_c = \varnothing$; unreadable
or corrupt state is a failure, not empty knowledge. Different identities have
independent collections.

## Messaging and outcomes

For an ordinary message $m$ from $c \in C$ to reference $r \in I$, write host
submission as:

```math
\mathrm{submit}(c,r,m) \rightsquigarrow o,
\qquad o \in \{\mathrm{accepted},\mathrm{unavailable},
              \mathrm{rejected},\mathrm{indeterminate}\}.
```

The public send operation validates the reference and message, excludes self-send,
then composes $\mathrm{introduce}(c,r)$ with the host submission above. The
reference need not already belong to $D_c$. Introduction must succeed under the
persistence rule before submission is attempted; invalid requests have no effects.
The notation above describes the host exchange, not local validation or
persistence failures. Optional text after creation uses the same ordinary
submission; a failed send does not undo successful creation.

Acceptance means the host accepted the submission, not that the agent read it,
finished work, or processed it exactly once. Indeterminate delivery expresses
uncertainty at the sender; it does not imply that the receiver's model or
persistent state stayed unchanged. No message is automatically replayed.

An $\mathrm{unavailable}$ outcome invokes $\mathrm{forget}(c,r)$, subject
to the persistence rule. The other outcomes cause no further submission-induced
change to $D_c$. Availability can change without changing identity, and knowing
a peer does not keep it running.

## Assumptions and limits

One active instance per ID is assumed, not enforced exclusivity. Creation and
mutual introduction are not an atomic transaction: failure can leave a created
conversation running. There is no external-effect rollback, automatic relaunch,
strong crash-durability guarantee, or resumption of interrupted work. Independent
conversation histories are not a filesystem or same-user security sandbox.
