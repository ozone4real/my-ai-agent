import { MCPServer } from "mcp-use";
import { Types } from "mongoose";
import { z } from "zod";
// Explicit .js extension: tsconfig.node.json compiles this directory with
// NodeNext resolution, which follows the ESM spec and won't guess extensions.
// The path stays .js even though the source is .ts — it names the emitted file.
import servers_definition from "./servers_definition.js";
import { connectDB } from "../host/server/db.js";
import { TaskModel } from "../host/server/models/task.js";
import { TaskRunModel } from "../host/server/models/task_run.js";
import {
  serializeTask,
  serializeTaskRun,
  taskShape,
  taskWithRunsShape,
} from "../host/server/serializers/task.js";

const server = new MCPServer({
  name: "Application MCP Server",
  title: "app-mcp-server",
  description: "MCP server for general application operations, such as sending notifications, task scheduling, etc.",
  version: "1.0"
})

export const scheduleTask = server.tool(
  {
    name: "schedule-task",
    title: "Schedule Task",
    description:
      "Create a scheduled task: a prompt the agent will be run with, once or repeatedly on a cron schedule. Returns the created task.",
    schema: z.object({
      prompt: z
        .string()
        .min(1)
        .describe(
          "The instruction to run the agent with when the task fires. Write it standalone — the agent won't have this conversation for context."
        ),
      schedule: z
        .string()
        .min(1)
        .describe(
          "Cron expression for when to run, e.g. '0 9 * * 1' for 09:00 every Monday. For a one-off, give the cron for the moment it should run and set limit to 1."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of times to run. Omit to repeat indefinitely; use 1 for a one-off."),
      sourceConversation: z
        .string()
        .optional()
        .describe("Id of the conversation this task came out of, when there is one."),
    }),
    // Writes a row, so it is neither read-only nor safe to retry blindly.
    // Not destructive: it only ever creates, never overwrites.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: taskShape,
  },
  async ({ prompt, schedule, limit, sourceConversation }) => {
    // Idempotent and cached in db.ts, so calling it per invocation costs
    // nothing after the first and keeps the module importable when Mongo is
    // down — connecting at import time would take the whole server with it.
    await connectDB();

    // A malformed id would otherwise surface as a mongoose CastError, i.e. a
    // stack trace where a usable message belongs.
    if (sourceConversation && !Types.ObjectId.isValid(sourceConversation)) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Not a valid conversation id: ${sourceConversation}` },
        ],
      };
    }

    try {
      const task = await TaskModel.create({
        prompt,
        schedule,
        creator: "assistant",
        ...(limit !== undefined && { limit }),
        ...(sourceConversation && { sourceConversation }),
      });

      const created = serializeTask(task);
      return {
        content: [{ type: "text", text: JSON.stringify(created) }],
        structuredContent: created,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("schedule-task failed:", err);
      return {
        isError: true,
        content: [{ type: "text", text: `Could not create task: ${reason}` }],
      };
    }
  }
);

export const getTask = server.tool(
  {
    name: "get-task",
    title: "Get Task",
    description:
      "Fetch one scheduled task by id, together with its run history (newest run first). Use this to check whether a task has been running and how it went.",
    schema: z.object({
      id: z.string().describe("The task's id, as returned by list-tasks or schedule-task."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: taskWithRunsShape,
  },
  async ({ id }) => {
    await connectDB();

    if (!Types.ObjectId.isValid(id)) {
      return { isError: true, content: [{ type: "text", text: `Not a valid task id: ${id}` }] };
    }

    const task = await TaskModel.findById(id);
    if (!task) {
      return { isError: true, content: [{ type: "text", text: `No task with id ${id}` }] };
    }

    const runs = await TaskRunModel.find({ task: task._id }).sort({ startedAt: -1 });
    const payload = { ...serializeTask(task), runs: runs.map(serializeTaskRun) };

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
);

export const listTasks = server.tool(
  {
    name: "list-tasks",
    title: "List Tasks",
    description:
      "List scheduled tasks, newest first. Run history is not included — call get-task with an id for that.",
    schema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .default(50)
        .describe("How many tasks to return, newest first. Defaults to 50."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Any-JSON roots are legal in the 2026 protocol, but an object leaves room
    // to add fields later without breaking clients that already read `tasks`.
    outputSchema: z.object({
      tasks: z.array(taskShape).describe("Matching tasks, newest first"),
      total: z.number().describe("Total tasks stored, ignoring the limit"),
    }),
  },
  async ({ limit }) => {
    await connectDB();

    const [tasks, total] = await Promise.all([
      TaskModel.find().sort({ createdAt: -1 }).limit(limit),
      TaskModel.countDocuments(),
    ]);

    const payload = { tasks: tasks.map(serializeTask), total };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
);

// v2 entry contract: the CLI imports this default export, then mounts and
// listens. Calling server.listen() here instead would start a second listener.
export default server;

