import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { conversationReference } from "../src/companion.js";
import {
  exchange,
  listen,
  type TransportAcknowledgement,
  type TransportRequest,
} from "../src/socket-transport.js";

const source = conversationReference("40000000-0000-4000-8000-000000000001");
const destination = conversationReference("40000000-0000-4000-8000-000000000002");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("Transport listener owns its socket through exchange and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-transport-"));
  const socketPath = join(root, "listener.sock");
  const handler = async (request: TransportRequest): Promise<TransportAcknowledgement> => ({
    accepted: request.operation,
  });
  const listener = await listen(socketPath, handler);
  try {
    const accepted = await exchange(socketPath, {
      version: 1,
      operation: "introduce",
      source,
      destination,
    }, 1_000);

    assert.deepEqual(accepted.isOk() && accepted.value, { accepted: "introduce" });
    assert.equal((await stat(socketPath)).isSocket(), true);

    await listener.close();

    await assert.rejects(stat(socketPath), { code: "ENOENT" });
    const unavailable = await exchange(socketPath, {
      version: 1,
      operation: "introduce",
      source,
      destination,
    }, 1_000);
    assert.equal(unavailable.isErr() && unavailable.error.kind, "unavailable");
  } finally {
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Transport classifies post-connection uncertainty without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-transport-"));
  const socketPath = join(root, "uncertain.sock");
  let requests = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => { requests += 1; });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await exchange(socketPath, {
      version: 1,
      operation: "message",
      source,
      destination,
      message: "maybe delivered",
    }, 40);
    await delay(20);

    assert.equal(result.isErr() && result.error.kind, "indeterminate");
    assert.equal(requests, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
