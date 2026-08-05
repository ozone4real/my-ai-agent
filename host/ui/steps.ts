// Turns an agent step into the one-line status shown while a turn is in flight.

import type { AgentStep } from "./api";

// Tools whose names read better as "Running …" than "Using …".
const RUN_LIKE = /(command|exec|shell|run|script|bash)/i;

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
 * Describe what the agent is doing right now. Falls back through the step's
 * fields so an unexpected shape still produces something readable.
 */
export function describeStep(step: AgentStep): string {
  const tool = step?.action?.tool;

  if (tool) {
    const label = humanizeTool(tool);
    return RUN_LIKE.test(tool) ? `Running ${label}` : `Using ${label}`;
  }

  // No tool on this step — the agent is reasoning. Use the first line of the
  // log if there is one, so the line still says something specific.
  const log = step?.action?.log?.trim().split("\n")[0];
  if (log) return truncate(log, 80);

  return "Thinking";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
