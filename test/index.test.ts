import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  Companion as PersistentCompanion,
  conversationReference,
  type ConversationReference,
} from "../src/companion.js";
import {
  conversationSocketPath,
  createHostConnection,
} from "../src/host.js";
import companionExtension from "../src/index.js";

const testRoot = mkdtempSync(join(tmpdir(), "companion-index-"));
let nextDirectory = 0;
after(() => rmSync(testRoot, { recursive: true, force: true }));

function isolatedAgentDir(): string {
  nextDirectory += 1;
  return join(testRoot, String(nextDirectory));
}

const owner = conversationReference("30000000-0000-4000-8000-000000000001");
const created = conversationReference("30000000-0000-4000-8000-000000000002");

type LifecycleReason = "startup" | "reload" | "new" | "resume" | "fork";
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (raw: string, ctx: ExtensionContext) => unknown;
type ToolHandler = (
  id: string,
  input: unknown,
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: ExtensionContext,
) => unknown;

interface CommandRegistration {
  description: string;
  handler: CommandHandler;
}

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: ToolHandler;
}

interface TestSessionEntry {
  type: "custom";
  customType: string;
  data: unknown;
  id: string;
  parentId: string | null;
  timestamp: string;
}

class TestSessionState {
  readonly entries: TestSessionEntry[] = [];
  #nextAppendError: Error | undefined;

  failNextAppend(error: Error): void {
    this.#nextAppendError = error;
  }

  append(customType: string, data: unknown): void {
    const previous = this.entries.at(-1);
    this.entries.push({
      type: "custom",
      customType,
      data,
      id: `entry-${this.entries.length + 1}`,
      parentId: previous?.id ?? null,
      timestamp: new Date().toISOString(),
    });
    const error = this.#nextAppendError;
    this.#nextAppendError = undefined;
    if (error) throw error;
  }
}

class PiLifecycleHarness {
  readonly events = new Map<string, EventHandler>();
  readonly commands = new Map<string, CommandRegistration>();
  readonly tools = new Map<string, ToolRegistration>();
  readonly notifications: Array<{ message: string; type: string }> = [];
  readonly deliveries: Array<{ message: unknown; options: unknown }> = [];
  readonly execCalls: string[][] = [];
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;

  constructor(
    readonly reference: ConversationReference,
    readonly state: TestSessionState,
    readonly agentDir = isolatedAgentDir(),
  ) {
    this.api = {
      on: (event: string, handler: EventHandler) => { this.events.set(event, handler); },
      registerCommand: (name: string, options: unknown) => {
        this.commands.set(name, options as CommandRegistration);
      },
      registerTool: (options: unknown) => {
        const tool = options as ToolRegistration;
        this.tools.set(tool.name, tool);
      },
      appendEntry: (customType: string, data: unknown) => { this.state.append(customType, data); },
      sendMessage: (message: unknown, options: unknown) => { this.deliveries.push({ message, options }); },
      exec: async (_command: string, args: string[]) => {
        this.execCalls.push(args);
        throw new Error("Session startup must not launch a conversation.");
      },
    } as unknown as ExtensionAPI;
    this.context = {
      sessionManager: {
        getSessionId: () => this.reference,
        getBranch: () => this.state.entries,
      },
      ui: {
        notify: (message: string, type: string) => { this.notifications.push({ message, type }); },
      },
    } as unknown as ExtensionContext;
    companionExtension(this.api, this.agentDir);
  }

  async start(reason: LifecycleReason): Promise<void> {
    await this.events.get("session_start")?.({ type: "session_start", reason }, this.context);
  }

  async shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> {
    await this.events.get("session_shutdown")?.({ type: "session_shutdown", reason }, this.context);
  }

  async command(raw: string): Promise<void> {
    const registration = this.commands.get("companion");
    assert.ok(registration);
    await registration.handler(raw, this.context);
  }

  async tool(input: unknown): Promise<unknown> {
    const registration = this.tools.get("companion");
    assert.ok(registration);
    return registration.execute(
      "test-call", input, new AbortController().signal, undefined, this.context,
    );
  }
}

