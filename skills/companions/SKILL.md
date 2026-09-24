---
name: companions
description: Use when the operator asks to work with companions or delegate bounded work to an independently accessible conversation.
---

# Companions

A companion is an independent agent conversation with its own context and history,
accessible directly by the operator. Use companions to isolate bounded work and
preserve the main conversation's context—not merely to add parallel workers.

- Give a clear objective, relevant context, target checkout, constraints, and
  expected result. State write and publication authority explicitly.
- Conversations do not share histories automatically. Exchange selected findings
  and artifact references rather than copying whole transcripts.
- Reuse an existing conversation when continuing its work. Coordinate writers;
  separate conversations are not filesystem sandboxes.
- Message acceptance is not task completion. Inspect the result and its evidence;
  do not busywait or silently extend the assignment.
- Use the available interface's documented operations. Do not assume parent/child
  roles, shared memory, liveness, or recovery guarantees.
