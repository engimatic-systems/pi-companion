import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import { decodeAction, runAction, type Action } from "../src/actions.js";
import {
  Companion as PersistentCompanion,
  conversationReference,
  type ConversationReference,
} from "../src/companion.js";
import { parseCommand } from "../src/command.js";
import {
  type ConversationConfiguration,
  type CreationFailure,
  type HostConnection,
  type SubmissionAcceptance,
  type SubmissionFailure,
} from "../src/host.js";
import { Runtime } from "../src/runtime.js";

const testRoot = mkdtempSync(join(tmpdir(), "companion-actions-"));
let nextDirectory = 0;
after(() => rmSync(testRoot, { recursive: true, force: true }));

class Companion extends PersistentCompanion {
  constructor(reference: ConversationReference) {
    nextDirectory += 1;
    super(reference, join(testRoot, String(nextDirectory)));
  }
}

const owner = conversationReference("30000000-0000-4000-8000-000000000001");
const created = conversationReference("30000000-0000-4000-8000-000000000002");

function defaultSelectionContext(): ExtensionContext {
  const model = { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true };
  return {
    cwd: "/work",
    model,
    thinkingLevel: "high",
    modelRegistry: {
      find: (provider: string, modelId: string) => provider === model.provider && modelId === model.id
        ? model : undefined,
      getAvailable: () => [model],
    },
  } as unknown as ExtensionContext;
}

class OpenThenRejectConnection implements HostConnection {
  readonly reference = owner;
  readonly configurations: ConversationConfiguration[] = [];
  submissions = 0;

  async start(_onIntroduction: (reference: ConversationReference) => void): Promise<void> {}

  create(configuration: ConversationConfiguration): ResultAsync<ConversationReference, CreationFailure> {
    this.configurations.push(configuration);
    return okAsync(created);
  }

  submit(
    _destination: ConversationReference,
    _message: string,
  ): ResultAsync<SubmissionAcceptance, SubmissionFailure> {
    this.submissions += 1;
    return errAsync({ kind: "rejected", code: "busy", message: "not accepted" });
  }

  async stop(): Promise<void> {}
}

test("structured decoding uses the canonical per-action field contract", () => {
  const action: Action = decodeAction({ action: "open", model: "target" });

  assert.deepEqual(action, { action: "open", model: "target" });
  assert.deepEqual(decodeAction({ action: "introduce", destination: "peer" }),
    { action: "introduce", destination: "peer" });
  for (const invalid of [
    { action: "list", model: "not-for-list" },
    { action: "introduce" },
    { action: "introduce", destination: "peer", message: "not allowed" },
    { action: "introduce", destination: "peer", provider: "not allowed" },
  ]) {
    assert.throws(() => decodeAction(invalid), /Invalid Companion action fields\./u);
  }
});

test("introduce validates reference in Actions and persists only local knowledge", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const context = defaultSelectionContext();
  await assert.rejects(
    runAction(runtime, decodeAction({ action: "introduce", destination: "bad/ref" }), context),
    /Conversation reference is not a safe bounded native session ID/u,
  );
  assert.deepEqual(runtime.destinations(), []);

  assert.deepEqual(await runAction(runtime, { action: "introduce", destination: created }, context),
    { status: "introduced", destination: created });
  assert.deepEqual(await runAction(runtime, { action: "introduce", destination: owner }, context),
    { status: "introduced", destination: owner });
  assert.deepEqual(runtime.destinations(), [created]);
  assert.equal(connection.submissions, 0);
  assert.deepEqual(connection.configurations, []);
});

test("send validates reference in Actions and introduces an unknown destination via Runtime", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const context = defaultSelectionContext();
  await assert.rejects(runAction(runtime, {
    action: "send", destination: "bad/ref", message: "hello",
  }, context), /Conversation reference is not a safe bounded native session ID/u);
  assert.deepEqual(runtime.destinations(), []);

  const result = await runAction(runtime, { action: "send", destination: created, message: "hello" }, context);
  assert.deepEqual(result, {
    status: "error", kind: "rejected", message: "not accepted", reference: created,
    destinationForgotten: false,
  });
  assert.deepEqual(runtime.destinations(), [created]);
  assert.equal(connection.submissions, 1);
});

