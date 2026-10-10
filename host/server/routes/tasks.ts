import { Router } from "express"
import type { Request, Response } from "express"
import { Types } from "mongoose"
import { TaskModel, type TaskDocument } from "../models/task"
import { TaskRunModel } from "../models/task_run"
import { afterCursor, newestFirst, PAGE_SIZE, toPage } from "./pagination"
import {
  applyTaskUpdate,
  serializeTask,
  serializeTaskRun,
  serializeTaskRunSummary,
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

/**
 * One run of a task. Scoped to the task, so a run id from another task 404s
 * rather than being reached through the wrong parent.
 */
const findRun = async (task: TaskDocument, rawId: unknown, res: Response) => {
  const id = String(rawId)
  const run = Types.ObjectId.isValid(id)
    ? await TaskRunModel.findOne({ _id: id, task: task._id })
    : null
  if (!run) res.status(404).json({ error: "Task run not found" })
  return run
}

/**
 * One page of a task's runs, newest first. `after` comes from afterCursor.
 * Transcripts are left in the database — see `GET /:task_id/runs/:run_id`.
 */
const findRuns = async (taskId: Types.ObjectId, after: Record<string, unknown>) => {
  const rows = await TaskRunModel
    .find({ task: taskId, ...after })
    .select("-transcript")
    .sort(newestFirst("startedAt"))
    .limit(PAGE_SIZE + 1)
  const { items, nextCursor } = toPage(rows, (run) => run.startedAt)
  return { runs: items.map(serializeTaskRunSummary), nextCursor }
}

// Newest first, paged by keyset: pass `nextCursor` back as `?cursor=`. Runs
// omitted — they are paged separately under each task.
router.get("/", async (req: Request, res: Response) => {
  const after = afterCursor(req, res, "createdAt")
  if (!after) return

  const rows = await TaskModel.find(after).sort(newestFirst("createdAt")).limit(PAGE_SIZE + 1)
  const { items, nextCursor } = toPage(rows, (task) => task.createdAt)
  res.json({ tasks: items.map(serializeTask), nextCursor })
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

// The task alone — its runs are under `GET /:task_id/runs`.
router.get("/:task_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  res.json(serializeTask(task))
})

// Newest first, paged by keyset: pass `nextCursor` back as `?cursor=`.
router.get("/:task_id/runs", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  const after = afterCursor(req, res, "startedAt")
  if (!after) return

  res.json(await findRuns(task._id, after))
})

// One run in full, transcript included.
router.get("/:task_id/runs/:run_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  const run = await findRun(task, req.params.run_id, res)
  if (!run) return

  res.json(serializeTaskRun(run))
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
 * App server only — deliberately not an MCP tool. A failed run is given to the
 * next one, so letting the agent delete runs would let it edit its own record
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

  const run = await findRun(task, req.params.run_id, res)
  if (!run) return

  if (run.status === "in_progress") {
    res.status(409).json({
      error:
        "This run is still in progress. Wait for it to finish, or let it be " +
        "closed automatically if its worker has stopped.",
    })
    return
  }

  await run.deleteOne()
  res.json({ id: String(run._id), deleted: true })
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
