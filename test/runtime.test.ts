import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import {
  Companion as PersistentCompanion,
  conversationReference,
  type ConversationReference,
} from "../src/companion.js";
import {
  MAX_MESSAGE_BYTES,
  type ConversationConfiguration,
  type CreationFailure,
  type HostConnection,
  type SubmissionAcceptance,
  type SubmissionFailure,
} from "../src/host.js";
import { Runtime } from "../src/runtime.js";

const testRoot = mkdtempSync(join(tmpdir(), "companion-runtime-"));
let nextDirectory = 0;
after(() => rmSync(testRoot, { recursive: true, force: true }));

class Companion extends PersistentCompanion {
  constructor(reference: ConversationReference) {
    nextDirectory += 1;
    super(reference, join(testRoot, String(nextDirectory)));
  }
}

const owner = conversationReference("20000000-0000-4000-8000-000000000001");
const created = conversationReference("20000000-0000-4000-8000-000000000002");
const peer = conversationReference("20000000-0000-4000-8000-000000000003");
const thirdParty = conversationReference("20000000-0000-4000-8000-000000000004");
const configuration: ConversationConfiguration = {
  cwd: "/work",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "high",
};

class TestHostConnection implements HostConnection {
  readonly reference = owner;
  creation: ResultAsync<ConversationReference, CreationFailure> = okAsync(created);
  submission: ResultAsync<SubmissionAcceptance, SubmissionFailure> = okAsync({ status: "accepted" });
  expectedSubmission?: { destination: ConversationReference; message: string };
  submissions = 0;
  onSubmission?: () => void;
  #introduce?: (reference: ConversationReference) => void;

  async start(onIntroduction: (reference: ConversationReference) => void): Promise<void> {
    this.#introduce = onIntroduction;
  }

  create(_configuration: ConversationConfiguration): ResultAsync<ConversationReference, CreationFailure> {
    return this.creation;
  }

  submit(
    destination: ConversationReference,
    message: string,
  ): ResultAsync<SubmissionAcceptance, SubmissionFailure> {
    this.submissions += 1;
    this.onSubmission?.();
    if (this.expectedSubmission
        && (destination !== this.expectedSubmission.destination || message !== this.expectedSubmission.message)) {
      return errAsync({ kind: "rejected", code: "unexpected", message: "Unexpected ordinary submission." });
    }
    return this.submission;
  }

  async stop(): Promise<void> {
    this.#introduce = undefined;
  }

  receiveFrom(reference: ConversationReference): void {
    assert.ok(this.#introduce, "test Host must be started");
    this.#introduce(reference);
  }
}

test("Runtime introduces and returns a successfully created conversation", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);

  const result = await runtime.open(configuration);

  assert.equal(result.isOk() && result.value, created);
  assert.deepEqual(companion.destinations(), [created]);
});

test("Runtime leaves an attempted reference unknown after creation failure", async () => {
  const host = new TestHostConnection();
  host.creation = errAsync({
    kind: "creation_failed",
    attemptedReference: created,
    message: "Introduction did not finish; a process may remain.",
  });
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);

  const result = await runtime.open(configuration);

  assert.equal(result.isErr() && result.error.attemptedReference, created);
  assert.deepEqual(companion.destinations(), []);
});

for (const [description, message] of [
  ["empty", ""],
  ["oversized", "x".repeat(MAX_MESSAGE_BYTES + 1)],
] as const) {
  test(`Runtime rejects ${description} ordinary text before Host submission`, async () => {
    const host = new TestHostConnection();
    const companion = new Companion(owner);
    companion.introduce(peer);
    const runtime = new Runtime(companion, host);

    const result = await runtime.submit(peer, message);

    assert.equal(result.isErr() && result.error.kind, "invalid_message");
    assert.deepEqual(companion.destinations(), [peer]);
  });
}

test("Runtime returns Host acceptance for ordinary submission to a known destination", async () => {
  const host = new TestHostConnection();
  host.expectedSubmission = { destination: peer, message: "hello" };
  const companion = new Companion(owner);
  companion.introduce(peer);
  const runtime = new Runtime(companion, host);

  const result = await runtime.submit(peer, "hello");

  assert.equal(result.isOk() && result.value.status, "accepted");
  assert.deepEqual(companion.destinations(), [peer]);
});

test("explicit introduction persists locally without Host effects; repeat and self are no-ops", () => {
  const host = new TestHostConnection();
  const agentDir = join(testRoot, "explicit-introduction");
  const companion = new PersistentCompanion(owner, agentDir);
  const runtime = new Runtime(companion, host);
  runtime.introduce(owner);
  assert.deepEqual(companion.destinations(), []);
  runtime.introduce(peer);
  const path = join(agentDir, "companion", `${owner}.json`);
  assert.equal(readFileSync(path, "utf8"), `["${peer}"]\n`);
  chmodSync(join(agentDir, "companion"), 0o500);
  try {
    runtime.introduce(peer);
    runtime.introduce(owner);
  } finally {
    chmodSync(join(agentDir, "companion"), 0o700);
  }
  assert.deepEqual(new PersistentCompanion(owner, agentDir).destinations(), [peer]);
  assert.equal(host.submissions, 0);
});

