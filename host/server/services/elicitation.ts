// Routes a server's elicitation request to whoever is watching this run.
//
// The MCP client fulfils an `input_required` tool result by calling the
// registered elicitation handler and then retrying the tool call with the
// answer — all inside `callTool`. The agent never sees the round trip; it just
// gets a tool result. So the only thing this module has to do is answer the
// question, which for a conversation means asking a human and waiting.
//
// Two things make that awkward, and both are handled here:
//
//   1. One client, many runs. `Agent.sharedClient` is process-wide and takes a
//      single `onElicitation` callback whose parameters carry no run, no
//      conversation and no server name. AsyncLocalStorage supplies the missing
//      correlation: a run installs its channel, and the callback reads whatever
//      is current when the tool call happens.
//   2. Nobody may be listening. A scheduled run has no UI, and a browser can
//      close mid-question. Both must resolve, or the agent blocks until the
//      MCP request times out.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** What the model wants to know, as handed to the UI. */
export interface ElicitationRequest {
  id: string;
  /** The question, already phrased for a person. */
  message: string;
  /** JSON Schema of the expected answer — the UI builds its form from this. */
  requestedSchema: Record<string, unknown>;
  /** "form" collects fields; "url" sends the user somewhere to act. */
  mode?: string;
  url?: string;
}

/** The user's verdict, in the shape the MCP client expects back. */
export type ElicitationAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** How a run reaches its user. Returning nothing means nobody answered. */
export interface ElicitationChannel {
  ask(request: ElicitationRequest): void;
}

/**
 * How long a question may sit unanswered.
 *
 * Well under the MCP request timeout, so an unanswered question fails as a
 * decline the agent can act on rather than as a transport error it cannot.
 */
const ANSWER_TIMEOUT_MS = 3 * 60 * 1000;

const channels = new AsyncLocalStorage<ElicitationChannel>();

/** In-flight questions, keyed by the id sent to the UI. */
const pending = new Map<string, (answer: ElicitationAnswer) => void>();

/**
 * Run `fn` with a channel the elicitation handler can reach.
 *
 * Anything the run awaits inherits the store, including the tool call deep
 * inside the agent loop that triggers the question.
 */
export function withElicitationChannel<T>(channel: ElicitationChannel, fn: () => Promise<T>): Promise<T> {
  return channels.run(channel, fn);
}

/**
 * The client's `onElicitation`. Never throws: an error here would surface as a
 * failed tool call rather than as an unanswered question.
 */
export async function handleElicitation(params: {
  mode?: string;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
}): Promise<ElicitationAnswer> {
  const channel = channels.getStore();

  // A scheduled run, or a run started outside a request. Declining is the
  // honest answer and lets the agent choose what to do without a human.
  if (!channel) return { action: "decline" };

  const id = randomUUID();
  const request: ElicitationRequest = {
    id,
    message: params.message ?? "The agent needs more information to continue.",
    requestedSchema: params.requestedSchema ?? { type: "object", properties: {} },
    mode: params.mode,
    url: params.url,
  };

  return new Promise<ElicitationAnswer>((resolve) => {
    const settle = (answer: ElicitationAnswer) => {
      if (!pending.delete(id)) return
      clearTimeout(timer);
      resolve(answer);
    };

    const timer = setTimeout(() => settle({ action: "cancel" }), ANSWER_TIMEOUT_MS);
    // Unref so a question in flight can't hold the process open on shutdown.
    timer.unref?.();

    pending.set(id, settle);

    try {
      channel.ask(request);
    } catch (error) {
      // The stream is gone — the user will never see this.
      console.warn(`Could not deliver elicitation ${id}:`, error);
      settle({ action: "cancel" });
    }
  });
}

/** Answer a pending question. False when it already timed out or was answered. */
export function resolveElicitation(id: string, answer: ElicitationAnswer): boolean {
  const settle = pending.get(id);
  if (!settle) return false;
  settle(answer);
  return true;
}

/**
 * Cancel every question a stream was waiting on.
 *
 * Called when the connection drops: without it the agent sits until the
 * timeout for an answer that can no longer arrive.
 */
export function cancelElicitations(ids: Iterable<string>): void {
  for (const id of ids) pending.get(id)?.({ action: "cancel" });
}
