import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

import {
  decodeAction,
  runAction,
  toolContract,
  type Outcome,
} from "./actions.js";
import {
  Companion,
  conversationReference,
  type ConversationReference,
} from "./companion.js";
import { humanCommand, parseCommand } from "./command.js";
import { createHostConnection } from "./host.js";
import { Runtime } from "./runtime.js";

/** Companion Pi extension entry point. */
export default function companion(pi: ExtensionAPI, agentDir = getAgentDir()): void {
  const extensionPath = fileURLToPath(import.meta.url);
  let active: Runtime | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // Pi normally shuts down before replacement, but bindExtensions() can emit
    // another session_start without shutdown. Retire any existing Runtime before
    // rebinding its listener; clear active first so replacement failure cannot
    // leave a stopped Runtime exposed to commands or tools.
    const previous = active;
    active = undefined;
    if (previous) await previous.stop();

    const reference = conversationReference(ctx.sessionManager.getSessionId());
    const companion = new Companion(reference, agentDir);
    const connection = createHostConnection({
      reference,
      exec: pi.exec.bind(pi),
      extensionPath,
      deliver(source, content) {
        deliverMessage(pi, source, content);
      },
    });
    const candidate = new Runtime(companion, connection);
    try {
      await candidate.start();
      active = candidate;
    } catch (cause: unknown) {
      await candidate.stop().catch(() => {});
      throw cause;
    }
  });

  pi.on("session_shutdown", async () => {
    const stopping = active;
    active = undefined;
    if (stopping) await stopping.stop();
  });

  pi.registerCommand(humanCommand.name, {
    description: humanCommand.description,
    handler: async (raw, ctx) => {
      try {
        const runtime = requireActive(active);
        const action = await parseCommand(raw);
        const outcome = await runAction(runtime, action, ctx);
        ctx.ui.notify(render(outcome), outcome.status === "error" ? "error" : "info");
      } catch (cause: unknown) {
        ctx.ui.notify(message(cause), "error");
      }
    },
  });

  pi.registerTool({
    ...toolContract,
    async execute(_id, input, _signal, _onUpdate, ctx) {
      let outcome: Outcome;
      try {
        const action = decodeAction(input);
        const runtime = requireActive(active);
        outcome = await runAction(runtime, action, ctx);
      } catch (cause: unknown) {
        outcome = { status: "error", message: message(cause) };
      }
      return {
        content: [{ type: "text", text: render(outcome) }],
        details: outcome,
      };
    },
  });
}

function deliverMessage(
  pi: ExtensionAPI,
  source: ConversationReference,
  content: string,
): void {
  pi.sendMessage({
    customType: "companion-message",
    content: `Message from conversation ${source}:\n\n${content}`,
    display: true,
    details: { source },
  }, { deliverAs: "steer", triggerTurn: true });
}

function requireActive(active: Runtime | undefined): Runtime {
  if (!active) throw new Error("Companion Runtime is not active for this conversation.");
  return active;
}

function render(outcome: Outcome): string {
  switch (outcome.status) {
    case "opened":
      return `Conversation created: ${outcome.reference}.${outcome.submission === "accepted"
        ? " Ordinary message accepted by Host." : ""}`;
    case "listed":
      return outcome.destinations.length === 0
        ? `Conversation ${outcome.reference} has no local destinations.`
        : `Conversation ${outcome.reference} destinations:\n${outcome.destinations.join("\n")}`;
    case "introduced":
      return outcome.destination === outcome.reference
        ? "Self-introduction changes no destinations; no message submitted."
        : `Conversations ${outcome.reference} and ${outcome.destination} introduced; no message submitted.`;
    case "accepted":
      return `Host accepted the message submission to ${outcome.destination}.`;
    case "forgotten":
      return outcome.removed
        ? `Forgot ${outcome.destination} locally; the other conversation was not stopped.`
        : `Conversation ${outcome.destination} was not in the local destination collection.`;
    case "error":
      return `${outcome.kind ?? "error"}: ${outcome.message}${outcome.destinationForgotten
        ? " The unavailable destination was forgotten locally." : ""}`;
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