test("Pi exposes the Companion command and tool", () => {
  const harness = new PiLifecycleHarness(owner, new TestSessionState());

  assert.deepEqual([...harness.commands.keys()], ["companion"]);
  assert.deepEqual([...harness.tools.keys()], ["companion"]);
});

test("Pi registration preserves metadata and inactive-input error precedence", async () => {
  const harness = new PiLifecycleHarness(owner, new TestSessionState());
  const command = harness.commands.get("companion");
  const tool = harness.tools.get("companion");
  assert.ok(command);
  assert.ok(tool);

  assert.equal(command.description,
    "Create, introduce, list, message, or locally forget Companion conversations.");
  assert.equal(tool.label, "Companion");
  assert.equal(tool.description,
    "Create a live conversation, introduce an existing conversation by destination, list local destinations, submit an ordinary message, or forget locally.");
  assert.equal(Check(tool.parameters, { action: "introduce", destination: created }), true);
  assert.equal(Check(tool.parameters, { action: "list", model: "advertised-but-illegal" }), true);

  await harness.command("not-a-command");
  assert.deepEqual(harness.notifications.at(-1), {
    message: "Companion Runtime is not active for this conversation.",
    type: "error",
  });
  const invalid = await harness.tool({ action: "list", model: "advertised-but-illegal" }) as {
    details: { status: string; message: string };
  };
  assert.deepEqual(invalid.details, {
    status: "error",
    message: "Invalid Companion action fields.",
  });
  const inactive = await harness.tool({ action: "list" }) as {
    details: { status: string; message: string };
  };
  assert.deepEqual(inactive.details, {
    status: "error",
    message: "Companion Runtime is not active for this conversation.",
  });
});

test("explicit introductions connect independent conversations without launch or Pi delivery", async () => {
  const left = new PiLifecycleHarness(owner, new TestSessionState());
  const right = new PiLifecycleHarness(created, new TestSessionState());
  await left.start("startup");
  await right.start("startup");
  const known = (h: PiLifecycleHarness) => new PersistentCompanion(h.reference, h.agentDir).destinations();
  mkdirSync(join(left.agentDir, "companion"), { recursive: true });
  mkdirSync(join(right.agentDir, "companion"), { recursive: true });
  try {
    await left.command(`introduce ${created}`);
    assert.deepEqual(left.notifications.at(-1), {
      message: `Conversations ${owner} and ${created} introduced; no message submitted.`, type: "info",
    });
    assert.deepEqual(known(left), [created]);
    assert.deepEqual(known(right), [owner]);
    // Repetition needs no state write, but must repair knowledge forgotten remotely.
    chmodSync(join(left.agentDir, "companion"), 0o500);
    chmodSync(join(right.agentDir, "companion"), 0o500);
    await left.command(`introduce ${created}`);
    assert.equal(left.notifications.at(-1)?.type, "info");
    chmodSync(join(left.agentDir, "companion"), 0o700);
    chmodSync(join(right.agentDir, "companion"), 0o700);
    await right.command(`forget ${owner}`);
    const repeated = await left.tool({ action: "introduce", destination: created }) as { details: unknown };
    assert.deepEqual(repeated.details, { status: "introduced", reference: owner, destination: created });
    assert.deepEqual(known(right), [owner]);
    await left.command(`introduce ${owner}`);
    assert.match(left.notifications.at(-1)?.message ?? "", /Self-introduction changes no destinations/u);
    await left.command("introduce ../unsafe");
    assert.equal(left.notifications.at(-1)?.type, "error");
    assert.deepEqual(left.deliveries, []);
    assert.deepEqual(right.deliveries, []);
    assert.deepEqual(left.execCalls, []);
    assert.deepEqual(right.execCalls, []);
    await left.command(`send ${created} hello`);
    await right.command(`send ${owner} reply`);
    assert.equal(left.deliveries.length, 1);
    assert.equal(right.deliveries.length, 1);
    await right.shutdown("quit");
    await left.command(`introduce ${created}`);
    assert.match(left.notifications.at(-1)?.message ?? "", /unavailable.*[Ll]ocal destinations unchanged/u);
    assert.deepEqual(known(left), [created]);
    await left.command(`send ${created} unavailable`);
    assert.deepEqual(known(left), []);
  } finally {
    for (const harness of [left, right]) {
      chmodSync(join(harness.agentDir, "companion"), 0o700);
      await harness.shutdown("quit");
    }
  }
});

