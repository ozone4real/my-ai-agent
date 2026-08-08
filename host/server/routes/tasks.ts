import { Router } from "express"
import type { Request, Response } from "express"
import { Types } from "mongoose"
import { TaskModel } from "../models/task"
import { TaskRunModel } from "../models/task_run"
import {
  applyTaskUpdate,
  serializeTask,
  serializeTaskRun,
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

router.get("/:task_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  const runs = await TaskRunModel.find({ task: task._id }).sort({ startedAt: -1 })
  res.json({ ...serializeTask(task), runs: runs.map(serializeTaskRun) })
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
