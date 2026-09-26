import assert from "node:assert/strict";
import { test } from "node:test";

import { humanCommand, isHelpRequest, parseCommand } from "../src/command.js";

test("only bare or exact help requests select informational command help", async () => {
  for (const input of ["", "  \t\n  ", "help", "  help  \n"]) {
    assert.equal(isHelpRequest(input), true, JSON.stringify(input));
  }
  assert.match(humanCommand.help, /\/companion open/u);
  assert.match(humanCommand.help, /\/companion send <conversation-id> <message>/u);
  assert.match(humanCommand.help, /\/companion forget <conversation-id>/u);
  assert.match(humanCommand.help, /\/companion list/u);
  assert.match(humanCommand.help, /--provider PROVIDER.*--model MODEL.*--thinking LEVEL.*-- MESSAGE/u);
  assert.match(humanCommand.help, /tool-only.*introduce/u);
  assert.match(humanCommand.help, /does not contact the peer/u);
  assert.equal(humanCommand.help.includes("/companion introduce"), false);

  for (const input of ["help extra", "help --", "helps", "open help", "send peer help"]) {
    assert.equal(isHelpRequest(input), false, input);
  }
  await assert.rejects(parseCommand("help extra"), /Usage:/u);
  assert.deepEqual(await parseCommand("open help"), { action: "open", message: "help" });
  assert.deepEqual(await parseCommand("send peer help"), {
    action: "send", destination: "peer", message: "help",
  });
});

test("ordinary open text remains one literal message", async () => {
  const message = "Review  \\\"quoted\\\" \\\\path\nnext --thinking max  ";

  assert.deepEqual(await parseCommand(`open ${message}`), { action: "open", message });
});

test("open parses launch options and one delimited literal message", async () => {
  assert.deepEqual(
    await parseCommand("open --provider openai-codex --model=gpt-5.6-sol --thinking max -- Review --this  literally  "),
    {
      action: "open",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "max",
      message: "Review --this  literally  ",
    },
  );
});

test("option-mode open requires a delimiter before message text", async () => {
  await assert.rejects(
    parseCommand("open --thinking high Review this"),
    /Use --|positional|argument|does not take/iu,
  );
});

test("standalone delimiter preserves an option-looking message as one literal value", async () => {
  const message = "--thinking high  \\\"quoted\\\" \\\\path\nnext  ";

  assert.deepEqual(await parseCommand(`open -- ${message}`), {
    action: "open",
    message,
  });
});

test("human parsing rejects malformed open options with useful errors", async () => {
  const cases: Array<{ input: string; message: RegExp }> = [
    { input: "open --unknown value", message: /unknown/iu },
    { input: "open --model first --model second", message: /at most once|duplicate/iu },
    { input: "open --provider", message: /value|missing|argument/iu },
    { input: "open --model=", message: /value|empty/iu },
    { input: "open --thinking turbo", message: /invalid.*(?:value|thinking)/iu },
  ];

  for (const fixture of cases) {
    await assert.rejects(parseCommand(fixture.input), fixture.message, fixture.input);
  }
});

test("human command parsing exposes the same four conversation operations", async () => {
  assert.deepEqual(await parseCommand("open"), { action: "open" });
  assert.deepEqual(await parseCommand("open first message"), {
    action: "open",
    message: "first message",
  });
  assert.deepEqual(await parseCommand("list"), { action: "list" });
  assert.deepEqual(await parseCommand("send conversation-2 ordinary message"), {
    action: "send",
    destination: "conversation-2",
    message: "ordinary message",
  });
  assert.deepEqual(await parseCommand("send conversation-2 --literal  text  "), {
    action: "send",
    destination: "conversation-2",
    message: "--literal  text  ",
  });
  assert.deepEqual(await parseCommand("forget conversation-2"), {
    action: "forget",
    destination: "conversation-2",
  });
});

test("incomplete human commands fail before Host effects", async () => {
  await assert.rejects(parseCommand("send conversation-2"), /message|usage/iu);
  await assert.rejects(parseCommand("forget conversation-2 extra"), /argument|unknown|usage/iu);
});
