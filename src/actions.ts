import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import {
  conversationReference,
  type ConversationReference,
} from "./companion.js";
import type {
  ConversationConfiguration,
  SubmissionAcceptance,
  ThinkingLevel,
} from "./host.js";
import { type Runtime, type RuntimeSubmissionFailure } from "./runtime.js";

export const THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const satisfies readonly ThinkingLevel[];

const messageSchema = Type.String();
const providerSchema = Type.String();
const modelSchema = Type.String();
const thinkingSchema = StringEnum(THINKING_LEVELS);

const openActionSchema = Type.Object({
  action: Type.Literal("open"),
  message: Type.Optional(messageSchema),
  provider: Type.Optional(providerSchema),
  model: Type.Optional(modelSchema),
  thinking: Type.Optional(thinkingSchema),
}, { additionalProperties: false });

const listActionSchema = Type.Object({
  action: Type.Literal("list"),
}, { additionalProperties: false });

const introduceActionSchema = Type.Object({
  action: Type.Literal("introduce"),
  destination: Type.String(),
}, { additionalProperties: false });

const sendActionSchema = Type.Object({
  action: Type.Literal("send"),
  destination: Type.String(),
  message: messageSchema,
}, { additionalProperties: false });

const forgetActionSchema = Type.Object({
  action: Type.Literal("forget"),
  destination: Type.String(),
}, { additionalProperties: false });

/** The authoritative legal shapes accepted from human and structured input. */
export const actionSchema = Type.Union([
  openActionSchema,
  listActionSchema,
  introduceActionSchema,
  sendActionSchema,
  forgetActionSchema,
]);
export type Action = Static<typeof actionSchema>;

const actionNames = [
  openActionSchema.properties.action.const,
  listActionSchema.properties.action.const,
  introduceActionSchema.properties.action.const,
  sendActionSchema.properties.action.const,
  forgetActionSchema.properties.action.const,
] as const;

// Pi advertises one root object, while actionSchema remains authoritative for
// which optional fields are legal for each discriminated action.
export const toolContract = {
  name: "companion",
  label: "Companion",
  description: "Create a live conversation, introduce an existing conversation by destination, list local destinations, submit an ordinary message, or forget locally.",
  parameters: Type.Object({
    action: StringEnum(actionNames),
    destination: Type.Optional(Type.String()),
    message: Type.Optional(messageSchema),
    provider: Type.Optional(providerSchema),
    model: Type.Optional(modelSchema),
    thinking: Type.Optional(thinkingSchema),
  }, { additionalProperties: false }),
} as const;

/** Parses unknown structured input into the canonical action contract. */
export function decodeAction(input: unknown): Action {
  if (!Check(actionSchema, input)) throw new Error("Invalid Companion action fields.");
  return input;
}

export type Outcome =
  | { status: "opened"; reference: ConversationReference; submission?: SubmissionAcceptance["status"] }
  | { status: "listed"; reference: ConversationReference; destinations: readonly ConversationReference[] }
  | { status: "introduced"; reference: ConversationReference; destination: ConversationReference }
  | { status: "accepted"; destination: ConversationReference }
  | { status: "forgotten"; destination: ConversationReference; removed: boolean }
  | {
      status: "error";
      kind: "submission_failed_after_creation";
      message: string;
      reference: ConversationReference;
      failure: RuntimeSubmissionFailure;
      destinationForgotten: boolean;
    }
  | {
      status: "error";
      kind?: "creation_failed" | RuntimeSubmissionFailure["kind"];
      message: string;
      reference?: ConversationReference;
      destinationForgotten?: boolean;
    };

/** Executes one canonical action through Runtime without presenting its outcome. */
export async function runAction(
  runtime: Runtime,
  action: Action,
  ctx: ExtensionContext,
): Promise<Outcome> {
  switch (action.action) {
    case "open": {
      const opened = await runtime.open(configuration(ctx, action));
      if (opened.isErr()) {
        return {
          status: "error",
          kind: opened.error.kind,
          message: opened.error.message,
          reference: opened.error.attemptedReference,
        };
      }
      const reference = opened.value;
      if (action.message === undefined) return { status: "opened", reference };

      const submitted = await runtime.submit(reference, action.message);
      if (submitted.isOk()) {
        return { status: "opened", reference, submission: submitted.value.status };
      }
      return {
        status: "error",
        kind: "submission_failed_after_creation",
        message: `Conversation ${reference} was created, but the ordinary message was not accepted. ${submitted.error.message}`,
        reference,
        failure: submitted.error,
        destinationForgotten: submitted.error.kind === "unavailable",
      };
    }
    case "list":
      return {
        status: "listed",
        reference: runtime.reference,
        destinations: runtime.destinations(),
      };
    case "introduce": {
      const destination = conversationReference(action.destination);
      const introduced = await runtime.introduce(destination);
      if (introduced.isOk()) return { status: "introduced", reference: runtime.reference, destination };
      return {
        status: "error",
        kind: introduced.error.kind,
        message: `Introduction with ${destination} did not complete. Local destinations unchanged. ${introduced.error.message}${introduced.error.kind === "indeterminate"
          ? " The peer may already know this conversation." : ""}`,
        reference: destination,
      };
    }
    case "send": {
      const destination = conversationReference(action.destination);
      const submitted = await runtime.submit(destination, action.message);
      if (submitted.isOk()) return { status: "accepted", destination };
      return {
        status: "error",
        kind: submitted.error.kind,
        message: submitted.error.message,
        reference: destination,
        destinationForgotten: submitted.error.kind === "unavailable",
      };
    }
    case "forget": {
      const destination = conversationReference(action.destination);
      return {
        status: "forgotten",
        destination,
        removed: runtime.forget(destination),
      };
    }
  }
}

function configuration(
  ctx: ExtensionContext,
  selection: Static<typeof openActionSchema>,
): ConversationConfiguration {
  if (!ctx.model) throw new Error("A selected Pi model is required to create a conversation.");
  const provider = selection.provider ?? ctx.model.provider;
  const model = selection.model ?? ctx.model.id;
  const selectedModel = ctx.modelRegistry.find(provider, model);
  if (!selectedModel) throw new Error(`Unknown Pi model: ${provider}/${model}.`);
  if (!ctx.modelRegistry.getAvailable().some(
    (candidate) => candidate.provider === provider && candidate.id === model,
  )) {
    throw new Error(`Pi model is not currently available: ${provider}/${model}.`);
  }
  const thinking = selection.thinking ?? ctx.thinkingLevel;
  if (!isThinkingLevel(thinking)) {
    throw new Error(`Invalid Pi thinking level: ${thinking ?? "none"}.`);
  }
  const supported = getSupportedThinkingLevels(selectedModel);
  if (!supported.includes(thinking)) {
    throw new Error(
      `Thinking level ${thinking} is not supported by ${provider}/${model}. Supported levels: ${supported.join(", ")}.`,
    );
  }
  return { cwd: ctx.cwd, provider, model, thinking };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
