import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { errAsync, okAsync, ResultAsync } from "neverthrow";

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
  introduction: ResultAsync<void, SubmissionFailure> = okAsync(undefined);
  readonly introductions: ConversationReference[] = [];
  #introduce?: (reference: ConversationReference) => void;

  async start(onIntroduction: (reference: ConversationReference) => void): Promise<void> {
    this.#introduce = onIntroduction;
  }

  create(_configuration: ConversationConfiguration): ResultAsync<ConversationReference, CreationFailure> {
    return this.creation;
  }

  introduce(destination: ConversationReference): ResultAsync<void, SubmissionFailure> {
    this.introductions.push(destination);
    return this.introduction;
  }

  submit(
    destination: ConversationReference,
    message: string,
  ): ResultAsync<SubmissionAcceptance, SubmissionFailure> {
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

test("explicit introduction persists after acknowledgement and re-exchanges on repetition", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);
  let accept!: () => void;
  host.introduction = ResultAsync.fromSafePromise(new Promise<void>((resolve) => { accept = resolve; }));

  const pending = runtime.introduce(peer);
  assert.deepEqual(companion.destinations(), []);
  accept();
  assert.equal((await pending).isOk(), true);
  assert.equal((await runtime.introduce(peer)).isOk(), true);
  assert.deepEqual(companion.destinations(), [peer]);
  assert.deepEqual(host.introductions, [peer, peer]);
});

test("explicit self-introduction does not exchange or retain self", async () => {
  const host = new TestHostConnection();
  const runtime = new Runtime(new Companion(owner), host);
  assert.equal((await runtime.introduce(owner)).isOk(), true);
  assert.deepEqual(runtime.destinations(), []);
  assert.deepEqual(host.introductions, []);
});

for (const failure of [
  { kind: "unavailable", message: "not listening" } as const,
  { kind: "rejected", code: "save_failed", message: "not saved" } as const,
  { kind: "indeterminate", message: "acknowledgement lost" } as const,
]) {
  test(`explicit ${failure.kind} introduction leaves known and unknown destinations unchanged`, async () => {
    const host = new TestHostConnection();
    host.introduction = errAsync(failure);
    const companion = new Companion(owner);
    companion.introduce(peer);
    const runtime = new Runtime(companion, host);
    for (const destination of [peer, thirdParty]) {
      const result = await runtime.introduce(destination);
      assert.equal(result.isErr() && result.error, failure);
      assert.deepEqual(companion.destinations(), [peer]);
    }
    assert.deepEqual(host.introductions, [peer, thirdParty]);
  });
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

test("Runtime rejects a destination absent from Companion state", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  const runtime = new Runtime(companion, host);

  const result = await runtime.submit(peer, "hello");

  assert.equal(result.isErr() && result.error.kind, "unknown_destination");
  assert.deepEqual(companion.destinations(), []);
});

test("Runtime forgets only the destination Host reports unavailable", async () => {
  const host = new TestHostConnection();
  const companion = new Companion(owner);
  companion.introduce(peer);
  companion.introduce(thirdParty);
  host.submission = errAsync({ kind: "unavailable", message: "not listening" });
  const runtime = new Runtime(companion, host);

  const result = await runtime.submit(peer, "hello");

  assert.equal(result.isErr() && result.error.kind, "unavailable");
  assert.deepEqual(companion.destinations(), [thirdParty]);
});

for (const failure of [
  { kind: "indeterminate", message: "possibly written" } as const,
  { kind: "rejected", code: "busy", message: "not accepted" } as const,
]) {
  test(`Runtime retains a destination after ${failure.kind} submission`, async () => {
    const host = new TestHostConnection();
    host.submission = errAsync(failure);
    const companion = new Companion(owner);
    companion.introduce(peer);
    const runtime = new Runtime(companion, host);

    const result = await runtime.submit(peer, "hello");

    assert.equal(result.isErr() && result.error.kind, failure.kind);
    assert.deepEqual(companion.destinations(), [peer]);
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