test("explicit introduction distinguishes remote rejection from acknowledged remote-only persistence", async () => {
  const left = new PiLifecycleHarness(owner, new TestSessionState());
  const right = new PiLifecycleHarness(created, new TestSessionState());
  await left.start("startup");
  await right.start("startup");
  const leftDirectory = join(left.agentDir, "companion");
  const rightDirectory = join(right.agentDir, "companion");
  mkdirSync(leftDirectory, { recursive: true });
  mkdirSync(rightDirectory, { recursive: true });
  const known = (h: PiLifecycleHarness) => new PersistentCompanion(h.reference, h.agentDir).destinations();
  try {
    chmodSync(rightDirectory, 0o500);
    await left.command(`introduce ${created}`);
    assert.match(left.notifications.at(-1)?.message ?? "", /rejected/u);
    assert.ok(left.notifications.at(-1)?.message.includes(join(rightDirectory, `${created}.json`)));
    assert.deepEqual(known(left), []);
    assert.deepEqual(known(right), []);
    chmodSync(rightDirectory, 0o700);
    chmodSync(leftDirectory, 0o500);
    await left.command(`introduce ${created}`);
    assert.equal(left.notifications.at(-1)?.type, "error");
    assert.match(left.notifications.at(-1)?.message ?? "", /accepted introduction.*local destination was not saved/u);
    assert.ok(left.notifications.at(-1)?.message.includes(join(leftDirectory, `${owner}.json`)));
    assert.deepEqual(known(left), []);
    assert.deepEqual(known(right), [owner]);
    chmodSync(leftDirectory, 0o700);
    await left.command(`introduce ${created}`);
    assert.equal(left.notifications.at(-1)?.type, "info");
    assert.deepEqual(known(left), [created]);
    assert.deepEqual(known(right), [owner]);
    assert.deepEqual(left.deliveries, []);
    assert.deepEqual(right.deliveries, []);
  } finally {
    chmodSync(leftDirectory, 0o700);
    chmodSync(rightDirectory, 0o700);
    await left.shutdown("quit");
    await right.shutdown("quit");
  }
});

test("clean same-ID resume loads destinations from ordinary Companion state", async () => {
  const conversation = conversationReference("30500000-0000-4000-8000-000000000001");
  const peer = conversationReference("30500000-0000-4000-8000-000000000002");
  const state = new TestSessionState();
  const agentDir = isolatedAgentDir();
  const before = new PiLifecycleHarness(conversation, state, agentDir);
  const peerConnection = createHostConnection({
    reference: peer,
    exec: before.api.exec.bind(before.api),
    extensionPath: "/extensions/companion.ts",
    deliver: () => {},
  });

  await before.start("startup");
  await peerConnection.start(() => {});
  try {
    assert.equal((await peerConnection.submit(conversation, "remember me")).isOk(), true);
    await before.shutdown("quit");
    assert.equal(readFileSync(join(agentDir, "companion", `${conversation}.json`), "utf8"),
      `[\"${peer}\"]\n`);

    const resumed = new PiLifecycleHarness(conversation, state, agentDir);
    await resumed.start("resume");
    try {
      await resumed.command("list");
      assert.equal(resumed.notifications.at(-1)?.message,
        `Conversation ${conversation} destinations:\n${peer}`);
    } finally {
      await resumed.shutdown("quit");
    }
  } finally {
    await peerConnection.stop();
  }
  assert.deepEqual(state.entries, []);
});

