// Thin client for the /conversations API.
//
//   GET  /conversations                       list threads
//   GET  /conversations/:id                   one thread with its messages
//   POST /conversations                       start a thread (streams the reply)
//   POST /conversations/:id/messages          continue a thread (streams the reply)
//
// The two POSTs request a stream (Accept: text/event-stream) but degrade
// gracefully to a plain JSON response, so they work no matter how you implement
// the endpoint.
//
// Streaming contract — the server wraps every agent payload in a `token` event
// whose data is an AgentStreamEventPayload:
//   event: meta   data: { "conversationId": "..." }  // once, before the tokens
//   event: token  data: { "phase": "reasoning", "content": "…thinking text…" }
//   event: token  data: { "phase": "working",   "content": { tool, args } }
//   event: token  data: { "phase": "done",      "content": "the final reply" }
//   event: error  data: { "message": "..." }
//   event: done   data: {}                    // end of turn
//
// Only the `done` payload holds the reply, and it always arrives last. The
// `reasoning` ones are the model's thinking, batched server-side into ~50-word
// pieces; `working` ones are tool calls, shown as transient status.
//
// Non-streaming contract (application/json):
//   { "reply": "...", "conversationId": "..." }   on success
//   { "error": "..." }                            on failure

const API = "/api";
const ENDPOINT = `${API}/conversations`;
const TASKS_ENDPOINT = `${API}/tasks`;
const SETTINGS_ENDPOINT = `${API}/settings`;

/** App-wide settings. There is one of these, not one per user. */
export interface Settings {
  fullName: string;
  /** What the assistant calls you. */
  preferredName: string;
  /** Standing instructions added to every agent run. */
  instructions: string;
  defaultModel: string;
  updatedAt: string;
  /** Valid values for `defaultModel`, so the UI never hardcodes a list. */
  availableModels: string[];
}

export type SettingsUpdate = Partial<
  Pick<Settings, "fullName" | "preferredName" | "instructions" | "defaultModel">
>;

