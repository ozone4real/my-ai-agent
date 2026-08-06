import { Router } from "express"
import type { Request, Response } from "express"
import { Types } from "mongoose"
import { TaskModel } from "../models/task"
import { TaskRunModel } from "../models/task_run"
import { serializeTask, serializeTaskRun } from "../serializers/task"

const router = Router()

/**
 * An id that isn't a valid ObjectId makes findById throw a CastError, which
 * would surface as a 500. A bad id is a 404.
 */
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

// Newest first. Runs are deliberately omitted — a thread of runs per task would
// make this response grow without bound; fetch one task to see its history.
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

router.delete("/:task_id", async (req: Request, res: Response) => {
  const task = await findTask(req.params.task_id, res)
  if (!task) return

  // Runs belong to the task and are unreachable once it's gone, so they go with
  // it rather than lingering as orphan rows.
  const { deletedCount } = await TaskRunModel.deleteMany({ task: task._id })
  await task.deleteOne()

  res.json({ id: String(task._id), deleted: true, deletedRuns: deletedCount ?? 0 })
})

export default router