test("reload rebinds the same ID and loads its ordinary destination file", async () => {
  const conversation = conversationReference("31000000-0000-4000-8000-000000000001");
  const peer = conversationReference("31000000-0000-4000-8000-000000000002");
  const state = new TestSessionState();
  const agentDir = isolatedAgentDir();
  const before = new PiLifecycleHarness(conversation, state, agentDir);
  const peerDeliveries: string[] = [];
  const peerConnection = createHostConnection({
    reference: peer,
    exec: before.api.exec.bind(before.api),
    extensionPath: "/extensions/companion.ts",
    deliver: (source, text) => { peerDeliveries.push(`${source}:${text}`); },
  });

  await before.start("startup");
  await peerConnection.start(() => {});
  try {
    assert.equal((await peerConnection.submit(conversation, "introduce peer")).isOk(), true);
    await before.shutdown("reload");
    await assert.rejects(stat(conversationSocketPath(conversation, tmpdir())), { code: "ENOENT" });

    const after = new PiLifecycleHarness(conversation, state, agentDir);
    await after.start("reload");
    try {
      await after.command("list");
      assert.equal(after.notifications.at(-1)?.message,
        `Conversation ${conversation} destinations:\n${peer}`);
      await after.command(`send ${peer} after reload`);
      assert.deepEqual(peerDeliveries, [`${conversation}:after reload`]);
      assert.deepEqual(after.execCalls, []);
    } finally {
      await after.shutdown("quit");
    }
  } finally {
    await peerConnection.stop();
  }
  assert.deepEqual(state.entries, []);
});

test("repeated reload preserves retained knowledge and stored forgetting", async () => {
  const conversation = conversationReference("31500000-0000-4000-8000-000000000001");
  const retained = conversationReference("31500000-0000-4000-8000-000000000002");
  const forgotten = conversationReference("31500000-0000-4000-8000-000000000003");
  const state = new TestSessionState();
  const agentDir = isolatedAgentDir();
  const first = new PiLifecycleHarness(conversation, state, agentDir);
  const retainedMessages: string[] = [];
  const retainedConnection = createHostConnection({
    reference: retained,
    exec: first.api.exec.bind(first.api),
    extensionPath: "/extensions/companion.ts",
    deliver: (source, text) => { retainedMessages.push(`${source}:${text}`); },
  });
  const forgottenConnection = createHostConnection({
    reference: forgotten,
    exec: first.api.exec.bind(first.api),
    extensionPath: "/extensions/companion.ts",
    deliver: () => {},
  });

  await first.start("startup");
  await retainedConnection.start(() => {});
  await forgottenConnection.start(() => {});
  try {
    assert.equal((await retainedConnection.submit(conversation, "retain me")).isOk(), true);
    assert.equal((await forgottenConnection.submit(conversation, "forget me")).isOk(), true);
    await first.command(`forget ${forgotten}`);
    await first.shutdown("reload");

    const second = new PiLifecycleHarness(conversation, state, agentDir);
    await second.start("reload");
    await second.shutdown("reload");

    const third = new PiLifecycleHarness(conversation, state, agentDir);
    await third.start("reload");
    try {
      await third.command("list");
      assert.equal(third.notifications.at(-1)?.message,
        `Conversation ${conversation} destinations:\n${retained}`);
      assert.equal((await retainedConnection.submit(conversation, "steer after reload")).isOk(), true);
      await third.command(`send ${retained} reply after reload`);
      assert.deepEqual(retainedMessages, [`${conversation}:reply after reload`]);
      assert.equal(third.deliveries.length, 1);
    } finally {
      await third.shutdown("quit");
    }
  } finally {
    await retainedConnection.stop();
    await forgottenConnection.stop();
  }
  assert.equal(readFileSync(join(agentDir, "companion", `${conversation}.json`), "utf8"),
    `[\"${retained}\"]\n`);
});

