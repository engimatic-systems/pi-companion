# Companion language

**Conversation**:
An independently accessible agent conversation with its own identity and history.
Creating another conversation confers neither ownership nor a different set of
Companion operations.
_Avoid_: Primary, secondary, owned worker

**Companion** (conversation model):
The conversation-local identity, destination collection, intrinsic state rules,
and persistence. It represents what the conversation knows independently of
host operations and their outcomes.
_Avoid_: Host, orchestrator

**Runtime**:
The orchestration of HostConnection operations and changes to the local Companion
model. It owns sequencing and policy for operation outcomes, including failures.
_Avoid_: Transport, conversation model

**Agent host** (or **Host**):
The shared execution environment encompassing conversations, their processes,
and communication resources. It supplies creation, execution, direct operator
interaction, and message submission.
_Avoid_: HostConnection, launcher (too narrow), process (too narrow)

**HostConnection**:
One conversation's logical access to an existing Host, held by Runtime.
Releasing that access does not destroy the conversation or the Host.
_Avoid_: Host, HostSession, HostedSession, physical transport connection

**Transport**:
The module owning communication resources and request/acknowledgement exchange.
It reports transport outcomes without deciding changes to Companion's state.
_Avoid_: HostConnection, Runtime, destination collection

**Conversation reference**:
The stable native ID identifying one conversation within the host's identity
namespace. It asserts neither availability nor authority.
_Avoid_: Transcript path, endpoint, process handle

**Introduction**:
Acquiring another conversation's reference as a local destination. Introduction
expresses knowledge, not ownership, permission, or exclusivity.
_Avoid_: Attachment, registration, ownership relationship

**Destination**:
A conversation reference retained locally for communication.
_Avoid_: ID/address pair, live peer, authorized sender

**Destination collection**:
One conversation's local set of destinations. It need not match any other
conversation's collection.
_Avoid_: Online list, access-control list, global registry

**Message**:
Ordinary content submitted to a conversation, accompanied by its sender reference
when sent from another conversation. Being first does not give a message a
different type or delivery semantics.
_Avoid_: Special brief, launch payload

**Submission acceptance**:
The host's acceptance of a message submission to the designated conversation.
Not evidence of reading, execution completion, or exactly-once processing.
_Avoid_: Task completion, durable receipt

**Availability**:
The host's ability to transport messages to a conversation at a particular time,
distinct from whether it is idle, working, or still exists.
_Avoid_: Process liveness, execution status

**Local forgetting**:
Removing a destination from one conversation's collection. It does not prohibit
future introduction or affect the other conversation's existence or history.
_Avoid_: Revocation, shutdown, persistent ignore
