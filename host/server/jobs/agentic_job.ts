import { Job } from "bullmq";
import type { Types } from "mongoose";
import ApplicationJob, { JobQueueName } from "./application_job.js";
import { TaskModel } from "../models/task.js";
import { Agent, type AgentMessage, type AgentToolCall } from "../agents/index.js";
import type { ModelType } from "../agents/model_types.js";
import { STATUSES, TaskRunModel } from "../models/task_run.js";

type Status = (typeof STATUSES)[number]

export default class AgenticJob extends ApplicationJob {
  static jobName = "agentic_job"
  public queueName = JobQueueName.AGENTS
  public attempts = 1

  /** Runs that got as far as recording an outcome, either way. */
  private static readonly FINISHED: Status[] = ["success", "failed"]

  /** How many prior runs are replayed into a run. Older history is behind `get-task`. */
  private static readonly REPLAYED_RUNS = 3

  /**
   * Opens the note left on a run that ended by throwing.
   *
   * Load-bearing: a note with nothing after it is all a bare failure has to
   * say, and replaying "the agent hit a recursion limit" into later runs is
   * noise at best. {@link isBareFailure} matches on this.
   */
  private static readonly FAILURE_NOTE = "This run did not finish."

  /** Introduces the work a failed run got through before it died. */
  private static readonly STEPS_HEADING = "Before failing, it took these steps:"

  /**
   * After this, an `in_progress` run is treated as abandoned.
   *
   * A run only leaves `in_progress` in its own `finally`, so a worker that is
   * killed, OOMed or redeployed mid-run leaves the row behind forever. With one
   * run per task enforced, such a row would block that task permanently, so it
   * has to be reclaimable. Generous: real runs take minutes, not hours.
   */
  private static readonly ABANDONED_AFTER_MS = 3 * 60 * 60 * 1000

  async process(job: Job) {
    const task = await TaskModel.findById(job.data.taskId)
    if(!task) return

    // Read prior runs BEFORE inserting this one's row, so the query can't match
    // the record we are about to create.
    const context = await this.previousTranscripts(task._id)

    const taskRun = await this.startRun(task._id)
    // Another run of this task is live. Returning rather than throwing: this is
    // the constraint working, not a failure, and throwing would retry it.
    if (!taskRun) {
      console.warn(`Task ${task._id} already has a run in progress; skipping this one`)
      return
    }

    // Nothing here consumes tokens as they arrive, and a streamed response body
    // held open for a whole generation is what gets cut mid-flight
    // ("TypeError: terminated", cause ECONNRESET) — a failure the SDK cannot
    // retry once the stream has started. A single response can be retried.
    const agent = await Agent.withSettings({
      // undefined falls through to the app default inside withSettings.
      model: task.agentModel as ModelType | undefined,
      streaming: false,
    })
    // Default failed: anything that escapes the try isn't a success.
    let status: Status = "failed"
    let failure: string | null = null

    // Streamed rather than `run()` so the steps are in hand when it throws.
    // mcp-use commits the turn's messages to history in one batch after the
    // loop, so a run that dies leaves `serializedConversationHistory` empty —
    // and a run can die *after* doing its work, as one did after emailing a job
    // application. Collecting steps as they arrive is the only record of that.
    const steps: AgentToolCall[] = []

    try {
      for await (const payload of agent.stream(task.prompt, context)) {
        if (payload.phase === "working") AgenticJob.recordStep(steps, payload.value)
      }
      status = "success"
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      console.error(`Task ${task._id} run failed after ${steps.length} step(s):`, error)
      // Rethrown so BullMQ retries; the run row is written first regardless.
      throw error
    } finally {
      // Nothing to release: the agent is unreachable after this and gets
      // collected with its history. Never agent.close() — the MCP connectors
      // are shared process-wide and closing them ends every in-flight run.
      await taskRun.updateOne({
        status,
        transcript: JSON.stringify(this.transcriptFor(agent, failure, steps)),
      })
    }
  }

  /**
   * Append a step, unless it repeats one already seen.
   *
   * The stream re-yields steps it has already emitted — one `echo` produced
   * five identical payloads in testing — so this keys on the call itself.
   * A genuine repeat of the same tool with the same arguments collapses too,
   * which for a record of what a run did is no loss.
   */
  private static recordStep(steps: AgentToolCall[], value: unknown): void {
    const action = (value as { action?: { tool?: string; toolInput?: unknown } })?.action
    if (!action?.tool) return

    const call = { tool: action.tool, args: action.toolInput }
    const key = `${call.tool}|${JSON.stringify(call.args ?? null)}`
    if (steps.some((s) => `${s.tool}|${JSON.stringify(s.args ?? null)}` === key)) return
    steps.push(call)
  }

