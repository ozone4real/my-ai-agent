import { Job } from "bullmq";
import type { Types } from "mongoose";
import ApplicationJob, { JobQueueName } from "./application_job.js";
import { TaskModel } from "../models/task.js";
import { Agent, type AgentMessage } from "../agents/index.js";
import { STATUSES, TaskRunModel } from "../models/task_run.js";

type Status = (typeof STATUSES)[number]

export default class AgenticJob extends ApplicationJob {
  public queueName = JobQueueName.AGENTS
  public attempts = 10

  /** Runs that got as far as recording an outcome, either way. */
  private static readonly FINISHED: Status[] = ["success", "failed"]

  async process(job: Job) {
    const task = await TaskModel.findById(job.data.taskId)
    if(!task) return

    // Read the previous run BEFORE inserting this one's row, so the query
    // can't match the record we are about to create.
    const context = await this.previousTranscript(task._id)

    const taskRun = await TaskRunModel.create({ task: task._id })
    const agent = await Agent.withSettings()
    // Default failed: anything that escapes the try isn't a success.
    let status: Status = "failed"

    try {
      await agent.run(task.prompt, context)
      status = "success"
    } catch (error) {
      console.error(`Task ${task._id} run failed:`, error)
      // Rethrown so BullMQ retries; the run row is written first regardless.
      throw error
    } finally {
      await taskRun.updateOne({
        status,
        transcript: JSON.stringify(agent.serializedConversationHistory),
      })

      // Each Agent spawns a stdio child per MCP server.
      await agent.agent.close().catch(() => {})
    }
  }

  /**
   * The last finished run's transcript, so a repeating task isn't starting cold.
   *
   * Failed runs count — "last time this errored on X" is worth having.
   * `in_progress` is skipped: a concurrent run, or one that died mid-flight.
   * Best-effort; a corrupt transcript yields no context rather than failing.
   *
   * One-step lookback, not a chain: an agent's stored history holds only its
   * own turns, so replayed context doesn't compound.
   */
  private async previousTranscript(taskId: Types.ObjectId): Promise<AgentMessage[]> {
    const previous = await TaskRunModel.findOne({
      task: taskId,
      status: { $in: AgenticJob.FINISHED },
    })
      .sort({ endedAt: -1, _id: -1 })
      .lean()

    if (!previous?.transcript) return []

    try {
      const parsed = JSON.parse(previous.transcript)
      return Array.isArray(parsed) ? (parsed as AgentMessage[]) : []
    } catch {
      console.warn(
        `Task run ${previous._id} has an unreadable transcript; running without it`
      )
      return []
    }
  }
}
