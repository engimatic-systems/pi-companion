import { parseArgs } from "node:util";

import { THINKING_LEVELS, type Action } from "./actions.js";

export const humanCommand = {
  name: "companion",
  description: "Create, list, message, or locally forget Companion conversations.",
  usage: "Usage: /companion open [message] | open [--provider PROVIDER] [--model MODEL] [--thinking LEVEL] [-- MESSAGE] | list | send <conversation-id> <message> | forget <conversation-id>",
} as const;

interface FramedCommand {
  /** The first non-whitespace token, used only for fixed-command dispatch. */
  name: string;
  /** Text from the first non-whitespace character after the command through EOF. */
  tail?: string;
}

interface FramedOpenOptions {
  /** Only the option prefix, split for `parseArgs`. */
  args: string[];
  /** Literal text after standalone `--`, when non-empty. */
  message?: string;
}

const openOptions = {
  provider: { type: "string" },
  model: { type: "string" },
  thinking: { type: "string" },
} as const;

/**
 * Parses raw human text into an `Action` without executing Runtime effects.
 *
 * Framing first separates syntax from literal-bearing tails. Fixed dispatch and
 * native `parseArgs` then decode the grammar, and the parser constructs the
 * action data. Whitespace before the command and between a command,
 * destination, options, or standalone `--` and its next value belongs to the
 * syntax. Internal and trailing message whitespace is preserved, as are
 * newlines, quotes, backslashes, and option-looking text; quotes do not invoke
 * shell tokenization or escaping.
 *
 * Examples (the quoted strings are the exact text supplied here):
 *
 * - `"open Review  this  "` → `{ action: "open", message: "Review  this  " }`
 * - `"open --thinking high -- Review  this  "` →
 *   `{ action: "open", thinking: "high", message: "Review  this  " }`
 * - `"open -- --model literal  "` →
 *   `{ action: "open", message: "--model literal  " }`
 * - `"send conversation-2   keep  spacing  "` →
 *   `{ action: "send", destination: "conversation-2", message: "keep  spacing  " }`
 *
 * `"open"` and `"open --"` both construct an open action with no message.
 * Incomplete or malformed input rejects instead of constructing a partial
 * action. Fixed dispatch rejects unknown commands and a `list` tail; the
 * command parsers enforce `send` and `forget` arity. Option-mode message text
 * requires standalone `--`, and `send` requires both a destination and a
 * non-empty literal message tail.
 */
export async function parseCommand(raw: string): Promise<Action> {
  const command = frameCommand(raw);
  switch (command.name) {
    case "open":
      return parseOpen(command.tail);
    case "list":
      if (command.tail !== undefined) throw new Error(humanCommand.usage);
      return { action: "list" };
    case "send":
      return parseSend(command.tail);
    case "forget":
      return parseForget(command.tail);
    default:
      throw new Error(humanCommand.usage);
  }
}

/**
 * Separates one command word from an otherwise untouched, literal-bearing tail.
 *
 * Leading command whitespace and the separating whitespace before the tail are
 * syntax and are not retained. Once the tail starts, this function does not
 * split, trim, interpret quotes, or decide whether its contents are options or
 * message text. Those decisions belong to the selected command parser.
 */
function frameCommand(raw: string): FramedCommand {
  const commandStart = raw.search(/\S/u);
  if (commandStart < 0) return { name: "" };
  const commandEndOffset = raw.slice(commandStart).search(/\s/u);
  if (commandEndOffset < 0) return { name: raw.slice(commandStart) };

  const name = raw.slice(commandStart, commandStart + commandEndOffset);
  const tailStart = commandStart + commandEndOffset;
  const contentStartOffset = raw.slice(tailStart).search(/\S/u);
  return contentStartOffset < 0
    ? { name }
    : { name, tail: raw.slice(tailStart + contentStartOffset) };
}

/**
 * Parses ordinary-message or option-mode `open`.
 *
 * A non-hyphen tail is one literal message. A leading hyphen selects option
 * mode, where `frameOpenOptions` protects any message after standalone `--`
 * before strict `parseArgs` decodes the option prefix. `parseArgs` owns option
 * spelling, string arguments, unknown options, missing arguments, and rejection
 * of positionals. Application checks use returned tokens to reject duplicates,
 * reject explicit empty values such as `--model=`, and enforce the thinking
 * vocabulary before constructing an `Action`.
 */
function parseOpen(tail: string | undefined): Action {
  if (tail === undefined) return { action: "open" };
  if (!tail.startsWith("-")) return { action: "open", message: tail };

  const framed = frameOpenOptions(tail);
  const { values, tokens } = parseArgs({
    args: framed.args,
    options: openOptions,
    strict: true,
    tokens: true,
    allowPositionals: false,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}.`);
    seen.add(token.name);
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === "") throw new Error(`Option --${name} requires a non-empty value.`);
  }
  if (values.thinking !== undefined && !isThinkingLevel(values.thinking)) {
    throw new Error(`Invalid thinking level: ${values.thinking}.`);
  }
  return {
    action: "open",
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.thinking === undefined ? {} : { thinking: values.thinking }),
    ...(framed.message === undefined ? {} : { message: framed.message }),
  };
}

/**
 * Splits only option-mode `open` at its standalone `--` message boundary.
 *
 * The option prefix is whitespace-tokenized for `parseArgs`; quotes and
 * backslashes have no shell meaning there. Text after `--` becomes one literal
 * message after its separating whitespace, preserving internal and trailing
 * bytes. Without `--`, all text remains option input, so a bare message is
 * rejected as a positional rather than silently reclassified.
 */
function frameOpenOptions(tail: string): FramedOpenOptions {
  const delimiter = /(^|\s)--(?=\s|$)/u.exec(tail);
  if (!delimiter) return { args: tail.trimEnd().split(/\s+/u) };

  const delimiterStart = delimiter.index + delimiter[1].length;
  const optionText = tail.slice(0, delimiterStart).trimEnd();
  const message = tail.slice(delimiterStart + 2).replace(/^\s+/u, "");
  return {
    args: optionText ? optionText.split(/\s+/u) : [],
    ...(message ? { message } : {}),
  };
}

/** Isolates one destination token and requires one otherwise untouched message tail. */
function parseSend(tail: string | undefined): Action {
  if (tail === undefined) throw new Error(humanCommand.usage);
  const destinationEnd = tail.search(/\s/u);
  if (destinationEnd < 0) throw new Error(humanCommand.usage);
  const destination = tail.slice(0, destinationEnd);
  const messageStartOffset = tail.slice(destinationEnd).search(/\S/u);
  if (messageStartOffset < 0) throw new Error(humanCommand.usage);
  return {
    action: "send",
    destination,
    message: tail.slice(destinationEnd + messageStartOffset),
  };
}

/** Accepts exactly one destination token; `forget` and `list` have no literal payload. */
function parseForget(tail: string | undefined): Action {
  const destination = tail?.trimEnd();
  if (!destination || /\s/u.test(destination)) throw new Error(humanCommand.usage);
  return { action: "forget", destination };
}

function isThinkingLevel(
  value: unknown,
): value is Exclude<Extract<Action, { action: "open" }>["thinking"], undefined> {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
