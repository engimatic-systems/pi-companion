import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { isMatching, P } from "ts-pattern";

import {
  conversationReference,
  type ConversationReference,
} from "./companion.js";
import {
  exchange,
  listen,
  MAX_MESSAGE_BYTES,
  type SubmissionFailure,
  type TransportAcknowledgement,
  type TransportListener,
  type TransportRequest,
} from "./socket-transport.js";

export { MAX_MESSAGE_BYTES, type SubmissionFailure } from "./socket-transport.js";

const EXCHANGE_TIMEOUT_MS = 5_000;
const SOCKET_PATH_LIMIT = 100;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ConversationConfiguration {
  cwd: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface CreationFailure {
  kind: "creation_failed";
  attemptedReference: ConversationReference;
  message: string;
  cause?: unknown;
}

export interface SubmissionAcceptance {
  status: "accepted";
}

/** Conversation-local access to creation, introduction, submission, and incoming Host events. */
export interface HostConnection {
  start(onIntroduction: (source: ConversationReference) => void): Promise<void>;
  stop(): Promise<void>;
  create(configuration: ConversationConfiguration): ResultAsync<ConversationReference, CreationFailure>;
  /**
   * Requests remote introduction of this connection's reference once, without
   * launch, message delivery or local state changes. Missing acknowledgement
   * after connection cannot establish that the peer's state is unchanged.
   */
  introduce(destination: ConversationReference): ResultAsync<void, SubmissionFailure>;
  submit(
    destination: ConversationReference,
    message: string,
  ): ResultAsync<SubmissionAcceptance, SubmissionFailure>;
}

export interface PiExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type PiExec = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<PiExecResult>;

export interface HerdrLaunchOptions {
  exec: PiExec;
  extensionPath: string;
  env?: NodeJS.ProcessEnv;
  reference: ConversationReference;
  configuration: ConversationConfiguration;
}

export interface HostConnectionOptions {
  reference: ConversationReference;
  exec: PiExec;
  extensionPath: string;
  deliver: (source: ConversationReference, message: string) => void;
  env?: NodeJS.ProcessEnv;
  createReference?: () => ConversationReference;
  exchangeTimeoutMs?: number;
}

/** Derives the sole transport path from a resolved socket root and conversation ID. */
export function conversationSocketPath(
  reference: ConversationReference,
  socketRoot: string,
): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const path = join(socketRoot, `pi-companion-${uid}`, `${reference}.sock`);
  if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
    throw new Error("No Companion socket address fits the platform limit.");
  }
  return path;
}

/**
 * Creates one conversation-local Host connection. Local setup resolves
 * `tmpdir()` once as the socket root; all destination paths derive from it.
 */
export function createHostConnection({
  reference,
  exec,
  extensionPath,
  deliver,
  env = process.env,
  createReference = () => conversationReference(randomUUID()),
  exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS,
}: HostConnectionOptions): HostConnection {
  const socketRoot = tmpdir();
  const socketPath = conversationSocketPath(reference, socketRoot);
  let listener: TransportListener | undefined;
  let onIntroduction: ((source: ConversationReference) => void) | undefined;

  const receive = async (request: TransportRequest): Promise<TransportAcknowledgement> => {
    if (request.destination !== reference) {
      throw remoteError("wrong_destination", "Host request addressed another conversation.");
    }
    if (!onIntroduction) throw remoteError("inactive", "Host is not accepting submissions.");
    onIntroduction(request.source);
    if (request.operation === "introduce") return { accepted: "introduce" };
    deliver(request.source, request.message);
    return { accepted: "message" };
  };

  const introduce = (destination: ConversationReference): ResultAsync<void, SubmissionFailure> =>
    exchange(conversationSocketPath(destination, socketRoot), {
      version: 1,
      operation: "introduce",
      source: reference,
      destination,
    }, exchangeTimeoutMs).map(() => undefined);

  return {
    introduce,

    async start(introductionHandler): Promise<void> {
      if (listener) return;
      listener = await listen(socketPath, receive);
      onIntroduction = introductionHandler;
    },

    async stop(): Promise<void> {
      onIntroduction = undefined;
      const stopping = listener;
      listener = undefined;
      await stopping?.close();
    },

    create(configuration): ResultAsync<ConversationReference, CreationFailure> {
      const attemptedReference = createReference();
      if (!listener) {
        return errAsync({
          kind: "creation_failed",
          attemptedReference,
          message: "HostConnection is not started; no conversation was launched.",
        });
      }
      return ResultAsync.fromPromise(
        launchHerdrConversation({
          exec,
          extensionPath,
          env,
          reference: attemptedReference,
          configuration,
        }),
        (cause): CreationFailure => ({
          kind: "creation_failed",
          attemptedReference,
          message: `Conversation creation failed; a process may remain and no rollback was attempted: ${message(cause)}`,
          cause,
        }),
      ).andThen(() => introduce(attemptedReference).map(() => attemptedReference).mapErr((cause): CreationFailure => ({
        kind: "creation_failed",
        attemptedReference,
        message: `Conversation ${attemptedReference} launched but did not accept its creator introduction; a process may remain and no rollback was attempted: ${cause.message}`,
        cause,
      })));
    },

    submit(destination, messageText): ResultAsync<SubmissionAcceptance, SubmissionFailure> {
      return exchange(conversationSocketPath(destination, socketRoot), {
        version: 1,
        operation: "message",
        source: reference,
        destination,
        message: messageText,
      }, exchangeTimeoutMs).map(() => ({ status: "accepted" as const }));
    },
  };
}

