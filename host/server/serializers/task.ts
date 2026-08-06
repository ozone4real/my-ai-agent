// Wire shapes for Task and TaskRun.
//
// Shared by the REST routes and the MCP server so the two can't drift: the zod
// shapes double as the MCP tools' `outputSchema`, and they are validated against
// whatever the serializers below produce.

// NOTE: the `.js` extensions are load-bearing and unlike the rest of host/.
// mcp_servers/ imports this file and compiles under NodeNext, which won't guess
// extensions; host/ uses bundler resolution, which accepts them either way. So
// the explicit form is the one that satisfies both.
import { z } from "zod";
import { CREATORS, type TaskDocument } from "../models/task.js";
import { STATUSES, type TaskRunDocument } from "../models/task_run.js";

/**
 * Optional fields are nullable rather than absent, so the shape is identical on
 * every response — a key that sometimes vanishes is harder for both a client and
 * a model to handle than an explicit null.
 */
export const taskShape = z.object({
  id: z.string().describe("The task's id"),
  creator: z.enum(CREATORS).describe("Who the task is recorded as coming from"),
  prompt: z.string().describe("The prompt the agent is run with"),
  schedule: z.string().describe("Cron expression the task runs on"),
  limit: z.number().nullable().describe("Max number of runs; null means unlimited"),
  sourceConversation: z
    .string()
    .nullable()
    .describe("Conversation this task was created from, if any"),
  createdAt: z.string().describe("ISO 8601 creation timestamp"),
  updatedAt: z.string().describe("ISO 8601 last-modified timestamp"),
});

export const taskRunShape = z.object({
  id: z.string().describe("The run's id"),
  status: z.enum(STATUSES).describe("Outcome of the run"),
  transcript: z
    .string()
    .nullable()
    .describe("The agent's conversation history for this run, when recorded"),
  startedAt: z.string().describe("ISO 8601 timestamp the run began"),
  // TaskRun maps updatedAt to endedAt, so this only differs from startedAt once
  // the run has actually finished and written its status.
  endedAt: z.string().describe("ISO 8601 timestamp the run last changed"),
});

/** A task together with its run history, newest run first. */
export const taskWithRunsShape = taskShape.extend({
  runs: z.array(taskRunShape).describe("Runs of this task, newest first"),
});

export type SerializedTask = z.infer<typeof taskShape>;
export type SerializedTaskRun = z.infer<typeof taskRunShape>;

export const serializeTask = (task: TaskDocument): SerializedTask => ({
  id: String(task._id),
  creator: task.creator as SerializedTask["creator"],
  prompt: task.prompt,
  schedule: task.schedule,
  limit: task.limit ?? null,
  sourceConversation: task.sourceConversation ? String(task.sourceConversation) : null,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});

export const serializeTaskRun = (run: TaskRunDocument): SerializedTaskRun => ({
  id: String(run._id),
  status: run.status as SerializedTaskRun["status"],
  transcript: run.transcript ?? null,
  startedAt: run.startedAt.toISOString(),
  endedAt: run.endedAt.toISOString(),
});
