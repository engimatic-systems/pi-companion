import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { conversationReference } from "../src/companion.js";
import {
  conversationSocketPath,
  createHostConnection,
  launchHerdrConversation,
  type ConversationConfiguration,
  type HostConnection,
  type PiExec,
} from "../src/host.js";

const a = conversationReference("10000000-0000-4000-8000-000000000001");
const b = conversationReference("10000000-0000-4000-8000-000000000002");
const extensionPath = "/extensions/companion.ts";
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
const configuration: ConversationConfiguration = {
  cwd: "/work",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "high",
};

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "companion-test-"));
}

function successfulHerdr(
  onAgentStart?: (args: string[]) => void | Promise<void>,
): PiExec {
  return async (command, args) => {
    assert.equal(command, "herdr");
    if (args[0] === "pane") {
      const result = args[1] === "layout"
        ? { layout: { panes: [{ pane_id: "w1:p1", rect: { x: 0 } }] } }
        : { pane: { pane_id: "w1:p2" } };
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    }
    assert.equal(args[0], "agent");
    await onAgentStart?.(args);
    return {
      code: 0,
      stdout: JSON.stringify({ result: { agent: { name: "started" } } }),
      stderr: "",
    };
  };
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function launchCallsFor(panes: unknown[]): Promise<string[][]> {
  const calls: string[][] = [];
  const exec: PiExec = async (_command, args) => {
    calls.push(args);
    const result = args[1] === "layout"
      ? { layout: { panes } }
      : args[1] === "split"
        ? { pane: { pane_id: "w1:new" } }
        : { agent: { name: "started" } };
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };
  await launchHerdrConversation({ exec, extensionPath, env, reference: b, configuration });
  return calls;
}

test("conversation socket path derives from the resolved socket root", async () => {
  const root = await temporaryRoot();
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    assert.equal(conversationSocketPath(b, root), join(root, `pi-companion-${uid}`, `${b}.sock`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-pane Herdr launch splits the invoker right without taking focus", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: PiExec = async (command, args) => {
    calls.push({ command, args });
    const result = args[1] === "layout"
      ? { layout: { panes: [{ pane_id: "w1:p1", rect: { x: 0 } }] } }
      : args[1] === "split"
        ? { pane: { pane_id: "w1:p2" } }
        : { agent: { name: "started" } };
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };

  await launchHerdrConversation({
    exec,
    extensionPath,
    env,
    reference: b,
    configuration,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    command: "herdr",
    args: ["pane", "layout", "--pane", "w1:p1"],
  });
  assert.deepEqual(calls[1], {
    command: "herdr",
    args: ["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/work", "--no-focus"],
  });
  assert.deepEqual(calls[2], {
    command: "herdr",
    args: [
      "agent", "start", "companion-10000000", "--kind", "pi", "--pane", "w1:p2", "--timeout", "30000", "--",
      "--session-id", b, "--name", "companion-10000000", "--no-extensions",
      "--extension", extensionPath, "--provider", "openai-codex",
      "--model", "gpt-5.6-sol", "--thinking", "high",
    ],
  });
});

test("Herdr launch accepts Pi's max thinking level", async () => {
  const calls: string[][] = [];
  await launchHerdrConversation({
    exec: successfulHerdr((args) => { calls.push(args); }),
    extensionPath,
    env,
    reference: b,
    configuration: { ...configuration, thinking: "max" },
  });

  assert.equal(argument(calls[0] ?? [], "--thinking"), "max");
});

test("multi-pane Herdr launch splits a right-hand pane down without taking focus", async () => {
  const calls = await launchCallsFor([
    { pane_id: "w1:p1", rect: { x: 0 } },
    { pane_id: "w1:right-top", rect: { x: 100 } },
    { pane_id: "w1:right-bottom", rect: { x: 100 } },
  ]);

  assert.deepEqual(calls.find((args) => args[1] === "split"), [
    "pane", "split", "w1:right-top", "--direction", "down", "--cwd", "/work", "--no-focus",
  ]);
  assert.equal(calls.some((args) => args[1] === "focus"), false);
});

test("multi-pane Herdr launch falls back to splitting the invoker down", async () => {
  const calls = await launchCallsFor([
    { pane_id: "w1:p1", rect: { x: 0 } },
    { pane_id: "w1:below", rect: { x: 0 } },
  ]);

  assert.deepEqual(calls.find((args) => args[1] === "split"), [
    "pane", "split", "w1:p1", "--direction", "down", "--cwd", "/work", "--no-focus",
  ]);
});

test("Herdr launch rejects unusable geometry before splitting", async () => {
  const cases: Array<{ name: string; layout: unknown; message: RegExp }> = [
    { name: "missing panes", layout: {}, message: /has no panes/u },
    {
      name: "incomplete rectangle",
      layout: { panes: [{ pane_id: "w1:p1", rect: {} }] },
      message: /geometry is incomplete/u,
    },
    {
      name: "invoker absent",
      layout: { panes: [{ pane_id: "w1:other", rect: { x: 0 } }] },
      message: /outside the reported tab layout/u,
    },
  ];

  for (const fixture of cases) {
    const calls: string[][] = [];
    const exec: PiExec = async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ result: { layout: fixture.layout } }), stderr: "" };
    };

    await assert.rejects(
      launchHerdrConversation({ exec, extensionPath, env, reference: b, configuration }),
      fixture.message,
      fixture.name,
    );
    assert.equal(calls.some((args) => args[1] === "split"), false, fixture.name);
  }
});

