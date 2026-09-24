import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const REFERENCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const REFERENCE_LIMIT = 64;

declare const referenceBrand: unique symbol;

/** One native Pi session ID. It denotes identity, not availability or authority. */
export type ConversationReference = string & {
  readonly [referenceBrand]: "ConversationReference";
};

/** Owns one conversation's identity, local destinations, and synchronous persistence. */
export class Companion {
  readonly #destinations = new Set<ConversationReference>();
  readonly #statePath: string;

  constructor(
    readonly reference: ConversationReference,
    agentDir: string,
  ) {
    this.#statePath = join(agentDir, "companion", `${reference}.json`);
    try {
      const values: unknown = JSON.parse(readFileSync(this.#statePath, "utf8"));
      if (!Array.isArray(values)) throw new Error("State must be an array of conversation references.");
      for (const value of values) {
        const destination = parseConversationReference(value);
        if (!destination) throw new Error("State contains an invalid conversation reference.");
        if (destination !== reference) this.#destinations.add(destination);
      }
    } catch (cause: unknown) {
      if (isMissingFile(cause)) return;
      throw stateFailure("load", this.#statePath, cause);
    }
  }

  /** Returns a stable snapshot without probing destination availability. */
  destinations(): readonly ConversationReference[] {
    return [...this.#destinations].sort();
  }

  /** Reports local knowledge without probing destination availability. */
  has(reference: ConversationReference): boolean {
    return this.#destinations.has(reference);
  }

  /** Saves a real introduction before adopting it; storage failure throws. */
  introduce(reference: ConversationReference): void {
    if (reference === this.reference || this.#destinations.has(reference)) return;
    const next = new Set(this.#destinations).add(reference);
    this.#save(next);
    this.#destinations.add(reference);
  }

  #save(destinations: ReadonlySet<ConversationReference>): void {
    const directory = dirname(this.#statePath);
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify([...destinations].sort())}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.#statePath);
    } catch (cause: unknown) {
      try {
        unlinkSync(temporaryPath);
      } catch {}
      throw stateFailure("save", this.#statePath, cause);
    }
  }

  /** Saves real local forgetting before adoption; it never stops the destination. */
  forget(reference: ConversationReference): boolean {
    if (!this.#destinations.has(reference)) return false;
    const next = new Set(this.#destinations);
    next.delete(reference);
    this.#save(next);
    this.#destinations.delete(reference);
    return true;
  }
}

/** Parses an untrusted native ID into the value required by Host and Companion. */
export function parseConversationReference(value: unknown): ConversationReference | undefined {
  return typeof value === "string" && value.length <= REFERENCE_LIMIT
      && REFERENCE_PATTERN.test(value)
    ? value as ConversationReference
    : undefined;
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function stateFailure(operation: "load" | "save", path: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Failed to ${operation} Companion state at ${path}: ${detail}`, { cause });
}

/** Requires a valid reference and reports a caller-facing parse error. */
export function conversationReference(value: unknown): ConversationReference {
  const parsed = parseConversationReference(value);
  if (!parsed) throw new Error("Conversation reference is not a safe bounded native session ID.");
  return parsed;
}
