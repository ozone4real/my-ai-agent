import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import Markdown from "./Markdown";
import {
  deleteConversation,
  deleteTask,
  getConversation,
  getTask,
  listConversations,
  listTasks,
  sendChat,
  type ConversationSummary,
  type Task,
  type TaskWithRuns,
} from "./api";
import { describeStep } from "./steps";
import { SettingsPane } from "./SettingsPane";
import { TaskDetail } from "./TaskDetail";
import { useArmedAction } from "./useArmedAction";

interface Message {
  id: string;
  role: "user" | "assistant";
  /** The effective reply — only ever set from the `done` payload. */
  content: string;
  /** The live one-line status while the turn is in flight; cleared when done. */
  status?: string;
  /** How many steps the agent took, for the footnote after it finishes. */
  steps: number;
  error?: string;
  /** The model's thinking, accumulated across `reasoning` payloads. */
  reasoning: string;
  /** Whether the thinking panel is expanded. Auto-collapses when the reply lands. */
  reasoningOpen: boolean;
  /** Wall-clock ms spent thinking, for the collapsed summary line. */
  reasoningMs?: number;
  /** Set on the first reasoning chunk, cleared when the turn ends. */
  reasoningStartedAt?: number;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());

/**
 * Append a reasoning chunk, breaking paragraphs between separate thinking
 * passes.
 *
 * The server slices chunks just after a word, so a continuation always *starts*
 * with the whitespace that followed it. A chunk starting on a non-space is
 * therefore the first of a fresh pass — the model thinking again after a tool
 * call — and would otherwise be glued onto the previous sentence.
 */
function appendReasoning(previous: string, chunk: string): string {
  if (!previous) return chunk;
  const joins = /\s$/.test(previous) || /^\s/.test(chunk);
  return joins ? previous + chunk : `${previous}\n\n${chunk}`;
}

/**
 * The thinking panel. Streams open while the model reasons, then collapses to a
 * one-line summary once the reply lands — the same shape Claude and DeepSeek
 * use, where the thinking is available but not in the way.
 */
