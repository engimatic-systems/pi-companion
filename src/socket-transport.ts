import { chmod, mkdir, rm } from "node:fs/promises";
import * as net from "node:net";
import { dirname } from "node:path";

import { err, ok, ResultAsync, type Result } from "neverthrow";
import { isMatching, P } from "ts-pattern";

import {
  parseConversationReference,
  type ConversationReference,
} from "./companion.js";

export const MAX_MESSAGE_BYTES = 16 * 1024;
const FRAME_LIMIT = 32 * 1024;

interface IntroduceRequest {
  version: 1;
  operation: "introduce";
  source: ConversationReference;
  destination: ConversationReference;
}

interface MessageRequest {
  version: 1;
  operation: "message";
  source: ConversationReference;
  destination: ConversationReference;
  message: string;
}

export type TransportRequest = IntroduceRequest | MessageRequest;
export type TransportAcknowledgement = { accepted: "introduce" | "message" };

export type SubmissionFailure =
  | { kind: "unavailable"; message: string; cause?: unknown }
  | { kind: "indeterminate"; message: string; cause?: unknown }
  | { kind: "rejected"; message: string; code: string; cause?: unknown };

export interface TransportListener {
  /** Destroys accepted sockets, stops acceptance, and removes the owned path. */
  close(): Promise<void>;
}

/**
 * Creates one bounded-frame request listener and owns its communication
 * resources until `close`. Closing also destroys incomplete accepted requests
 * so they cannot prevent shutdown indefinitely.
 */
export async function listen(
  socketPath: string,
  handler: (request: TransportRequest) => Promise<TransportAcknowledgement>,
): Promise<TransportListener> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    receiveFrame(socket, handler);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

/**
 * Makes one newline-delimited JSON request/acknowledgement attempt against a
 * destination socket. The operation never retries or replays the request.
 *
 * The caller-side timer covers both connecting and waiting for a response; it
 * neither imposes a receive-side timeout nor cancels remote handler work.
 * Failure before the socket emits `connect` is `unavailable`. Once connected,
 * write or acknowledgement failure is `indeterminate` because the receiver may
 * already have handled the request. `finish` lets only the first competing
 * timeout, write, data, error, or close event settle the Result and then destroys
 * the local socket; destruction cannot retract sent bytes or remote work.
 *
 * Response chunks accumulate through the first raw LF and are bounded by
 * `FRAME_LIMIT`. A positive acknowledgement must name the submitted operation.
 * It establishes that the remote handler fulfilled and that its acknowledgement
 * reached this caller—not agent processing, durability, or exactly-once
 * execution. A valid negative acknowledgement is `rejected`; an unusable
 * acknowledgement remains `indeterminate` and is not replayed.
 *
 * | Observation | Outcome |
 * | --- | --- |
 * | Connect failure or timeout before `connect` | `unavailable` |
 * | Matching positive acknowledgement | success |
 * | Valid negative acknowledgement | `rejected` |
 * | Write failure or timeout after `connect` | `indeterminate` |
 * | Close after `connect` without acknowledgement | `indeterminate` |
 * | Malformed, oversized, or mismatched acknowledgement | `indeterminate` |
 */
export function exchange(
  socketPath: string,
  request: TransportRequest,
  timeoutMs: number,
): ResultAsync<TransportAcknowledgement, SubmissionFailure> {
  return new ResultAsync(new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const frame = `${JSON.stringify(request)}\n`;
    // Connection is the failure-policy boundary: before it, the destination is
    // unavailable; after it, the receiver may have observed the request.
    let connected = false;
    // Timeout, write, response, error, and close can race independently. Only
    // the first terminal observation is allowed to choose the public outcome.
    let settled = false;
    let buffer = Buffer.alloc(0);
    // One caller deadline covers connection and acknowledgement, not remote
    // execution. Its classification snapshots the connection boundary above.
    const timer = setTimeout(() => finish(err({
      kind: connected ? "indeterminate" : "unavailable",
      message: connected
        ? "Submission timed out after connection; delivery is indeterminate and was not replayed."
        : "Destination is unavailable.",
    })), timeoutMs);

    const finish = (result: Result<TransportAcknowledgement, SubmissionFailure>): void => {
      if (settled) return;
      // Destroying can trigger more socket events, so reserve the result first.
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => {
      // Set this before writing so even an immediate write failure is treated
      // conservatively: connection means remote observation is now possible.
      connected = true;
      socket.write(frame, (cause?: Error | null) => {
        // A successful write callback is not an acknowledgement; only failure
        // is terminal here. Success continues waiting for a protocol response.
        if (cause) finish(err({
          kind: "indeterminate",
          message: "Submission write failed after connection; delivery is indeterminate and was not replayed.",
          cause,
        }));
      });
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      // Response chunks are not frames, so preserve order until raw LF. Check
      // the bound before delimiter extraction; same-chunk trailing bytes count.
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FRAME_LIMIT) {
        finish(err({ kind: "indeterminate", message: "Host response was too large; delivery was not replayed." }));
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      // Parsing preserves explicit rejection versus an unusable acknowledgement.
      finish(parseResponse(request, buffer.subarray(0, newline).toString("utf8")));
    });
    // An error is commonly followed by close; the settlement guard makes it inert.
    socket.once("error", (cause: Error) => finish(err({
      kind: connected ? "indeterminate" : "unavailable",
      message: connected
        ? "Submission failed after connection; delivery is indeterminate and was not replayed."
        : "Destination is unavailable.",
      cause,
    })));
    socket.once("close", () => {
      // A close without a protocol response says only whether connection was
      // established; after connection it cannot disprove remote handling.
      if (!settled) finish(err({
        kind: connected ? "indeterminate" : "unavailable",
        message: connected
          ? "Destination closed without acknowledgement; delivery is indeterminate and was not replayed."
          : "Destination is unavailable.",
      }));
    });
  }));
}