/** Launches one preidentified conversation directly through Herdr. */
export async function launchHerdrConversation({
  exec,
  extensionPath,
  env = process.env,
  reference,
  configuration,
}: HerdrLaunchOptions): Promise<void> {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) {
    throw new Error("Conversation creation requires an invoking Herdr pane.");
  }
  const invokingPaneId = env.HERDR_PANE_ID;
  const layoutResult = await herdr(exec, ["pane", "layout", "--pane", invokingPaneId], 5_000);
  const split = selectSplit(property(layoutResult, "layout"), invokingPaneId);
  const paneResult = await herdr(exec, [
    "pane", "split", split.target,
    "--direction", split.direction,
    "--cwd", configuration.cwd,
    "--no-focus",
  ], 30_000);
  const pane = property(paneResult, "pane");
  const paneId = property(pane, "pane_id");
  if (typeof paneId !== "string") {
    throw new Error("Herdr created no addressable pane; a pane may remain.");
  }

  const agentName = `companion-${reference.slice(0, 8).toLowerCase()}`;
  try {
    await herdr(exec, [
      "agent", "start", agentName,
      "--kind", "pi",
      "--pane", paneId,
      "--timeout", "30000",
      "--",
      "--session-id", reference,
      "--name", `companion-${reference.slice(0, 8)}`,
      "--no-extensions",
      "--extension", extensionPath,
      "--provider", configuration.provider,
      "--model", configuration.model,
      "--thinking", configuration.thinking,
    ], 35_000);
  } catch (cause: unknown) {
    throw new Error(`Herdr may have started conversation ${reference}; no rollback was attempted: ${message(cause)}`, {
      cause,
    });
  }
}

interface LayoutPane {
  paneId: string;
  x: number;
}

/** Selects launch-edge placement without retaining or managing pane state. */
function selectSplit(
  layout: unknown,
  invokingPaneId: string,
): { target: string; direction: "right" | "down" } {
  const rawPanes = property(layout, "panes");
  if (!Array.isArray(rawPanes) || rawPanes.length === 0) {
    throw new Error("Current tab layout has no panes.");
  }
  const panes: LayoutPane[] = rawPanes.map((pane) => {
    const paneId = property(pane, "pane_id");
    const x = property(property(pane, "rect"), "x");
    if (typeof paneId !== "string" || typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error("Current tab pane geometry is incomplete.");
    }
    return { paneId, x };
  });
  if (!panes.some(({ paneId }) => paneId === invokingPaneId)) {
    throw new Error("Invoking pane is outside the reported tab layout.");
  }
  if (panes.length === 1) return { target: invokingPaneId, direction: "right" };
  const leftmostX = Math.min(...panes.map(({ x }) => x));
  const rightHand = panes.find(({ x }) => x > leftmostX);
  return { target: rightHand?.paneId ?? invokingPaneId, direction: "down" };
}

async function herdr(exec: PiExec, args: string[], timeout: number): Promise<unknown> {
  const result = await exec("herdr", args, { timeout });
  if (result.code !== 0) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  let decoded: unknown;
  try { decoded = JSON.parse(result.stdout); }
  catch (cause: unknown) { throw new Error("Herdr returned invalid JSON.", { cause }); }
  if (!isMatching({ result: P._ }, decoded)) throw new Error("Herdr returned no result envelope.");
  return decoded.result;
}

function remoteError(code: string, errorMessage: string): Error & { code: string } {
  return Object.assign(new Error(errorMessage), { code });
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
