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
    const agent = new Agent()
    // Default to failed: anything that escapes the try — including the process
    // dying mid-run — should not read as a success.
    let status: Status = "failed"

    try {
      await agent.run(task.prompt, context)
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

  /**
   * The transcript of this task's last finished run, so a repeating task can
   * pick up where it left off instead of starting cold each time.
   *
   * Failed runs count: "last time this errored on X" is context worth having.
   * Runs still `in_progress` are skipped — that covers both a concurrent run
   * and one whose process died before writing an outcome.
   *
   * Best-effort. A missing or corrupt transcript yields no context rather than
   * failing the run, since the task can still do its job without history.
   *
   * Note this is a one-step lookback, not an accumulating chain: an agent's
   * stored history holds only its own turns, so what it was given as context
   * doesn't end up in the transcript it writes.
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
