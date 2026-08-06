import { Job } from "bullmq";
import ApplicationJob, { JobQueueName } from "./application_job.js";
import { TaskModel } from "../models/task.js";
import { Agent } from "../agents/index.js";
import { STATUSES, TaskRunModel } from "../models/task_run.js";

export default class AgenticJob extends ApplicationJob {
  public queueName = JobQueueName.AGENTS
  public attempts = 10

  async process(job: Job) {
    const task = await TaskModel.findById(job.data.taskId)
    if(!task) return

    const taskRun = await TaskRunModel.create({ task: task._id })
    const agent = new Agent()
    // Default to failed: anything that escapes the try — including the process
    // dying mid-run — should not read as a success.
    let status: (typeof STATUSES)[number] = "failed"

    try {
      await agent.run(task.prompt)
      status = "success"
    } catch (error) {
      console.error(`Task ${task._id} run failed:`, error)
      // Rethrown below so BullMQ retries per `attempts`; the run row is
      // written first so the failure is visible either way.
      throw error
    } finally {
      await taskRun.updateOne({
        status,
        transcript: JSON.stringify(agent.serializedConversationHistory),
      })

      // Each Agent spawns a stdio child per MCP server. Without this the
      // worker accumulates them for the life of the process.
      await agent.agent.close().catch(() => {})
    }
  }
}