export async function getSettings(signal?: AbortSignal): Promise<Settings> {
  const res = await fetch(SETTINGS_ENDPOINT, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Settings;
}

export async function updateSettings(update: SettingsUpdate): Promise<Settings> {
  const res = await fetch(SETTINGS_ENDPOINT, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Settings;
}

/** Put every field back to its default. */
export async function resetSettings(): Promise<Settings> {
  const res = await fetch(SETTINGS_ENDPOINT, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Settings;
}

/** A scheduled task, as returned by `GET /tasks`. */
export interface Task {
  id: string;
  creator: "user" | "assistant";
  prompt: string;
  /** Cron expression the task runs on. */
  schedule: string;
  /** Max number of runs; null means unlimited. */
  limit: number | null;
  sourceConversation: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One execution of a task. */
export interface TaskRun {
  id: string;
  status: "in_progress" | "failed" | "success";
  transcript: string | null;
  startedAt: string;
  endedAt: string;
}

/** A task plus its run history, newest run first. */
export type TaskWithRuns = Task & { runs: TaskRun[] };

/** Newest task first. Runs are not included — use `getTask` for those. */
export async function listTasks(signal?: AbortSignal): Promise<Task[]> {
  const res = await fetch(TASKS_ENDPOINT, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { tasks?: Task[] };
  return data.tasks ?? [];
}

/** One task with its full run history. */
export async function getTask(
  taskId: string,
  signal?: AbortSignal
): Promise<TaskWithRuns> {
  const res = await fetch(`${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as TaskWithRuns;
}

/** Deletes the task and its runs. Returns how many runs went with it. */
export async function deleteTask(taskId: string): Promise<number> {
  const res = await fetch(`${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { deletedRuns?: number };
  return data.deletedRuns ?? 0;
}

/** Deletes the conversation and its messages. Returns how many messages went. */
export async function deleteConversation(conversationId: string): Promise<number> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { deletedMessages?: number };
  return data.deletedMessages ?? 0;
}

/** A tool invocation the agent has started. */
export interface AgentToolCall {
  /** Tool name as registered by its MCP server, e.g. "searxng_web_search". */
  tool: string;
  /** Arguments the model passed, when the run reports them. */
  args?: unknown;
}

export type AgentStreamEventPayload =
  | { phase: "reasoning"; content: string }
  | { phase: "working"; content: AgentToolCall }
  | { phase: "done"; content: string };

export interface ChatHandlers {
  /** A tool call — render as transient status, not as the reply. */
  onStep?: (call: AgentToolCall) => void;
  /**
   * A piece of the model's thinking. Append these in order; the server has
   * already batched them, so one call is one visible update.
   */
  onReasoning?: (chunk: string) => void;
  /** The effective reply. Fires once, at the end of the turn. */
  onReply?: (text: string) => void;
  /** Called on a server-reported error. */
  onError?: (message: string) => void;
  /**
   * The thread this turn belongs to. Fires before the first step when starting
   * a new conversation — that id is the only way to continue the thread later.
   */
  onConversation?: (conversationId: string) => void;
  /** Abort the request (e.g. a Stop button). */
  signal?: AbortSignal;
}

/** A thread in the sidebar list. */
export interface ConversationSummary {
  id: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  lastMessageAt: string;
}

/** One stored turn, as returned by `GET /conversations/:id`. */
export interface StoredMessage {
  id: string;
  author: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  createdAt: string;
  messages: StoredMessage[];
}

/** Newest thread first. */
export async function listConversations(
  signal?: AbortSignal
): Promise<ConversationSummary[]> {
  const res = await fetch(ENDPOINT, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { conversations?: ConversationSummary[] };
  return data.conversations ?? [];
}

/** One thread with its full message history. */
export async function getConversation(
  conversationId: string,
  signal?: AbortSignal
): Promise<ConversationDetail> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(conversationId)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ConversationDetail;
}

/**
 * Send a message and stream the reply. Resolves with the final assistant text.
 *
 * Omit `conversationId` to start a new thread — the server creates one and
 * reports its id through `onConversation`.
 */
export async function sendChat(
  message: string,
  handlers: ChatHandlers = {},
  conversationId?: string
): Promise<string> {
  const url = conversationId
    ? `${ENDPOINT}/${encodeURIComponent(conversationId)}/messages`
    : ENDPOINT;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    // Both routes validate a `{ message }` body.
    body: JSON.stringify({ message }),
    signal: handlers.signal,
  });

  if (!res.ok) {
    const message = await readError(res);
    handlers.onError?.(message);
    throw new Error(message);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Non-streaming fallback: plain JSON.
  if (!contentType.includes("text/event-stream") || !res.body) {
    const data = (await res.json().catch(() => ({}))) as {
      reply?: string;
      result?: string;
      error?: string;
      conversationId?: string;
    };
    if (data.error) {
      handlers.onError?.(data.error);
      throw new Error(data.error);
    }
    if (data.conversationId) handlers.onConversation?.(data.conversationId);
    const text = data.reply ?? data.result ?? "";
    if (text) handlers.onReply?.(text);
    return text;
  }

  return readSseStream(res.body, handlers);
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatHandlers
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const { event, data } = parseSseEvent(rawEvent);
        if (data === "") continue;

        let payload: any = data;
        try {
          payload = JSON.parse(data);
        } catch {
          /* leave as raw string */
        }

        switch (event) {
          case "meta":
            if (payload?.conversationId) {
              handlers.onConversation?.(String(payload.conversationId));
            }
            break;
          case "token": {
            if (payload?.phase === "done") {
              reply = stringifyReply(payload.content);
              handlers.onReply?.(reply);
            } else if (payload?.phase === "reasoning") {
              const chunk = payload.content;
              if (typeof chunk === "string" && chunk) handlers.onReasoning?.(chunk);
            } else if (payload?.phase === "working") {
              handlers.onStep?.(payload.content ?? { tool: "" });
            }
            break;
          }
          case "error":
            handlers.onError?.(
              typeof payload === "string" ? payload : payload?.message ?? "Error"
            );
            break;
          case "done":
            return reply;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return reply;
}

// The agent's return value is a string, but a structured-output run can resolve
// to an object — don't render "[object Object]".
function stringifyReply(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseSseEvent(raw: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return { event, data: dataLines.join("\n") };
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
