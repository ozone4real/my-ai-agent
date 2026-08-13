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
  public attempts = 1

  /** Runs that got as far as recording an outcome, either way. */
  private static readonly FINISHED: Status[] = ["success", "failed"]

  /** How many prior runs are replayed into a run. Older history is behind `get-task`. */
  private static readonly REPLAYED_RUNS = 5

  /**
   * Of those, how many must be successful runs.
   *
   * A run of bad nights would otherwise fill the whole window with failures and
   * the agent would lose sight of what a completed run looks like — exactly
   * when it most needs to know what has already been done.
   */
  private static readonly REPLAYED_SUCCESSES = 2

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
    let failure: string | null = null

    try {
      await agent.run(task.prompt, context)
      status = "success"
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      console.error(`Task ${task._id} run failed:`, error)
      // Rethrown so BullMQ retries; the run row is written first regardless.
      throw error
    } finally {
      // Nothing to release: the agent is unreachable after this and gets
      // collected with its history. Never agent.close() — the MCP connectors
      // are shared process-wide and closing them ends every in-flight run.
      await taskRun.updateOne({
        status,
        transcript: JSON.stringify(this.transcriptFor(agent, failure)),
      })
    }
  }

  /**
   * The recent run transcripts, oldest first, so a repeating task carries its
   * memory forward without replaying every night it has ever had.
   *
   * Bounded rather than complete: an unbounded window is re-sent on every model
   * call of the run, so it grows the bill with the task's age. Anything outside
   * the window is still reachable — `get-task` returns every run with its
   * transcript.
   *
   * Failed runs count — "last time this errored on X" is worth having.
   * `in_progress` is skipped: a concurrent run, or one that died mid-flight.
   * Best-effort; a corrupt transcript is skipped rather than failing the run.
   *
   * Each stored transcript holds only that run's own turns, so concatenating
   * them doesn't duplicate anything.
   */
  private async previousTranscripts(taskId: Types.ObjectId): Promise<AgentMessage[]> {
    const runs = await this.runsToReplay(taskId)

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

  /** The most recent runs, topped up with successes, oldest first. */
  private async runsToReplay(taskId: Types.ObjectId) {
    const withTranscript = {
      task: taskId,
      transcript: { $nin: [null, ""] },
    }

    const recent = await TaskRunModel.find({
      ...withTranscript,
      status: { $in: AgenticJob.FINISHED },
    })
      .sort({ endedAt: -1, _id: -1 })
      .limit(AgenticJob.REPLAYED_RUNS)
      .lean()

    const shortfall =
      AgenticJob.REPLAYED_SUCCESSES - recent.filter((run) => run.status === "success").length

    let selected = recent
    if (shortfall > 0) {
      // Reach further back for successes the recent window missed.
      const successes = await TaskRunModel.find({
        ...withTranscript,
        status: "success",
        _id: { $nin: recent.map((run) => run._id) },
      })
        .sort({ endedAt: -1, _id: -1 })
        .limit(shortfall)
        .lean()

      // Stay within the cap by giving up the oldest of the recent runs — those
      // are the failures the successes are being fetched to balance.
      if (successes.length) {
        selected = [...recent.slice(0, AgenticJob.REPLAYED_RUNS - successes.length), ...successes]
      }
    }

    // Ascending: the most recent run ends up nearest the prompt.
    return selected.sort(
      (a, b) => new Date(a.endedAt).getTime() - new Date(b.endedAt).getTime()
    )
  }

  /**
   * What to store for this run.
   *
   * mcp-use commits a turn's messages to history in one batch *after* the loop
   * finishes, so a run that throws — hitting the step limit, losing the
   * connection — leaves the history empty and would otherwise be recorded as
   * `[]`. Appending the error means the next run learns something from the
   * attempt instead of replaying nothing.
   */
  private transcriptFor(agent: Agent, failure: string | null): AgentMessage[] {
    const history = agent.serializedConversationHistory
    if (!failure) return history

    return [
      ...history,
      { role: "assistant", content: `This run did not finish. It failed with: ${failure}` },
    ]
  }
}
