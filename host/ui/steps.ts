// Turns an agent tool call into the one-line status shown while a turn is in flight.

import type { AgentToolCall } from "./api";

// Tools whose names read better as "Running …" than "Using …".
const RUN_LIKE = /(command|exec|shell|run|script|bash)/i;
// …and ones that are really a lookup.
const SEARCH_LIKE = /(search|query|find|lookup)/i;

/** "filesystem__read_file" -> "read file" */
function humanizeTool(tool: string): string {
  return tool
    .replace(/^[a-z0-9]+[_-]{2,}/i, "") // drop a server prefix like `filesystem__`
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

/**
 * Pull the one argument worth showing. A search query or a path says far more
 * about what the agent is doing than the tool name alone, and it's the part a
 * user can actually recognise.
 */
function describeArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["query", "q", "path", "url", "cmd", "command"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 48);
  }
  return undefined;
}

/**
 * Describe what the agent is doing right now. Falls back through the call's
 * fields so an unexpected shape still produces something readable.
 */
export function describeStep(call: AgentToolCall): string {
  const tool = call?.tool;
  if (!tool) return "Thinking";

  const label = humanizeTool(tool);
  const detail = describeArgs(call.args);

  const verb = RUN_LIKE.test(tool)
    ? "Running"
    : SEARCH_LIKE.test(tool)
    ? "Searching"
    : "Using";

  // "Searching for \"searxng\"" reads better than "Searching web search …".
  if (verb === "Searching" && detail) return `Searching for “${detail}”`;
  return detail ? `${verb} ${label} · ${detail}` : `${verb} ${label}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
