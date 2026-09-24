import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Companion, conversationReference } from "../src/companion.js";

const owner = conversationReference("00000000-0000-4000-8000-000000000001");
const peer = conversationReference("00000000-0000-4000-8000-000000000003");
const thirdParty = conversationReference("00000000-0000-4000-8000-000000000004");
const testRoot = mkdtempSync(join(tmpdir(), "companion-model-"));
let nextDirectory = 0;
after(() => rmSync(testRoot, { recursive: true, force: true }));

function isolatedAgentDir(): string {
  nextDirectory += 1;
  return join(testRoot, String(nextDirectory));
}

test("Companion uses only its state directory and leaves other state untouched", () => {
  const agentDir = isolatedAgentDir();
  const oldDirectory = join(agentDir, "companion-v2");
  const oldPath = join(oldDirectory, `${owner}.json`);
  const oldContent = JSON.stringify([thirdParty]);
  mkdirSync(oldDirectory, { recursive: true });
  writeFileSync(oldPath, oldContent, "utf8");

  const companion = new Companion(owner, agentDir);
  assert.deepEqual(companion.destinations(), []);
  assert.equal(existsSync(join(agentDir, "companion", `${owner}.json`)), false);
  companion.introduce(peer);

  assert.equal(readFileSync(join(agentDir, "companion", `${owner}.json`), "utf8"),
    `${JSON.stringify([peer])}\n`);
  assert.deepEqual(new Companion(owner, agentDir).destinations(), [peer]);
  assert.equal(readFileSync(oldPath, "utf8"), oldContent);
  assert.deepEqual(readdirSync(oldDirectory), [`${owner}.json`]);
});

test("Companion persists introduction for the same ID and isolates another ID", () => {
  const agentDir = isolatedAgentDir();
  const statePath = join(agentDir, "companion", `${owner}.json`);
  const companion = new Companion(owner, agentDir);

  assert.deepEqual(companion.destinations(), []);
  assert.equal(existsSync(statePath), false);
  companion.introduce(peer);

  assert.equal(readFileSync(statePath, "utf8"), `[\"${peer}\"]\n`);
  assert.deepEqual(new Companion(owner, agentDir).destinations(), [peer]);
  assert.deepEqual(new Companion(thirdParty, agentDir).destinations(), []);
});

test("Companion loads valid references as an idempotent self-excluding set without rewriting", () => {
  const agentDir = isolatedAgentDir();
  const statePath = join(agentDir, "companion", `${owner}.json`);
  const content = JSON.stringify([thirdParty, owner, peer, thirdParty]);
  mkdirSync(join(agentDir, "companion"), { recursive: true });
  writeFileSync(statePath, content, "utf8");

  const companion = new Companion(owner, agentDir);

  assert.deepEqual(companion.destinations(), [peer, thirdParty]);
  assert.equal(readFileSync(statePath, "utf8"), content);
});

test("Companion reports malformed state with its exact path and preserves the file", () => {
  const agentDir = isolatedAgentDir();
  const statePath = join(agentDir, "companion", `${owner}.json`);
  mkdirSync(join(agentDir, "companion"), { recursive: true });
  writeFileSync(statePath, "{broken", "utf8");

  assert.throws(
    () => new Companion(owner, agentDir),
    (failure: unknown) => failure instanceof Error
      && failure.message.includes(statePath)
      && failure.cause instanceof SyntaxError
      && failure.message.includes(failure.cause.message),
  );
  assert.equal(readFileSync(statePath, "utf8"), "{broken");
});

test("Companion rejects invalid stored destination data with path and cause", () => {
  for (const content of ["{}", JSON.stringify([peer, "not safe/"])]) {
    const agentDir = isolatedAgentDir();
    const statePath = join(agentDir, "companion", `${owner}.json`);
    mkdirSync(join(agentDir, "companion"), { recursive: true });
    writeFileSync(statePath, content, "utf8");

    assert.throws(
      () => new Companion(owner, agentDir),
      (failure: unknown) => failure instanceof Error
        && failure.message.includes(statePath)
        && failure.cause instanceof Error
        && failure.message.includes(failure.cause.message),
    );
    assert.equal(readFileSync(statePath, "utf8"), content);
  }
});

