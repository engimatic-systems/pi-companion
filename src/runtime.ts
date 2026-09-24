import { errAsync, type ResultAsync } from "neverthrow";

import { type Companion, type ConversationReference } from "./companion.js";
import {
  MAX_MESSAGE_BYTES,
  type ConversationConfiguration,
  type CreationFailure,
  type HostConnection,
  type SubmissionAcceptance,
  type SubmissionFailure,
} from "./host.js";

export type RuntimeSubmissionFailure =
  | { kind: "invalid_message"; message: string }
  | { kind: "unknown_destination"; destination: ConversationReference; message: string }
  | SubmissionFailure;

/** Coordinates Host operations with changes to one conversation-local model. */
export class Runtime {
  constructor(
    private readonly companion: Companion,
    private readonly connection: HostConnection,
  ) {}

  get reference(): ConversationReference {
    return this.companion.reference;
  }

  /** Returns the local destination snapshot without probing Host. */
  destinations(): readonly ConversationReference[] {
    return this.companion.destinations();
  }

  /** Applies an explicit local forgetting request without changing Host. */
  forget(reference: ConversationReference): boolean {
    return this.companion.forget(reference);
  }

  /** Starts Host delivery and routes introduction notices into local state. */
  start(): Promise<void> {
    return this.connection.start((reference) => this.companion.introduce(reference));
  }

  /** Stops only the Host resources coordinated by this Runtime. */
  stop(): Promise<void> {
    return this.connection.stop();
  }

  /** Introduces and returns a reference only after Host creation succeeds. */
  open(
    configuration: ConversationConfiguration,
  ): ResultAsync<ConversationReference, CreationFailure> {
    return this.connection.create(configuration).map((reference) => {
      this.companion.introduce(reference);
      return reference;
    });
  }

  /**
   * Submits valid text to a known destination exactly once. Only
   * Host-reported unavailability triggers local forgetting.
   */
  submit(
    destination: ConversationReference,
    message: string,
  ): ResultAsync<SubmissionAcceptance, RuntimeSubmissionFailure> {
    const invalid = invalidMessage(message);
    if (invalid) return errAsync(invalid);
    if (!this.companion.has(destination)) {
      return errAsync({
        kind: "unknown_destination",
        destination,
        message: `Conversation ${destination} is not in the local destination collection.`,
      });
    }
    return this.connection.submit(destination, message).mapErr((failure): RuntimeSubmissionFailure => {
      if (failure.kind === "unavailable") this.companion.forget(destination);
      return failure;
    });
  }
}

function invalidMessage(message: string): RuntimeSubmissionFailure | undefined {
  if (typeof message !== "string" || message.length === 0) {
    return { kind: "invalid_message", message: "A message must contain text." };
  }
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    return {
      kind: "invalid_message",
      message: `A message must be at most ${MAX_MESSAGE_BYTES} UTF-8 bytes.`,
    };
  }
  return undefined;
}
