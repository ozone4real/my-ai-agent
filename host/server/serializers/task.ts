// Wire shapes for Task and TaskRun, shared by the REST routes and the MCP
// server so they can't drift. The output shapes double as MCP `outputSchema`.

// The `.js` extensions are load-bearing: mcp_servers/ imports this under
// NodeNext, which won't guess them. Bundler resolution accepts them too.
import { z } from "zod";
import { MODEL_CHOICES, ModelType } from "../agents/model_types.js";
import { CREATORS, type TaskDocument } from "../models/task.js";
import { STATUSES, type TaskRunDocument } from "../models/task_run.js";

/** Optional fields are nullable, not absent — a stable shape every time. */
export const taskShape = z.object({
  id: z.string().describe("The task's id"),
  creator: z.enum(CREATORS).describe("Who the task is recorded as coming from"),
  prompt: z.string().describe("The prompt the agent is run with"),
  schedule: z.string().describe("Cron expression the task runs on"),
  limit: z.number().nullable().describe("Max number of runs; null means unlimited"),
  model: z
    .string()
    .nullable()
    .describe("Model this task's runs use; null means the app default"),
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
  model: task.agentModel ?? null,
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
 * The mutable surface; creator, sourceConversation and timestamps are fixed.
 * All optional so one field can change alone; `limit: null` clears the cap.
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
    model: z
      .enum(MODEL_CHOICES as [ModelType, ...ModelType[]])
      .nullable()
      .optional()
      .describe("Model to run this task on; null falls back to the app default"),
  })
  // Unknown keys are stripped, so a junk-only body lands here as `{}`.
  .refine((update) => Object.keys(update).length > 0, {
    message: "Provide at least one of prompt, schedule, limit or model",
  });

/**
 * What a client may supply when creating a task by hand.
 *
 * `creator` is not here: a task made through this shape is by definition the
 * user's, and the distinction is what stops the agent editing tasks it didn't
 * make. `sourceConversation` is likewise absent — a hand-made task has no
 * conversation behind it.
 */
export const taskCreateShape = z.object({
  prompt: z
    .string()
    .min(1)
    .max(10000)
    .describe("The instruction to run the agent with when the task fires"),
  schedule: z
    .string()
    .min(1)
    .max(200)
    .describe("Cron expression for when to run, e.g. '0 9 * * 1'"),
  limit: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Maximum number of runs; null or omitted means unlimited"),
  model: z
    .enum(MODEL_CHOICES as [ModelType, ...ModelType[]])
    .nullable()
    .optional()
    .describe("Model to run this task on; null or omitted uses the app default"),
});

export type TaskCreate = z.infer<typeof taskCreateShape>;

export type TaskUpdate = z.infer<typeof taskUpdateShape>;

/** Absent keys are left alone; `limit` is nullable so it can be cleared. */
export const applyTaskUpdate = (task: TaskDocument, update: TaskUpdate): void => {
  if (update.prompt !== undefined) task.prompt = update.prompt;
  if (update.schedule !== undefined) task.schedule = update.schedule;
  if (update.limit !== undefined) task.set("limit", update.limit ?? undefined);
  // `undefined` unsets the field, so null falls back to the app default rather
  // than storing a value the enum would reject.
  if (update.model !== undefined) task.set("agentModel", update.model ?? undefined);
};
