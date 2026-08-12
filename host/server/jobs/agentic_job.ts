import { Job } from "bullmq";
import type { Types } from "mongoose";
import ApplicationJob, { JobQueueName } from "./application_job.js";
import { TaskModel } from "../models/task.js";
import { Agent, type AgentMessage } from "../agents/index.js";
import { STATUSES, TaskRunModel } from "../models/task_run.js";

type Status = (typeof STATUSES)[number]

export default class AgenticJob extends ApplicationJob {
  static jobName = "agentic_job"
  public queueName = JobQueueName.AGENTS
  public attempts = 10

  /** Runs that got as far as recording an outcome, either way. */
  private static readonly FINISHED: Status[] = ["success", "failed"]

  async process(job: Job) {
    const task = await TaskModel.findById(job.data.taskId)
    if(!task) return

    // Read prior runs BEFORE inserting this one's row, so the query can't match
    // the record we are about to create.
    const context = await this.previousTranscripts(task._id)

    const taskRun = await TaskRunModel.create({ task: task._id })
    // Nothing here consumes tokens as they arrive, and a streamed response body
    // held open for a whole generation is what gets cut mid-flight
    // ("TypeError: terminated", cause ECONNRESET) — a failure the SDK cannot
    // retry once the stream has started. A single response can be retried.
    const agent = await Agent.withSettings({ streaming: false })
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
      // Nothing to release: the agent is unreachable after this and gets
      // collected with its history. Never agent.close() — the MCP connectors
      // are shared process-wide and closing them ends every in-flight run.
      await taskRun.updateOne({
        status,
        transcript: JSON.stringify(agent.serializedConversationHistory),
      })
    }
  }

  /**
   * Every finished run's transcript, oldest first, so a repeating task carries
   * its whole history rather than only the last attempt.
   *
   * Failed runs count — "last time this errored on X" is worth having.
   * `in_progress` is skipped: a concurrent run, or one that died mid-flight.
   * Best-effort; a corrupt transcript is skipped rather than failing the run.
   *
   * Each stored transcript holds only that run's own turns, so concatenating
   * them doesn't duplicate anything. Old ones are replaced by summaries —
   * see CompactTranscriptsJob — which is what keeps this from growing forever.
   */
  private async previousTranscripts(taskId: Types.ObjectId): Promise<AgentMessage[]> {
    const runs = await TaskRunModel.find({
      task: taskId,
      status: { $in: AgenticJob.FINISHED },
      transcript: { $nin: [null, ""] },
    })
      // Ascending: the most recent run ends up nearest the prompt.
      .sort({ endedAt: 1, _id: 1 })
      .lean()

    return runs.flatMap((run) => {
      try {
        const parsed = JSON.parse(run.transcript!)
        return Array.isArray(parsed) ? (parsed as AgentMessage[]) : []
      } catch {
        console.warn(`Task run ${run._id} has an unreadable transcript; skipping it`)
        return []
      }
    })
  }
}
