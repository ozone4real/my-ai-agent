import { Router } from "express"
import type { Request, Response } from "express"
import { Types } from "mongoose"
import { TaskModel } from "../models/task"
import { TaskRunModel } from "../models/task_run"
import {
  applyTaskUpdate,
  serializeTask,
  serializeTaskRun,
  taskCreateShape,
  taskUpdateShape,
} from "../serializers/task"

const router = Router()

/** A non-ObjectId would make findById throw a CastError, i.e. a 500. */
const findTask = async (rawId: unknown, res: Response) => {
  const id = String(rawId)
  if (!Types.ObjectId.isValid(id)) {
    res.status(404).json({ error: "Task not found" })
    return null
  }
  const task = await TaskModel.findById(id)
  if (!task) {
    res.status(404).json({ error: "Task not found" })
    return null
  }
  return task
}

// Newest first. Runs omitted so the response can't grow without bound.
router.get("/", async (_req: Request, res: Response) => {
  const tasks = await TaskModel.find().sort({ createdAt: -1 })
  res.json({ tasks: tasks.map(serializeTask) })
})

/**
 * Create a task by hand, as opposed to the agent's `schedule-task` tool.
 *
 * Recorded with `creator: "user"`, which is what keeps the agent from editing
 * or deleting it later. The post-save hook registers the cron with BullMQ and
 * throws if that fails, so a 201 means the task is genuinely scheduled.
 */
router.post("/", async (req: Request, res: Response) => {
  // safeParse: Express 5 turns a thrown ZodError into a 500.
  const parsed = taskCreateShape.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues.map((i) => i.message).join("; "),
    })
    return
  }

  const { prompt, schedule, limit, model } = parsed.data
  try {
    const task = await TaskModel.create({
      prompt,
      schedule,
      creator: "user",
      // Omitted rather than null: the enum would reject null, and an unset
      // field is what "use the app default" means to the reader.
      ...(limit != null && { limit }),
      ...(model != null && { agentModel: model }),
    })
    res.status(201).json(serializeTask(task))
  } catch (err) {
    // A bad cron fails validation here, and a scheduler that won't register
    // fails in the post-save hook — both are the client's to fix.
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

router.get("/:task_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  const runs = await TaskRunModel.find({ task: task._id }).sort({ startedAt: -1 })
  res.json({ ...serializeTask(task), runs: runs.map(serializeTaskRun) })
})

/**
 * Run the task now, outside its schedule.
 *
 * There are no automatic retries — a failed run stays failed — so this is how a
 * run gets another go. It queues the same job the scheduler queues, so the run
 * is identical to a scheduled one.
 */
router.post("/:task_id/runs", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  // The unique index would reject the second run anyway, but the worker's only
  // recourse is to drop it silently. Failing here says so.
  const running = await TaskRunModel.exists({ task: task._id, status: "in_progress" })
  if (running) {
    res.status(409).json({ error: "This task already has a run in progress" })
    return
  }

  try {
    const { default: AgenticJob } = await import("../jobs/agentic_job.js")
    await new AgenticJob().enqueue({ taskId: String(task._id) })
  } catch (error) {
    // Redis down: the queue never took it, so say so rather than implying a run.
    res.status(503).json({
      error: `Could not queue the run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return
  }

  res.status(202).json({ queued: true, taskId: String(task._id) })
})

/**
 * Delete one run of a task.
 *
 * App server only — deliberately not an MCP tool. The agent replays past runs
 * into later ones, so letting it delete them would let it edit its own record
 * of what it did.
 *
 * A run still `in_progress` is refused: the worker executing it holds the
 * document and writes the outcome at the end, and the unique index that keeps
 * one run per task in flight is what the deletion would quietly lift. A run
 * whose worker died is closed by the reaper, and can be deleted after that.
 */
router.delete("/:task_id/runs/:run_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  const runId = String(req.params.run_id)
  if (!Types.ObjectId.isValid(runId)) {
    res.status(404).json({ error: "Task run not found" })
    return
  }

  // Scoped to the task, so a run id from another task 404s rather than being
  // deleted through the wrong parent.
  const run = await TaskRunModel.findOne({ _id: runId, task: task._id })
  if (!run) {
    res.status(404).json({ error: "Task run not found" })
    return
  }

  if (run.status === "in_progress") {
    res.status(409).json({
      error:
        "This run is still in progress. Wait for it to finish, or let it be " +
        "closed automatically if its worker has stopped.",
    })
    return
  }

  await run.deleteOne()
  res.json({ id: runId, deleted: true })
})

// PATCH: an absent field means "leave it alone", not "clear it".
router.patch("/:task_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  // safeParse: Express 5 turns a thrown ZodError into a 500.
  const parsed = taskUpdateShape.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues.map((i) => i.message).join("; "),
    })
    return
  }

  applyTaskUpdate(task, parsed.data)
  try {
    await task.save()
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  res.json(serializeTask(task))
})

router.delete("/:task_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  // Runs are unreachable once the task is gone.
  const { deletedCount } = await TaskRunModel.deleteMany({ task: task._id })
  await task.deleteOne()

  res.json({ id: String(task._id), deleted: true, deletedRuns: deletedCount ?? 0 })
})

export default router