  /**
   * Open a run, or `null` if this task already has one going.
   *
   * The uniqueness is the index's, not this method's — two workers racing here
   * both see no in-progress run, and Mongo rejects the loser's insert.
   */
  private async startRun(taskId: Types.ObjectId) {
    try {
      return await TaskRunModel.create({ task: taskId })
    } catch (error) {
      if (!AgenticJob.isDuplicateRun(error)) throw error

      // Only reclaim once the blocker is old enough to be abandoned rather than
      // merely slow, then take the slot. A second rejection means a real run
      // started in between; that one wins.
      if (!(await this.reapAbandonedRun(taskId))) return null
      try {
        return await TaskRunModel.create({ task: taskId })
      } catch (retryError) {
        if (AgenticJob.isDuplicateRun(retryError)) return null
        throw retryError
      }
    }
  }

  private static isDuplicateRun(error: unknown): boolean {
    return (error as { code?: number })?.code === 11000
  }

  /** Fail the task's in-progress run if it is old enough to be abandoned. */
  private async reapAbandonedRun(taskId: Types.ObjectId): Promise<boolean> {
    const cutoff = new Date(Date.now() - AgenticJob.ABANDONED_AFTER_MS)
    const result = await TaskRunModel.updateOne(
      { task: taskId, status: "in_progress", startedAt: { $lt: cutoff } },
      {
        status: "failed",
        transcript: JSON.stringify([
          {
            role: "assistant",
            content:
              "This run never reported an outcome — the worker stopped before it could. " +
              "It was closed automatically so the task could run again.",
          },
        ]),
      },
      // `endedAt` is `updatedAt`; stamping it now would date the run to the
      // reaping rather than to when it actually ran.
      { timestamps: false }
    )

    if (result.modifiedCount) {
      console.warn(`Task ${taskId}: closed an abandoned run so a new one could start`)
    }
    return result.modifiedCount > 0
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
   * Failed runs are kept only when they recorded something; see
   * {@link isBareFailure}. `in_progress` is skipped: a concurrent run, or one
   * that died mid-flight.
   *
   * Each stored transcript holds only that run's own turns, so concatenating
   * them doesn't duplicate anything.
   */
  private async previousTranscripts(taskId: Types.ObjectId): Promise<AgentMessage[]> {
    const runs = await this.runsToReplay(taskId)

    return runs.flatMap((run) => {
      const messages = AgenticJob.parseTranscript(run.transcript!)
      return AgenticJob.isBareFailure(messages) ? [] : messages
    })
  }

  /**
   * A stored transcript as messages.
   *
   * Falls back to treating the raw text as one assistant message rather than
   * discarding the run: these records get edited by hand, and a note pasted in
   * as plain text is worth more than the nothing a parse failure used to yield.
   */
  private static parseTranscript(transcript: string): AgentMessage[] {
    try {
      const parsed = JSON.parse(transcript)
      if (Array.isArray(parsed)) return parsed as AgentMessage[]
    } catch {
      // Not JSON — fall through.
    }
    return [{ role: "assistant", content: transcript }]
  }

  /** The most recent finished runs that have a transcript, oldest first. */
  private async runsToReplay(taskId: Types.ObjectId) {
    const recent = await TaskRunModel.find({
      task: taskId,
      transcript: { $nin: [null, ""] },
      status: { $in: AgenticJob.FINISHED },
    })
      .sort({ endedAt: -1, _id: -1 })
      .limit(AgenticJob.REPLAYED_RUNS)
      .lean()

    // Ascending: the most recent run ends up nearest the prompt.
    return recent.reverse()
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
  private transcriptFor(
    agent: Agent,
    failure: string | null,
    steps: AgentToolCall[]
  ): AgentMessage[] {
    const history = agent.serializedConversationHistory
    if (!failure) return history

    const note = [`${AgenticJob.FAILURE_NOTE} It failed with: ${failure}`]
    if (steps.length) {
      note.push(
        "",
        AgenticJob.STEPS_HEADING,
        ...steps.map((s) => `- ${s.tool} ${JSON.stringify(s.args ?? {})}`),
        "",
        "Whether each one took effect is unrecorded; treat them as attempted, not confirmed."
      )
    }

    return [...history, { role: "assistant", content: note.join("\n") }]
  }

  /**
   * A failed run that recorded nothing but the fact that it failed.
   *
   * Replaying "the agent hit a recursion limit" tells the next run nothing and
   * costs it a slot in the window, so these are skipped. Anything else on a
   * failed run is kept — including notes added by hand to a run's transcript.
   */
  private static isBareFailure(messages: AgentMessage[]): boolean {
    if (messages.length !== 1) return false
    const content = String((messages[0] as { content?: unknown })?.content ?? "")
    return (
      content.startsWith(AgenticJob.FAILURE_NOTE) &&
      !content.includes(AgenticJob.STEPS_HEADING)
    )
  }
}
