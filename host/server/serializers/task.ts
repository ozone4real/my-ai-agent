// Wire shapes for Task and TaskRun, in both directions.
//
// Shared by the REST routes and the MCP server so the two can't drift: the
// output shapes double as the MCP tools' `outputSchema` and are validated
// against whatever the serializers produce, and the update shape is the single
// definition of what may be changed on a task.

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

/**
 * The mutable surface of a task. Everything else — creator, sourceConversation,
 * timestamps — is provenance and is fixed once written.
 *
 * Every field is optional so a caller can change one thing without restating
 * the rest; `limit: null` clears the cap, meaning "run indefinitely".
 */
export const taskUpdateShape = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(10000)
      .optional()
      .describe("New instruction to run the agent with"),
    schedule: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("New cron expression, e.g. '0 9 * * 1'"),
    limit: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("New maximum number of runs; null clears the cap"),
  })
  // Unknown keys are stripped, so a body of only junk arrives here as `{}` and
  // is rejected rather than silently saving nothing.
  .refine((update) => Object.keys(update).length > 0, {
    message: "Provide at least one of prompt, schedule or limit",
  });

export type TaskUpdate = z.infer<typeof taskUpdateShape>;

/**
 * Apply an update in place. Absent keys are left alone — distinguishing
 * "not mentioned" from "explicitly cleared" is why `limit` is nullable rather
 * than just optional.
 */
export const applyTaskUpdate = (task: TaskDocument, update: TaskUpdate): void => {
  if (update.prompt !== undefined) task.prompt = update.prompt;
  if (update.schedule !== undefined) task.schedule = update.schedule;
  if (update.limit !== undefined) task.set("limit", update.limit ?? undefined);
};