test("all ordinary start reasons load the same ID state without transcript entries", async () => {
  const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
  for (const [index, reason] of reasons.entries()) {
    const conversation = conversationReference(`32000000-0000-4000-8000-00000000000${index + 1}`);
    const peer = conversationReference("32000000-0000-4000-8000-000000000009");
    const agentDir = isolatedAgentDir();
    new PersistentCompanion(conversation, agentDir).introduce(peer);
    const state = new TestSessionState();
    const harness = new PiLifecycleHarness(conversation, state, agentDir);

    await harness.start(reason);
    try {
      await harness.command("list");
      assert.equal(harness.notifications.at(-1)?.message,
        `Conversation ${conversation} destinations:\n${peer}`, reason);
    } finally {
      await harness.shutdown("quit");
    }
    assert.deepEqual(state.entries, [], reason);
  }
});

test("a different native ID does not inherit another ID's destinations", async () => {
  const original = conversationReference("32500000-0000-4000-8000-000000000001");
  const replacement = conversationReference("32500000-0000-4000-8000-000000000002");
  const peer = conversationReference("32500000-0000-4000-8000-000000000003");
  const agentDir = isolatedAgentDir();
  new PersistentCompanion(original, agentDir).introduce(peer);
  const harness = new PiLifecycleHarness(replacement, new TestSessionState(), agentDir);

  await harness.start("resume");
  try {
    await harness.command("list");
    assert.equal(harness.notifications.at(-1)?.message,
      `Conversation ${replacement} has no local destinations.`);
  } finally {
    await harness.shutdown("quit");
  }
});

test("transcript entries neither supply destinations nor receive state writes", async () => {
  const conversation = conversationReference("33000000-0000-4000-8000-000000000001");
  const peer = conversationReference("33000000-0000-4000-8000-000000000002");
  const state = new TestSessionState();
  state.append("unrelated-state", { destinations: [peer] });
  state.failNextAppend(new Error("destination state must not be appended to the transcript"));
  const harness = new PiLifecycleHarness(conversation, state);

  await harness.start("reload");
  try {
    await harness.command("list");
    assert.equal(harness.notifications.at(-1)?.message,
      `Conversation ${conversation} has no local destinations.`);
    assert.deepEqual(harness.notifications.filter((notice) => notice.type === "warning"), []);
  } finally {
    await harness.shutdown("quit");
  }
  assert.equal(state.entries.length, 1);
});

test("state load failure reports path and cause without activating a listener", async () => {
  const conversation = conversationReference("34000000-0000-4000-8000-000000000001");
  const agentDir = isolatedAgentDir();
  const stateDirectory = join(agentDir, "companion");
  const statePath = join(stateDirectory, `${conversation}.json`);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(statePath, "{broken", "utf8");
  const harness = new PiLifecycleHarness(conversation, new TestSessionState(), agentDir);

  await assert.rejects(
    harness.start("resume"),
    (failure: unknown) => failure instanceof Error
      && failure.message.includes(statePath)
      && failure.cause instanceof SyntaxError
      && failure.message.includes(failure.cause.message),
  );
  await assert.rejects(stat(conversationSocketPath(conversation, tmpdir())), { code: "ENOENT" });
  await harness.command("list");
  assert.equal(harness.notifications.at(-1)?.message,
    "Companion Runtime is not active for this conversation.");
  assert.equal(readFileSync(statePath, "utf8"), "{broken");
});

test("all shutdown reasons stop without transcript persistence", async () => {
  const reasons = ["quit", "reload", "new", "resume", "fork"] as const;
  for (const [index, reason] of reasons.entries()) {
    const conversation = conversationReference(`34500000-0000-4000-8000-00000000000${index + 1}`);
    const state = new TestSessionState();
    const harness = new PiLifecycleHarness(conversation, state);
    await harness.start("startup");

    await harness.shutdown(reason);

    assert.deepEqual(state.entries, [], reason);
    await assert.rejects(stat(conversationSocketPath(conversation, tmpdir())), { code: "ENOENT" });
  }
});