test("Companion reports unreadable state with its exact path and cause", () => {
  const agentDir = isolatedAgentDir();
  const statePath = join(agentDir, "companion", `${owner}.json`);
  mkdirSync(join(agentDir, "companion"), { recursive: true });
  writeFileSync(statePath, JSON.stringify([peer]), "utf8");
  chmodSync(statePath, 0o000);
  try {
    assert.throws(
      () => new Companion(owner, agentDir),
      (failure: unknown) => failure instanceof Error
        && failure.message.includes(statePath)
        && failure.cause instanceof Error
        && "code" in failure.cause
        && failure.cause.code === "EACCES",
    );
  } finally {
    chmodSync(statePath, 0o600);
  }
});

test("Companion save failure preserves prior memory and stored state", () => {
  const agentDir = isolatedAgentDir();
  const stateDirectory = join(agentDir, "companion");
  const statePath = join(stateDirectory, `${owner}.json`);
  const companion = new Companion(owner, agentDir);
  companion.introduce(peer);
  chmodSync(stateDirectory, 0o500);
  try {
    assert.throws(
      () => companion.introduce(thirdParty),
      (failure: unknown) => failure instanceof Error
        && failure.message.includes(statePath)
        && failure.cause instanceof Error
        && failure.message.includes(failure.cause.message),
    );
  } finally {
    chmodSync(stateDirectory, 0o700);
  }

  assert.deepEqual(companion.destinations(), [peer]);
  assert.deepEqual(new Companion(owner, agentDir).destinations(), [peer]);
  assert.deepEqual(readdirSync(stateDirectory), [`${owner}.json`]);

  chmodSync(stateDirectory, 0o500);
  try {
    assert.throws(() => companion.forget(peer), (failure: unknown) => failure instanceof Error
      && failure.message.includes(statePath)
      && failure.cause instanceof Error);
  } finally {
    chmodSync(stateDirectory, 0o700);
  }
  assert.deepEqual(companion.destinations(), [peer]);
  assert.deepEqual(new Companion(owner, agentDir).destinations(), [peer]);
});

test("Companion no-op mutations do not require writable storage", () => {
  const agentDir = isolatedAgentDir();
  const stateDirectory = join(agentDir, "companion");
  const statePath = join(stateDirectory, `${owner}.json`);
  const companion = new Companion(owner, agentDir);
  companion.introduce(peer);
  const stored = readFileSync(statePath, "utf8");
  chmodSync(stateDirectory, 0o500);
  try {
    companion.introduce(peer);
    companion.introduce(owner);
    assert.equal(companion.forget(thirdParty), false);
  } finally {
    chmodSync(stateDirectory, 0o700);
  }

  assert.equal(readFileSync(statePath, "utf8"), stored);
  assert.deepEqual(readdirSync(stateDirectory), [`${owner}.json`]);
});

test("Companion owns conversation identity without a Host handle", () => {
  const companion = new Companion(owner, isolatedAgentDir());

  assert.equal(companion.reference, owner);
  assert.deepEqual(companion.destinations(), []);
});

test("Companion introduction is idempotent and excludes its own identity", () => {
  const companion = new Companion(owner, isolatedAgentDir());

  companion.introduce(thirdParty);
  companion.introduce(thirdParty);
  companion.introduce(owner);

  assert.equal(companion.has(thirdParty), true);
  assert.equal(companion.has(owner), false);
  assert.deepEqual(companion.destinations(), [thirdParty]);
});

test("Companion persists forgetting before reporting removal", () => {
  const agentDir = isolatedAgentDir();
  const companion = new Companion(owner, agentDir);
  companion.introduce(peer);

  assert.equal(companion.forget(peer), true);

  assert.deepEqual(companion.destinations(), []);
  assert.deepEqual(new Companion(owner, agentDir).destinations(), []);
});