test("one preselected reference drives launch and the created HostConnection path", async () => {
  let child: HostConnection | undefined;
  const creator = createHostConnection({
    reference: a,
    exec: successfulHerdr(async (args) => {
      assert.equal(argument(args, "--session-id"), b);
      child = createHostConnection({
        reference: b,
        exec: successfulHerdr(),
        extensionPath,
        env,
        deliver: () => {},
      });
      await child.start(() => {});
    }),
    extensionPath,
    env,
    deliver: () => {},
    createReference: () => b,
  });
  try {
    await creator.start(() => {});
    const result = await creator.create(configuration);

    assert.equal(result.isOk() && result.value, b);
    assert.equal((await stat(conversationSocketPath(a, tmpdir()))).isSocket(), true);
    assert.equal((await stat(conversationSocketPath(b, tmpdir()))).isSocket(), true);
  } finally {
    await creator.stop();
    await child?.stop();
  }
});

test("incoming message introduces an unknown sender before local delivery", async () => {
  const notices: string[] = [];
  const delivered: string[] = [];
  const sender = createHostConnection({
    reference: a,
    exec: successfulHerdr(),
    extensionPath,
    env,
    deliver: () => {},
  });
  const receiver = createHostConnection({
    reference: b,
    exec: successfulHerdr(),
    extensionPath,
    env,
    deliver: (source, message) => delivered.push(`${source}:${message}`),
  });
  try {
    await sender.start(() => {});
    await receiver.start((source) => notices.push(source));

    const result = await sender.submit(b, "hello");

    assert.equal(result.isOk() && result.value.status, "accepted");
    assert.deepEqual(notices, [a]);
    assert.deepEqual(delivered, [`${a}:hello`]);
  } finally {
    await sender.stop();
    await receiver.stop();
  }
});

test("post-launch introduction failure reports creation failure without relaunch", async () => {
  let launches = 0;
  const creator = createHostConnection({
    reference: a,
    exec: successfulHerdr(() => { launches += 1; }),
    extensionPath,
    env,
    deliver: () => {},
    createReference: () => b,
    exchangeTimeoutMs: 100,
  });
  try {
    await creator.start(() => {});
    const result = await creator.create(configuration);

    assert.equal(result.isErr() && result.error.kind, "creation_failed");
    assert.equal(result.isErr() && result.error.attemptedReference, b);
    assert.match(result.isErr() ? result.error.message : "", /process may remain/i);
    assert.equal(launches, 1);
  } finally {
    await creator.stop();
  }
});

test("creation while HostConnection is inactive settles without launch", async () => {
  let called = false;
  const connection = createHostConnection({
    reference: a,
    exec: async () => {
      called = true;
      throw new Error("must not launch");
    },
    extensionPath,
    env,
    deliver: () => {},
    createReference: () => b,
  });

  const result = await connection.create(configuration);

  assert.equal(result.isErr() && result.error.kind, "creation_failed");
  assert.match(result.isErr() ? result.error.message : "", /not started/);
  assert.equal(called, false);
});