test("Runtime introduces an unknown reference on disk before ordinary Host submission", async () => {
  const host = new TestHostConnection();
  const agentDir = join(testRoot, "send-unknown");
  const companion = new PersistentCompanion(owner, agentDir);
  const runtime = new Runtime(companion, host);
  host.expectedSubmission = { destination: peer, message: "hello" };
  host.onSubmission = () => {
    assert.deepEqual(companion.destinations(), [peer]);
    assert.deepEqual(new PersistentCompanion(owner, agentDir).destinations(), [peer]);
  };

  const result = await runtime.submit(peer, "hello");

  assert.equal(result.isOk() && result.value.status, "accepted");
  assert.equal(host.submissions, 1);
});

test("invalid text and self-send leave an unknown reference unintroduced and do not submit", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);

  const invalid = await runtime.submit(peer, "");
  const oversized = await runtime.submit(peer, "x".repeat(MAX_MESSAGE_BYTES + 1));
  const self = await runtime.submit(owner, "hello");

  assert.equal(invalid.isErr() && invalid.error.kind, "invalid_message");
  assert.equal(oversized.isErr() && oversized.error.kind, "invalid_message");
  assert.equal(self.isErr() && self.error.kind, "self_send");
  assert.deepEqual(companion.destinations(), []);
  assert.equal(host.submissions, 0);
});

test("failed local save blocks submission and preserves path and cause", () => {
  const host = new TestHostConnection();
  const agentDir = join(testRoot, "send-failed-save");
  const directory = join(agentDir, "companion");
  const companion = new PersistentCompanion(owner, agentDir);
  const runtime = new Runtime(companion, host);
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o500);
  try {
    assert.throws(() => runtime.submit(peer, "hello"), (failure: unknown) => failure instanceof Error
      && failure.message.includes(join(directory, `${owner}.json`))
      && failure.cause instanceof Error);
    assert.deepEqual(companion.destinations(), []);
    assert.equal(host.submissions, 0);
  } finally {
    chmodSync(directory, 0o700);
  }
});

test("Runtime forgets only the newly introduced destination Host reports unavailable", async () => {
  const host = new TestHostConnection();
  const agentDir = join(testRoot, "send-unavailable");
  const companion = new PersistentCompanion(owner, agentDir);
  companion.introduce(thirdParty);
  host.submission = errAsync({ kind: "unavailable", message: "not listening" });
  host.onSubmission = () => {
    assert.deepEqual(new PersistentCompanion(owner, agentDir).destinations(), [peer, thirdParty]);
  };
  const runtime = new Runtime(companion, host);

  const result = await runtime.submit(peer, "hello");

  assert.equal(result.isErr() && result.error.kind, "unavailable");
  assert.deepEqual(companion.destinations(), [thirdParty]);
  assert.deepEqual(new PersistentCompanion(owner, agentDir).destinations(), [thirdParty]);
  assert.equal(host.submissions, 1);
});

for (const failure of [
  { kind: "indeterminate", message: "possibly written" } as const,
  { kind: "rejected", code: "busy", message: "not accepted" } as const,
]) {
  test(`Runtime retains a destination after ${failure.kind} submission`, async () => {
    const host = new TestHostConnection();
    host.submission = errAsync(failure);
    const agentDir = join(testRoot, `send-${failure.kind}`);
    const companion = new PersistentCompanion(owner, agentDir);
    const runtime = new Runtime(companion, host);

    const result = await runtime.submit(peer, "hello");

    assert.equal(result.isErr() && result.error.kind, failure.kind);
    assert.deepEqual(companion.destinations(), [peer]);
    assert.deepEqual(new PersistentCompanion(owner, agentDir).destinations(), [peer]);
    assert.equal(host.submissions, 1);
  });
}

test("Runtime routes repeated incoming Host notices through idempotent introduction", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);
  await runtime.start();

  host.receiveFrom(thirdParty);
  host.receiveFrom(thirdParty);

  assert.deepEqual(companion.destinations(), [thirdParty]);
});

test("Runtime shutdown stops Host delivery without changing local destinations", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  companion.introduce(peer);
  const runtime = new Runtime(companion, host);
  await runtime.start();

  await runtime.stop();

  assert.throws(() => host.receiveFrom(thirdParty), /must be started/u);
  assert.deepEqual(companion.destinations(), [peer]);
});

test("Runtime reintroduces a locally forgotten sender on a later Host notice", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);
  await runtime.start();
  host.receiveFrom(peer);
  assert.equal(companion.forget(peer), true);

  host.receiveFrom(peer);

  assert.deepEqual(companion.destinations(), [peer]);
});
