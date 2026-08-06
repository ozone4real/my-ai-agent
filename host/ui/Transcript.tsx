import { useMemo, useState } from "react";

/**
 * A stored run transcript, in the DeepSeek/OpenAI chat shape the agent
 * serialises. System messages are stripped before storage, so only these
 * three roles turn up.
 */
type TranscriptMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: {
        id: string;
        function?: { name?: string; arguments?: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string; name?: string };

/** Parse, or null if this isn't a transcript we recognise. */
function parseTranscript(raw: string): TranscriptMessage[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // A transcript of unknown shape is better shown raw than half-rendered.
    return parsed.every((m) => m && typeof m === "object" && "role" in m)
      ? (parsed as TranscriptMessage[])
      : null;
  } catch {
    return null;
  }
}

/** Pretty-print the JSON string a tool call carries its arguments as. */
function formatArgs(args?: string): string {
  if (!args) return "";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/**
 * Tool results are stored as the raw MCP `CallToolResult`, so the useful text
 * is buried in a `content` envelope. Pull it out; fall back to pretty JSON, and
 * to the raw string if it isn't JSON at all.
 */
function readToolContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.content)) {
      const text = parsed.content
        .filter((block: any) => block?.type === "text" && typeof block.text === "string")
        .map((block: any) => block.text)
        .join("\n");
      if (text.trim()) return text;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

/** "searxng_web_search" -> "searxng web search" */
function humanizeTool(name: string): string {
  return name.replace(/[_-]+/g, " ");
}

function firstLine(text: string, max = 90): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Anything long enough to bury the rest of the transcript gets folded away. */
function Collapsible({
  summary,
  body,
  className = "",
}: {
  summary: React.ReactNode;
  body: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tr-collapsible ${className}`}>
      <button className="tr-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`tr-caret ${open ? "open" : ""}`} aria-hidden="true">
          ▶
        </span>
        {summary}
      </button>
      {open && <pre className="tr-body">{body}</pre>}
    </div>
  );
}

function Entry({
  message,
  toolNames,
}: {
  message: TranscriptMessage;
  toolNames: Map<string, string>;
}) {
  if (message.role === "user") {
    return (
      <li className="tr-entry">
        <span className="tr-role prompt">Prompt</span>
        <div className="tr-text">{message.content}</div>
      </li>
    );
  }

  if (message.role === "tool") {
    const name = message.name ?? toolNames.get(message.tool_call_id) ?? "tool";
    const content = readToolContent(message.content ?? "");
    return (
      <li className="tr-entry">
        <Collapsible
          className="tr-result"
          summary={
            <>
              <span className="tr-role result">Result</span>
              <span className="tr-tool-name">{humanizeTool(name)}</span>
              <span className="tr-preview">{firstLine(content)}</span>
            </>
          }
          body={content}
        />
      </li>
    );
  }

  // assistant: any combination of thinking, text and tool calls.
  const calls = message.tool_calls ?? [];
  return (
    <li className="tr-entry">
      {message.reasoning_content && (
        <Collapsible
          className="tr-reasoning"
          summary={<span className="tr-role thought">Thought</span>}
          body={message.reasoning_content}
        />
      )}

      {message.content && (
        <>
          <span className="tr-role agent">Agent</span>
          <div className="tr-text">{message.content}</div>
        </>
      )}

      {calls.map((call) => {
        const name = call.function?.name ?? "tool";
        const args = formatArgs(call.function?.arguments);
        const summary = (
          <>
            <span className="tr-role call">Called</span>
            <span className="tr-tool-name">{humanizeTool(name)}</span>
          </>
        );
        // Nothing to expand when a call took no arguments.
        return args ? (
          <Collapsible key={call.id} className="tr-call" summary={summary} body={args} />
        ) : (
          <div key={call.id} className="tr-collapsible tr-call">
            <span className="tr-toggle static">{summary}</span>
          </div>
        );
      })}
    </li>
  );
}

export function Transcript({ raw }: { raw: string }) {
  const messages = useMemo(() => parseTranscript(raw), [raw]);

  // Tool results reference their call by id but don't always carry the name.
  const toolNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const message of messages ?? []) {
      if (message.role !== "assistant") continue;
      for (const call of message.tool_calls ?? []) {
        if (call.function?.name) names.set(call.id, call.function.name);
      }
    }
    return names;
  }, [messages]);

  // Older runs, or anything written by something else, still get shown.
  if (!messages) return <pre className="run-transcript">{raw}</pre>;
  if (messages.length === 0) {
    return <div className="tr-empty">This run recorded no messages.</div>;
  }

  return (
    <ol className="tr-list">
      {messages.map((message, i) => (
        <Entry key={i} message={message} toolNames={toolNames} />
      ))}
    </ol>
  );
}