function Thinking({
  message,
  onToggle,
}: {
  message: Message;
  onToggle: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const live = Boolean(message.status);

  // Follow the text as it streams, but only while it's actually streaming —
  // yanking the scroll on a panel the user opened later would be hostile.
  useEffect(() => {
    if (!live || !message.reasoningOpen) return;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [message.reasoning, message.reasoningOpen, live]);

  const seconds = message.reasoningMs
    ? Math.max(1, Math.round(message.reasoningMs / 1000))
    : 0;

  return (
    <div className={`thinking ${message.reasoningOpen ? "open" : ""}`}>
      <button
        className="thinking-head"
        onClick={onToggle}
        aria-expanded={message.reasoningOpen}
      >
        <span className="thinking-caret" aria-hidden="true">
          ▶
        </span>
        {live ? (
          <span className="status-text">Thinking…</span>
        ) : (
          <span className="thinking-label">
            Thought{seconds ? ` for ${seconds}s` : ""}
          </span>
        )}
      </button>

      {message.reasoningOpen && (
        <div className="thinking-body" ref={bodyRef}>
          {message.reasoning}
        </div>
      )}
    </div>
  );
}

/** "Today 14:02" / "12 Mar" — enough to place a thread without the full stamp. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function ConversationRow({
  conversation,
  active,
  disabled,
  deleting,
  onOpen,
  onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  disabled: boolean;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { armed, trigger } = useArmedAction(onDelete, conversation.id);

  return (
    <div className={`row-wrap ${active ? "active" : ""} ${armed ? "armed" : ""}`}>
      <button className="conversation" onClick={onOpen} disabled={disabled}>
        <span className="conversation-preview">
          {conversation.preview || "Empty conversation"}
        </span>
        <span className="conversation-meta">
          {armed ? (
            // Replaces the metadata rather than sitting beside it — at this
            // width there is no room for both, and the warning matters more.
            <span className="row-armed-note">
              Delete {conversation.messageCount} message
              {conversation.messageCount === 1 ? "" : "s"}? Click ✕ again
            </span>
          ) : (
            <>
              {conversation.messageCount} message
              {conversation.messageCount === 1 ? "" : "s"} ·{" "}
              {formatWhen(conversation.lastMessageAt)}
            </>
          )}
        </span>
      </button>
      <button
        className={`row-delete ${armed ? "armed" : ""}`}
        title={
          armed
            ? "Click again to delete this conversation and its messages"
            : "Delete conversation"
        }
        aria-label={armed ? "Confirm delete conversation" : "Delete conversation"}
        disabled={disabled || deleting}
        onClick={trigger}
      >
        ✕
      </button>
    </div>
  );
}

/** Which collection the sidebar is browsing. */
type Pane = "chats" | "tasks" | "settings";

interface Route {
  pane: Pane;
  conversationId: string | null;
  taskId: string | null;
}

/**
 * The URL is the source of truth for what's selected, so refresh, back/forward
 * and deep links work without a second copy of the state.
 */
function parseRoute(pathname: string): Route {
  const [, head, id] = pathname.split("/");
  if (head === "settings") return { pane: "settings", conversationId: null, taskId: null };
  if (head === "tasks") return { pane: "tasks", conversationId: null, taskId: id || null };
  if (head === "conversations" && id) {
    return { pane: "chats", conversationId: id, taskId: null };
  }
  return { pane: "chats", conversationId: null, taskId: null };
}

export function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { pane, conversationId: activeId, taskId } = useMemo(
    () => parseRoute(pathname),
    [pathname]
  );
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<TaskWithRuns | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  /**
   * Which thread is in `messages`. The load effect skips when it matches the
   * URL, so a mid-stream navigation doesn't refetch and wipe the live reply.
   */
  const loadedIdRef = useRef<string | null>(null);
  // Mirrors for callbacks that would otherwise capture a stale selection.
  const activeIdRef = useRef<string | null>(activeId);
  const taskIdRef = useRef<string | null>(taskId);
  activeIdRef.current = activeId;
  taskIdRef.current = taskId;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
      setListError(null);
    } catch (err) {
      setListError((err as Error)?.message ?? "Could not load conversations");
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await listTasks());
      setListError(null);
    } catch (err) {
      setListError((err as Error)?.message ?? "Could not load tasks");
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Only when the pane is opened.
  useEffect(() => {
    if (pane === "tasks") void refreshTasks();
  }, [pane, refreshTasks]);

  useEffect(() => {
    if (pane !== "tasks" || !taskId) {
      setActiveTask(null);
      return;
    }
    let cancelled = false;
    setLoadingTask(true);
    void (async () => {
      try {
        const detail = await getTask(taskId);
        if (!cancelled) {
          setActiveTask(detail);
          setListError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setActiveTask(null);
          setListError((err as Error)?.message ?? "Could not load task");
        }
      } finally {
        if (!cancelled) setLoadingTask(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pane, taskId]);

  const openTask = useCallback(
    (id: string) => navigate(`/tasks/${id}`),
    [navigate]
  );

  const removeTask = useCallback(async (taskId: string) => {
    setDeletingId(taskId);
    try {
      await deleteTask(taskId);
      setTasks((current) => current.filter((t) => t.id !== taskId));
      // The detail URL now points at nothing.
      if (taskId === taskIdRef.current) navigate("/tasks");
      setListError(null);
    } catch (err) {
      setListError((err as Error)?.message ?? "Could not delete task");
    } finally {
      setDeletingId(null);
    }
  }, [navigate]);

  const removeConversation = useCallback(
    async (conversationId: string) => {
      if (busy) return;
      setDeletingId(conversationId);
      try {
        await deleteConversation(conversationId);
        setConversations((current) => current.filter((c) => c.id !== conversationId));

        if (conversationId === activeIdRef.current) navigate("/");
        setListError(null);
      } catch (err) {
        setListError((err as Error)?.message ?? "Could not delete conversation");
      } finally {
        setDeletingId(null);
      }
    },
    [busy, navigate]
  );

  // Update a single message in place by id.
  const patchMessage = useCallback(
    (id: string, fn: (m: Message) => Message) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
    },
    []
  );

  // URL-driven, so a refresh or pasted link loads what a click would.
  useEffect(() => {
    if (activeId === null) {
      // Only on a genuinely fresh chat, not mid-stream on a new thread.
      if (loadedIdRef.current !== null && !busy) {
        loadedIdRef.current = null;
        setMessages([]);
      }
      return;
    }
    if (loadedIdRef.current === activeId) return;

    let cancelled = false;
    setLoadingThread(true);
    void (async () => {
      try {
        const detail = await getConversation(activeId);
        if (cancelled) return;
        // Claimed only once the messages land: claiming up front breaks under
        // StrictMode, whose second pass then skips the fetch entirely.
        loadedIdRef.current = activeId;
        setMessages(
          detail.messages.map((m) => ({
            id: m.id,
            role: m.author,
            content: m.content,
            steps: 0,
            reasoning: "",
            reasoningOpen: false,
          }))
        );
        setListError(null);
      } catch (err) {
        if (cancelled) return;
        setMessages([]);
        setListError((err as Error)?.message ?? "Could not load conversation");
      } finally {
        if (!cancelled) setLoadingThread(false);
      }
    })();

    // Otherwise a slower earlier response could land last and win.
    return () => {
      cancelled = true;
    };
  }, [activeId, busy]);

  const openConversation = useCallback(
    (conversationId: string) => {
      if (busy || conversationId === activeId) return;
      navigate(`/conversations/${conversationId}`);
    },
    [busy, activeId, navigate]
  );

  const startNewChat = useCallback(() => {
    if (busy) return;
    setInput("");
    navigate("/");
  }, [busy, navigate]);

  const submit = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;

    const userMsg: Message = {
      id: newId(),
      role: "user",
      content: prompt,
      steps: 0,
      reasoning: "",
      reasoningOpen: false,
    };
    const assistantId = newId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "Thinking",
      steps: 0,
      reasoning: "",
      // Opens on the first reasoning chunk; collapses again when the reply lands.
      reasoningOpen: false,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setBusy(true);

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      await sendChat(
        prompt,
        {
          signal: controller.signal,
          // Only fires when the server created the thread on this turn; from
          // here on the composer continues it instead of starting another.
          onConversation: (conversationId) => {
            // Claim before navigating so the load effect leaves the stream alone.
            loadedIdRef.current = conversationId;
            navigate(`/conversations/${conversationId}`, { replace: true });
          },
          // Thinking, batched server-side. Append and open the panel so it
          // streams in view; it collapses itself once the reply arrives.
          onReasoning: (chunk) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              reasoning: appendReasoning(m.reasoning, chunk),
              reasoningOpen: true,
              reasoningStartedAt: m.reasoningStartedAt ?? Date.now(),
            })),
          // Intermediate step: replace the status line, never the reply.
          onStep: (call) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              status: describeStep(call),
              steps: m.steps + 1,
            })),
          // The one payload that is the actual answer.
          onReply: (text) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              content: text,
              status: undefined,
              // Fold the thinking away now that there's something to read.
              reasoningOpen: false,
              reasoningMs: m.reasoningStartedAt
                ? Date.now() - m.reasoningStartedAt
                : m.reasoningMs,
            })),
          onError: (message) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              error: message,
              status: undefined,
            })),
        },
        // undefined on a fresh thread → POST /conversations.
        activeId ?? undefined
      );
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        patchMessage(assistantId, (m) => ({
          ...m,
          error: m.error ?? (err as Error)?.message ?? "Request failed",
        }));
      }
    } finally {
      // Clear the status even on abort/error. The thinking panel stays open —
      // a turn that ended without a reply is when it's worth reading.
      patchMessage(assistantId, (m) => ({
        ...m,
        status: undefined,
        reasoningMs:
          m.reasoningMs ??
          (m.reasoningStartedAt ? Date.now() - m.reasoningStartedAt : undefined),
      }));
      setBusy(false);
      abortRef.current = null;
      // Pick up the new thread, or the bumped message count on an existing one.
      void refreshConversations();
    }
  }, [input, busy, patchMessage, activeId, refreshConversations]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="pane-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={pane === "chats"}
            className={pane === "chats" ? "active" : ""}
            onClick={() => navigate("/")}
          >
            Chats
          </button>
          <button
            role="tab"
            aria-selected={pane === "tasks"}
            className={pane === "tasks" ? "active" : ""}
            onClick={() => navigate("/tasks")}
          >
            Tasks
          </button>
          <button
            role="tab"
            aria-selected={pane === "settings"}
            className={pane === "settings" ? "active" : ""}
            onClick={() => navigate("/settings")}
          >
            Settings
          </button>
        </div>

        <div className="sidebar-head">
          <h2>
            {pane === "chats" ? "Conversations" : pane === "tasks" ? "Scheduled" : "Preferences"}
          </h2>
          {pane === "settings" ? null : pane === "chats" ? (
            <button
              className="btn new"
              onClick={startNewChat}
              disabled={busy}
              title={busy ? "Wait for the current turn to finish" : "New chat"}
            >
              New
            </button>
          ) : (
            <button className="btn new" onClick={() => void refreshTasks()}>
              Refresh
            </button>
          )}
        </div>

        {listError && <div className="error sidebar-error">{listError}</div>}

        {pane === "settings" ? (
          <div className="sidebar-empty">
            How the assistant addresses you, what it should always keep in mind,
            and which model it uses.
          </div>
        ) : pane === "chats" ? (
          <div className="conversation-list">
            {conversations.length === 0 && !listError && (
              <div className="sidebar-empty">No conversations yet.</div>
            )}

            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                disabled={busy}
                deleting={deletingId === conversation.id}
                onOpen={() => void openConversation(conversation.id)}
                onDelete={() => void removeConversation(conversation.id)}
              />
            ))}
          </div>
        ) : (
          <div className="conversation-list">
            {tasks.length === 0 && !listError && (
              <div className="sidebar-empty">
                No scheduled tasks. The agent creates them with its
                <code> schedule-task </code> tool.
              </div>
            )}

            {tasks.map((task) => (
              <button
                key={task.id}
                className={`conversation ${task.id === activeTask?.id ? "active" : ""}`}
                onClick={() => void openTask(task.id)}
              >
                <span className="conversation-preview">{task.prompt}</span>
                <span className="conversation-meta">
                  <code>{task.schedule}</code> ·{" "}
                  {task.limit === null ? "∞" : `max ${task.limit}`} ·{" "}
                  {formatWhen(task.createdAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <div className="app">
        <header className="header">
          <h1>MCP Agent</h1>
          <span className="subtitle">
            {pane === "settings"
              ? "Preferences"
              : pane === "tasks"
              ? activeTask
                ? `Task ${activeTask.id.slice(-6)}`
                : "Scheduled tasks"
              : activeId
              ? `Thread ${activeId.slice(-6)}`
              : "New conversation"}
          </span>
        </header>

        {pane === "settings" ? (
          <div className="messages">
            <SettingsPane />
          </div>
        ) : pane === "tasks" ? (
          <div className="messages">
            {loadingTask && <div className="empty">Loading task…</div>}
            {!loadingTask && !activeTask && (
              <div className="empty">
                Pick a task to see its schedule and run history.
              </div>
            )}
            {!loadingTask && activeTask && (
              <TaskDetail
                task={activeTask}
                deleting={deletingId === activeTask.id}
                onDelete={() => void removeTask(activeTask.id)}
              />
            )}
          </div>
        ) : (
          <>
          <div className="messages" ref={scrollRef}>
            {loadingThread && <div className="empty">Loading conversation…</div>}

            {!loadingThread && messages.length === 0 && (
              <div className="empty">
                Ask the agent something. It connects to your MCP servers via the
                <code> /conversations </code> endpoint.
              </div>
            )}

            {!loadingThread &&
              messages.map((m) => (
                <div key={m.id} className={`message ${m.role}`}>
                  <div className="role">{m.role === "user" ? "You" : "Agent"}</div>
                  <div className="bubble">
                    {/* Thinking sits above the answer, as in Claude/DeepSeek. */}
                    {m.reasoning && (
                      <Thinking
                        message={m}
                        onToggle={() =>
                          patchMessage(m.id, (prev) => ({
                            ...prev,
                            reasoningOpen: !prev.reasoningOpen,
                          }))
                        }
                      />
                    )}

                    {/* One line, replaced in place as the agent works. */}
                    {m.status && (
                      <div className="status">
                        <span className="spinner" aria-hidden="true" />
                        <span className="status-text">{m.status}</span>
                      </div>
                    )}

                    {/* Only the agent writes markdown; a user's message stays
                        literal, so stray *asterisks* aren't eaten. */}
                    {m.content && (
                      <div className="content">
                        {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
                      </div>
                    )}

                    {/* Quiet footnote once the reply has landed. */}
                    {!m.status && m.content && m.steps > 0 && (
                      <div className="steps-note">
                        Worked through {m.steps} step{m.steps === 1 ? "" : "s"}
                      </div>
                    )}

                    {m.error && <div className="error">{m.error}</div>}
                  </div>
                </div>
              ))}
          </div>

          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
              rows={2}
            />
            {busy ? (
              <button className="btn stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                className="btn send"
                onClick={() => void submit()}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