/**
 * Receives at most one newline-delimited request from an accepted socket.
 * TCP data events are arbitrary chunks, so bytes accumulate until LF rather
 * than treating a chunk as a frame. JSON string newlines are escaped by
 * `JSON.stringify`, so a multiline message does not contain the raw LF byte
 * used as the frame delimiter. The accumulated input is rejected once it
 * exceeds `FRAME_LIMIT`; this check happens before delimiter extraction, so any
 * bytes trailing LF in the same accumulated input also count toward the bound.
 *
 * `handled` reserves the connection as soon as a complete or oversized frame
 * is observed. That reservation prevents a second request from being parsed
 * while validation or the asynchronous handler is still completing. A valid
 * positive acknowledgement is encoded only after the handler fulfills; parse
 * failures and handler rejection produce negative responses. Writing a response
 * and ending the socket does not establish that the peer received it.
 *
 * This receive side has no timeout and does not cancel an in-flight handler.
 * EOF before dispatch discards an incomplete frame; EOF after dispatch leaves
 * the handler to finish and attempt its response. Listener shutdown destroys
 * accepted sockets but likewise does not cancel handler work. Socket failure or
 * shutdown may make a later response impossible, so `respond` becomes a no-op
 * for a destroyed socket. Caller timeout and delivery classification belong to
 * `exchange`, not this function.
 */
function receiveFrame(
  socket: net.Socket,
  handler: (request: TransportRequest) => Promise<TransportAcknowledgement>,
): void {
  let buffer = Buffer.alloc(0);
  let handled = false;
  const respond = (value: unknown): void => {
    // Shutdown or peer failure can win the race with asynchronous handling.
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    // Chunks preserve byte order but not application-frame boundaries.
    buffer = Buffer.concat([buffer, chunk]);
    // Enforce the bound before searching for LF. This intentionally counts any
    // trailing bytes delivered with the first frame and stops further accumulation.
    if (buffer.length > FRAME_LIMIT) {
      handled = true;
      respond({ ok: false, error: { code: "invalid_request", message: "Host request is too large." } });
      return;
    }
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    // Reserve before parsing/handling so later chunks cannot start another request.
    handled = true;
    const request = parseRequest(buffer.subarray(0, newline).toString("utf8"));
    if (request.isErr()) {
      respond({ ok: false, error: { code: "invalid_request", message: request.error.message } });
      return;
    }
    // `handled` remains reserved while this Promise is pending. The response
    // therefore describes this one handler outcome; later input cannot race it.
    handler(request.value).then(
      (acknowledgement) => respond({ ok: true, result: acknowledgement }),
      (cause: unknown) => respond({
        ok: false,
        error: {
          code: errorCode(cause) ?? "rejected",
          message: message(cause),
        },
      }),
    );
  });
  socket.once("end", () => {
    // EOF before dispatch makes the partial frame unusable. EOF after dispatch
    // does not cancel the handler; its eventual response may still lose the race.
    if (!handled) socket.destroy();
  });
  // Socket errors have no reliable response path; consume the event to avoid an uncaught error.
  socket.once("error", () => {});
}

function parseRequest(frame: string): Result<TransportRequest, Error> {
  let decoded: unknown;
  try { decoded = JSON.parse(frame); }
  catch (cause: unknown) { return err(new Error("Host request is not valid JSON.", { cause })); }
  // Establish the protocol version and closed operation vocabulary before
  // interpreting variant fields or constructing branded references.
  if (!isRecord(decoded) || decoded.version !== 1
      || (decoded.operation !== "introduce" && decoded.operation !== "message")) {
    return err(new Error("Host request envelope is invalid."));
  }
  // Both variants require valid identities; check them before message-specific
  // validation so malformed references retain diagnostic precedence.
  const source = parseConversationReference(decoded.source);
  const destination = parseConversationReference(decoded.destination);
  if (!source || !destination) return err(new Error("Host request references are invalid."));
  if (decoded.operation === "introduce") {
    return ok({ version: 1, operation: "introduce", source, destination });
  }
  if (typeof decoded.message !== "string" || decoded.message.length === 0
      || Buffer.byteLength(decoded.message, "utf8") > MAX_MESSAGE_BYTES) {
    return err(new Error("Host request message is invalid."));
  }
  return ok({ version: 1, operation: "message", source, destination, message: decoded.message });
}

function parseResponse(
  request: TransportRequest,
  frame: string,
): Result<TransportAcknowledgement, SubmissionFailure> {
  let decoded: unknown;
  try { decoded = JSON.parse(frame); }
  catch (cause: unknown) {
    return err({ kind: "indeterminate", message: "Host response was malformed; delivery was not replayed.", cause });
  }
  // A well-formed negative envelope is an authoritative rejection even when
  // its optional error detail is absent or malformed.
  if (isMatching({ ok: false, error: P.optional(P._) }, decoded)) {
    const remote = isRecord(decoded.error) ? decoded.error : undefined;
    return err({
      kind: "rejected",
      code: typeof remote?.code === "string" ? remote.code : "rejected",
      message: typeof remote?.message === "string" ? remote.message : "Destination rejected submission.",
      cause: decoded,
    });
  }
  // Positive acknowledgement is meaningful only for the submitted operation;
  // every other shape leaves delivery uncertain and must not trigger replay.
  if (!isMatching({ ok: true, result: { accepted: P.string } }, decoded)
      || decoded.result.accepted !== request.operation) {
    return err({ kind: "indeterminate", message: "Host acknowledgement was invalid; delivery was not replayed." });
  }
  return ok({ accepted: request.operation });
}

function errorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === "string" ? value.code : undefined;
}

function message(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