test("listener bind failure leaves persisted state unchanged and Runtime inactive", async () => {
  const conversation = conversationReference("35000000-0000-4000-8000-000000000001");
  const agentDir = isolatedAgentDir();
  const statePath = join(agentDir, "companion", `${conversation}.json`);
  new PersistentCompanion(conversation, agentDir).introduce(created);
  const stored = readFileSync(statePath, "utf8");
  const blocker = createHostConnection({
    reference: conversation,
    exec: async () => { throw new Error("must not launch"); },
    extensionPath: "/extensions/companion.ts",
    deliver: () => {},
  });
  await blocker.start(() => {});
  try {
    const harness = new PiLifecycleHarness(conversation, new TestSessionState(), agentDir);
    await assert.rejects(harness.start("reload"), /EADDRINUSE/u);
    assert.equal(readFileSync(statePath, "utf8"), stored);
    assert.equal((await stat(conversationSocketPath(conversation, tmpdir()))).isSocket(), true);
    await harness.command("list");
    assert.equal(harness.notifications.at(-1)?.type, "error");
  } finally {
    await blocker.stop();
  }
});

test("incoming ordinary messages steer local Pi and trigger a turn", async () => {
  type EventHandler = (...args: unknown[]) => unknown;
  const events = new Map<string, EventHandler>();
  const deliveries: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on(event: string, handler: EventHandler) { events.set(event, handler); },
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    sendMessage(message: unknown, options: unknown) { deliveries.push({ message, options }); },
    async exec() { return { code: 0, stdout: "", stderr: "" }; },
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: { getSessionId: () => owner, getBranch: () => [] },
  } as unknown as ExtensionContext;
  const agentDir = isolatedAgentDir();
  companionExtension(pi, agentDir);

  await events.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  const sender = createHostConnection({
    reference: created,
    exec: pi.exec.bind(pi),
    extensionPath: "/extensions/companion.ts",
    deliver: () => {},
  });
  try {
    const submitted = await sender.submit(owner, "steer this");

    assert.equal(submitted.isOk(), true);
    assert.equal(readFileSync(join(agentDir, "companion", `${owner}.json`), "utf8"),
      `[\"${created}\"]\n`);
    assert.deepEqual(deliveries, [{
      message: {
        customType: "companion-message",
        content: `Message from conversation ${created}:\n\nsteer this`,
        display: true,
        details: { source: created },
      },
      options: { deliverAs: "steer", triggerTurn: true },
    }]);
  } finally {
    await events.get("session_shutdown")?.({}, context);
  }
});

test("failed incoming persistence is rejected before local Pi delivery", async () => {
  const conversation = conversationReference("36000000-0000-4000-8000-000000000001");
  const senderReference = conversationReference("36000000-0000-4000-8000-000000000002");
  const agentDir = isolatedAgentDir();
  const stateDirectory = join(agentDir, "companion");
  const harness = new PiLifecycleHarness(conversation, new TestSessionState(), agentDir);
  await harness.start("startup");
  mkdirSync(stateDirectory, { recursive: true });
  chmodSync(stateDirectory, 0o500);
  const sender = createHostConnection({
    reference: senderReference,
    exec: harness.api.exec.bind(harness.api),
    extensionPath: "/extensions/companion.ts",
    deliver: () => {},
  });
  try {
    const submitted = await sender.submit(conversation, "must not deliver");

    assert.equal(submitted.isErr() && submitted.error.kind, "rejected");
    assert.equal(submitted.isErr() && submitted.error.message.includes(
      join(stateDirectory, `${conversation}.json`),
    ), true);
    assert.deepEqual(harness.deliveries, []);
  } finally {
    chmodSync(stateDirectory, 0o700);
    await harness.shutdown("quit");
  }
});

test("structured non-open fields are rejected before inactive Runtime", async () => {
  const harness = new PiLifecycleHarness(owner, new TestSessionState());

  const result = await harness.tool({ action: "list", model: "not-for-list" }) as {
    details: { status: string; message: string };
  };

  assert.deepEqual(result.details, {
    status: "error",
    message: "Invalid Companion action fields.",
  });
  assert.deepEqual(harness.execCalls, []);
});