test("human and structured provider-only selection resolve the same configuration", async () => {
  const invoking = { provider: "provider-a", id: "shared-model", reasoning: true };
  const target = {
    provider: "provider-b",
    id: "shared-model",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const context = {
    cwd: "/work",
    model: invoking,
    thinkingLevel: "low",
    modelRegistry: {
      find: (provider: string, model: string) => provider === target.provider && model === target.id
        ? target : undefined,
      getAvailable: () => [target],
    },
  } as unknown as ExtensionContext;
  const humanConnection = new OpenThenRejectConnection();
  const toolConnection = new OpenThenRejectConnection();
  const humanAction = await parseCommand("open --provider=provider-b --thinking max");

  await runAction(new Runtime(new Companion(owner), humanConnection), humanAction, context);
  await runAction(new Runtime(new Companion(owner), toolConnection), decodeAction({
    action: "open",
    provider: "provider-b",
    thinking: "max",
  }), context);

  const expected = {
    cwd: "/work",
    provider: "provider-b",
    model: "shared-model",
    thinking: "max",
  };
  assert.deepEqual(humanConnection.configurations, [expected]);
  assert.deepEqual(toolConnection.configurations, [expected]);
  assert.equal(context.model, invoking);
  assert.equal(context.thinkingLevel, "low");
});

test("thinking-only and complete overrides resolve exact available configurations", async () => {
  const invoking = {
    provider: "provider-a",
    id: "parent-model",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const target = { provider: "provider-b", id: "child-model", reasoning: true };
  const models = [invoking, target];
  const context = {
    cwd: "/work",
    model: invoking,
    thinkingLevel: "low",
    modelRegistry: {
      find: (provider: string, model: string) => models.find(
        (candidate) => candidate.provider === provider && candidate.id === model,
      ),
      getAvailable: () => models,
    },
  } as unknown as ExtensionContext;
  const thinkingOnlyConnection = new OpenThenRejectConnection();
  const completeConnection = new OpenThenRejectConnection();

  await runAction(new Runtime(new Companion(owner), thinkingOnlyConnection), {
    action: "open",
    thinking: "max",
  }, context);
  await runAction(new Runtime(new Companion(owner), completeConnection), {
    action: "open",
    provider: "provider-b",
    model: "child-model",
    thinking: "medium",
  }, context);

  assert.deepEqual(thinkingOnlyConnection.configurations, [{
    cwd: "/work",
    provider: "provider-a",
    model: "parent-model",
    thinking: "max",
  }]);
  assert.deepEqual(completeConnection.configurations, [{
    cwd: "/work",
    provider: "provider-b",
    model: "child-model",
    thinking: "medium",
  }]);
});

test("a model-only override inherits provider and thinking", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const invoking = { provider: "openai-codex", id: "gpt-parent", reasoning: true };
  const target = { provider: "openai-codex", id: "gpt-child", reasoning: true };
  const context = {
    cwd: "/work",
    model: invoking,
    thinkingLevel: "high",
    modelRegistry: {
      find: (provider: string, model: string) => provider === target.provider && model === target.id
        ? target : undefined,
      getAvailable: () => [target],
    },
  } as unknown as ExtensionContext;

  const result = await runAction(runtime, { action: "open", model: "gpt-child" }, context);

  assert.deepEqual(result, { status: "opened", reference: created });
  assert.deepEqual(connection.configurations, [{
    cwd: "/work",
    provider: "openai-codex",
    model: "gpt-child",
    thinking: "high",
  }]);
  assert.equal(context.model, invoking);
  assert.equal(context.thinkingLevel, "high");
});

test("an unknown final provider and model pair fails before Runtime open", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const context = {
    cwd: "/work",
    model: { provider: "openai-codex", id: "gpt-parent", reasoning: true },
    thinkingLevel: "high",
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
    },
  } as unknown as ExtensionContext;

  await assert.rejects(
    runAction(runtime, { action: "open", model: "missing" }, context),
    /Unknown Pi model: openai-codex\/missing\./u,
  );
  assert.deepEqual(connection.configurations, []);
});

test("a registered but unavailable model fails before Runtime open", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const registered = { provider: "other-provider", id: "gpt-parent", reasoning: true };
  const context = {
    cwd: "/work",
    model: { provider: "openai-codex", id: "gpt-parent", reasoning: true },
    thinkingLevel: "high",
    modelRegistry: {
      find: () => registered,
      getAvailable: () => [],
    },
  } as unknown as ExtensionContext;

  await assert.rejects(
    runAction(runtime, { action: "open", provider: "other-provider" }, context),
    /Pi model is not currently available: other-provider\/gpt-parent\./u,
  );
  assert.deepEqual(connection.configurations, []);
});

test("unsupported inherited thinking is reported without clamping or opening", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const target = { provider: "plain", id: "plain-model", reasoning: false };
  const context = {
    cwd: "/work",
    model: { provider: "openai-codex", id: "gpt-parent", reasoning: true },
    thinkingLevel: "high",
    modelRegistry: {
      find: () => target,
      getAvailable: () => [target],
    },
  } as unknown as ExtensionContext;

  await assert.rejects(
    runAction(runtime, {
      action: "open",
      provider: "plain",
      model: "plain-model",
    }, context),
    /Thinking level high is not supported by plain\/plain-model\. Supported levels: off\./u,
  );
  assert.deepEqual(connection.configurations, []);
  assert.equal(context.thinkingLevel, "high");
});

test("a missing invoking model fails before Runtime open", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const context = {
    cwd: "/work",
    model: undefined,
    thinkingLevel: "high",
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
  } as unknown as ExtensionContext;

  await assert.rejects(
    runAction(runtime, {
      action: "open",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    }, context),
    /A selected Pi model is required/u,
  );
  assert.deepEqual(connection.configurations, []);
});

test("open without text presents creation without submitting", async () => {
  const connection = new OpenThenRejectConnection();
  const runtime = new Runtime(new Companion(owner), connection);
  const context = defaultSelectionContext();

  const result = await runAction(runtime, { action: "open" }, context);

  assert.deepEqual(result, { status: "opened", reference: created });
  assert.deepEqual(connection.configurations, [{
    cwd: "/work",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "high",
  }]);
  assert.equal(connection.submissions, 0);
});

test("action outcome preserves a submission failure after creation structurally", async () => {
  const runtime = new Runtime(new Companion(owner), new OpenThenRejectConnection());
  const context = defaultSelectionContext();

  const result = await runAction(runtime, {
    action: "open",
    message: "first is ordinary",
  }, context);

  assert.deepEqual(result, {
    status: "error",
    kind: "submission_failed_after_creation",
    message: `Conversation ${created} was created, but the ordinary message was not accepted. not accepted`,
    reference: created,
    failure: { kind: "rejected", code: "busy", message: "not accepted" },
    destinationForgotten: false,
  });
});
