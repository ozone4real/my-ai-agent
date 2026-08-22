import { acceptedContent, inputRequired, inputResponse, MCPServer } from "mcp-use";
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
  applyTaskUpdate,
  serializeTask,
  serializeTaskRun,
  taskShape,
  taskUpdateShape,
  taskWithRunsShape,
} from "../host/server/serializers/task.js";

const server = new MCPServer({
  name: "Application MCP Server",
  title: "app-mcp-server",
  description: "MCP server for general application operations, such as sending notifications, task scheduling, etc.",
  version: "1.0",
  // Host-header validation only allows localhost-class names by default. In
  // Docker the other services reach this one as http://app-mcp:8000, so that
  // hostname has to be allowed or every request is rejected as DNS rebinding.
  allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean),
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

    const task = await TaskModel.findOne( { creator: "assistant", _id: id });
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
      TaskModel.find({ creator: "assistant" }).sort({ createdAt: -1 }).limit(limit),
      TaskModel.countDocuments(),
    ]);

    const payload = { tasks: tasks.map(serializeTask), total };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
);

/**
 * Load a task for a write, refusing anything the assistant didn't create.
 *
 * The REST API has no such restriction — a person editing their own task
 * through the UI is fine. This is specifically about the agent not quietly
 * rewriting or deleting instructions a human set up.
 *
 * Returns the task, or the `isError` result to hand straight back.
 */
const loadOwnTask = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    return { error: { isError: true as const, content: [{ type: "text" as const, text: `Not a valid task id: ${id}` }] } };
  }

  const task = await TaskModel.findById(id);
  if (!task) {
    return { error: { isError: true as const, content: [{ type: "text" as const, text: `No task with id ${id}` }] } };
  }

  if (task.creator !== "assistant") {
    return {
      error: {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text:
              `Task ${id} was created by the user, so it can't be changed from here. ` +
              `Only tasks the assistant created itself may be updated or deleted. ` +
              `Tell the user they can edit or remove it themselves.`,
          },
        ],
      },
    };
  }

  return { task };
};

export const updateTask = server.tool(
  {
    name: "update-task",
    title: "Update Task",
    description:
      "Change the prompt, schedule or run limit of a scheduled task. Only tasks the assistant created can be changed; user-created ones are refused. Returns the updated task.",
    schema: z.object({
      id: z.string().describe("The task's id, as returned by list-tasks."),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe("New instruction to run the agent with. Omit to leave unchanged."),
      schedule: z
        .string()
        .min(1)
        .optional()
        .describe("New cron expression, e.g. '0 9 * * 1'. Omit to leave unchanged."),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("New maximum number of runs. null clears the cap; omit to leave unchanged."),
    }),
    annotations: {
      readOnlyHint: false,
      // Overwrites fields a user may be relying on, so hosts should treat it as
      // worth confirming.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: taskShape,
  },
  async ({ id, ...fields }) => {
    await connectDB();

    const parsed = taskUpdateShape.safeParse(fields);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          { type: "text", text: parsed.error.issues.map((i) => i.message).join("; ") },
        ],
      };
    }

    const { task, error } = await loadOwnTask(id);
    if (error) return error;

    applyTaskUpdate(task, parsed.data);
    try {
      await task.save();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Could not update task: ${reason}` }] };
    }

    const updated = serializeTask(task);
    return {
      content: [{ type: "text", text: JSON.stringify(updated) }],
      structuredContent: updated,
    };
  }
);

export const deleteTask = server.tool(
  {
    name: "delete-task",
    title: "Delete Task",
    description:
      "Delete a scheduled task and its run history. Only tasks the assistant created can be deleted; user-created ones are refused.",
    schema: z.object({
      id: z.string().describe("The task's id, as returned by list-tasks."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // Deleting an already-deleted task fails rather than succeeding quietly,
      // so this is not safe to blindly retry.
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: z.object({
      id: z.string().describe("Id of the deleted task"),
      deletedRuns: z.number().describe("How many runs were removed with it"),
    }),
  },
  async ({ id }) => {
    await connectDB();

    const { task, error } = await loadOwnTask(id);
    if (error) return error;

    // Runs are unreachable once the task is gone, so they go with it.
    const { deletedCount } = await TaskRunModel.deleteMany({ task: task._id });
    await task.deleteOne();

    const payload = { id, deletedRuns: deletedCount ?? 0 };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
);

// Correlation key for this tool's embedded elicitation. The client echoes it
// back under `inputResponses` when it retries the call with the user's answer.
const ASK_USER_KEY = "ask-user-response";

const askUserResponseSchema = z.object({
  response: z.string().describe("The user's answer to the question"),
});

export const askUser = server.tool(
  {
    name: "ask-user",
    title: "Ask user",
    description: "Tool for eliciting information needed to continue a task from the user mid-run",
    schema: z.object({
      question: z.string().describe("The question to put to the user"),
      context: z.enum([ "task", "conversation" ]).describe("Where the question originates: an unattended task run, or a live conversation"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      question: z.string(),
      context: z.enum([ "task", "conversation" ]),
      response: z.string(),
    }),
  },
  async({ question, context }, ctx) => {
    if(context === "task") {
      const text = "Agent running unattended; interaction with user not supported. End run if elicitation is needed to proceed with task"
      return {
        isError: true,
        content: [{ type: "text", text }]
      }
    }
    // Elicitation is a multi-round-trip flow: the first pass returns an
    // input-required result, the client collects the answer and *retries this
    // same call*, and the callback runs again with the reply in ctx.
    const reply = inputResponse(ctx.inputResponses, ASK_USER_KEY);

    if (reply.kind === "missing") {
      if (!ctx.client.can("elicitation")) {
        return {
          isError: true,
          content: [{ type: "text", text: "This client cannot prompt the user; ask the question in your own reply instead." }],
        };
      }

      return inputRequired({
        inputRequests: {
          [ASK_USER_KEY]: inputRequired.elicit({
            message: question,
            requestedSchema: askUserResponseSchema,
          }),
        },
      });
    }

    if (reply.kind !== "elicit" || reply.action !== "accept") {
      const reason = reply.kind === "elicit" && reply.action === "decline"
        ? "The user declined to answer."
        : "The user dismissed the question without answering.";
      return { isError: true, content: [{ type: "text", text: reason }] };
    }

    // Client-supplied — validate before trusting it.
    const answer = acceptedContent(ctx.inputResponses, ASK_USER_KEY, askUserResponseSchema);
    if (!answer) {
      return { isError: true, content: [{ type: "text", text: "The user's answer did not match the requested shape." }] };
    }

    const payload = { question, context, response: answer.response };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
);

// v2 entry contract: the CLI imports this default export, then mounts and
// listens. Calling server.listen() here instead would start a second listener.
export default server;

