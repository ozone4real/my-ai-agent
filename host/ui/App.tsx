import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConversation,
  listConversations,
  sendChat,
  type ConversationSummary,
} from "./api";
import { describeStep } from "./steps";

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
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());

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

export function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /** null = composing a new thread; the server assigns the id on first send. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
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

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Update a single message in place by id.
  const patchMessage = useCallback(
    (id: string, fn: (m: Message) => Message) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
    },
    []
  );

  const openConversation = useCallback(
    async (conversationId: string) => {
      if (busy || conversationId === activeId) return;
      setLoadingThread(true);
      setActiveId(conversationId);
      try {
        const detail = await getConversation(conversationId);
        setMessages(
          detail.messages.map((m) => ({
            id: m.id,
            role: m.author,
            content: m.content,
            steps: 0,
          }))
        );
      } catch (err) {
        setMessages([]);
        setListError((err as Error)?.message ?? "Could not load conversation");
      } finally {
        setLoadingThread(false);
      }
    },
    [busy, activeId]
  );

  const startNewChat = useCallback(() => {
    if (busy) return;
    setActiveId(null);
    setMessages([]);
    setInput("");
  }, [busy]);

  const submit = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;

    const userMsg: Message = {
      id: newId(),
      role: "user",
      content: prompt,
      steps: 0,
    };
    const assistantId = newId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "Thinking",
      steps: 0,
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
          onConversation: (conversationId) => setActiveId(conversationId),
          // Intermediate step: replace the status line, never the reply.
          onStep: (step) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              status: describeStep(step),
              steps: m.steps + 1,
            })),
          // The one payload that is the actual answer.
          onReply: (text) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              content: text,
              status: undefined,
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
      // Clear the status even on abort/error, so nothing is left spinning.
      patchMessage(assistantId, (m) => ({ ...m, status: undefined }));
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
        <div className="sidebar-head">
          <h2>Conversations</h2>
          <button
            className="btn new"
            onClick={startNewChat}
            disabled={busy}
            title={busy ? "Wait for the current turn to finish" : "New chat"}
          >
            New
          </button>
        </div>

        {listError && <div className="error sidebar-error">{listError}</div>}

        <div className="conversation-list">
          {conversations.length === 0 && !listError && (
            <div className="sidebar-empty">No conversations yet.</div>
          )}

          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`conversation ${
                conversation.id === activeId ? "active" : ""
              }`}
              onClick={() => void openConversation(conversation.id)}
              disabled={busy}
            >
              <span className="conversation-preview">
                {conversation.preview || "Empty conversation"}
              </span>
              <span className="conversation-meta">
                {conversation.messageCount} message
                {conversation.messageCount === 1 ? "" : "s"} ·{" "}
                {formatWhen(conversation.lastMessageAt)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="app">
        <header className="header">
          <h1>MCP Agent</h1>
          <span className="subtitle">
            {activeId ? `Thread ${activeId.slice(-6)}` : "New conversation"}
          </span>
        </header>

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
                  {/* One line, replaced in place as the agent works. */}
                  {m.status && (
                    <div className="status">
                      <span className="spinner" aria-hidden="true" />
                      <span className="status-text">{m.status}</span>
                    </div>
                  )}

                  {m.content && <div className="content">{m.content}</div>}

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
      </div>
    </div>
  );
}
