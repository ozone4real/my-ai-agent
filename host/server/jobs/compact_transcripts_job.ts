// Hourly: replace old task-run transcripts with AI-written summaries.
//
// AgenticJob replays every finished run of a task into the next one, so raw
// transcripts would grow the prompt without bound. This keeps the two most
// recent successful runs verbatim — those are the ones worth having in full —
// and summarises everything older.

import { Job, RepeatOptions } from "bullmq";
import type { Types } from "mongoose";
import { ChatDeepSeek } from "@langchain/deepseek";
import ApplicationJob, { JobQueueName } from "./application_job.js";
import { STATUSES, TaskRunModel } from "../models/task_run.js";
import { ModelType } from "../agents/models.js";

type Status = (typeof STATUSES)[number];

export default class CompactTranscriptsJob extends ApplicationJob {
  static jobName = "compact_transcripts_job";
  public queueName = JobQueueName.DEFAULT;
  public attempts = 3;

  /** Top of every hour. */
  static repeat: RepeatOptions = { pattern: "0 * * * *" };

  /**
   * A fixed key, so re-running `schedule()` updates the one scheduler instead of
   * adding another. Not on the AGENTS queue: reconcileTaskSchedulers() removes
   * every scheduler there whose key isn't a task id, and would delete this.
   */
  private static readonly SCHEDULER_KEY = "compact_transcripts";

  private static readonly FINISHED: Status[] = ["success", "failed"];

  /** Runs kept verbatim per task — the most recent successful ones. */
  private static readonly KEEP_VERBATIM = 2;

  /**
   * Ceiling on what goes to the model. A single run can be six figures of
   * characters; summarising the head is worth more than failing on the whole.
   */
  private static readonly MAX_INPUT_CHARS = 60_000;

  private static readonly PROMPT =
    "You are compacting the transcript of an automated agent run so it can be " +
    "replayed as context into future runs of the same recurring task.\n\n" +
    "Write a summary that preserves what a future run needs to continue well:\n" +
    "- what the run was asked to do and whether it succeeded\n" +
    "- concrete results: identifiers, filenames, URLs, counts, values produced\n" +
    "- decisions taken and why, so they are not relitigated\n" +
    "- errors, blockers and anything that had to be worked around\n" +
    "- state left behind: files written, processes started, things half-done\n\n" +
    "Drop tool-call mechanics, retries that led nowhere, and narration. Be " +
    "specific over general — a date, a path or an id is worth more than an " +
    "adjective. Reply with the summary only, no preamble.";

  /**
   * Register the recurring job. Idempotent; call at worker startup.
   */
  static async schedule(): Promise<void> {
    const job = new CompactTranscriptsJob();
    await ApplicationJob.withRedisTimeout(
      job.queue.upsertJobScheduler(
        CompactTranscriptsJob.SCHEDULER_KEY,
        CompactTranscriptsJob.repeat,
        { name: CompactTranscriptsJob.jobName, data: {} }
      )
    );
  }

  async process(_job: Job): Promise<void> {
    const taskIds = await this.tasksWithCompactableRuns();

    let compacted = 0;
    let failed = 0;

    for (const taskId of taskIds) {
      for (const run of await this.compactableRuns(taskId)) {
        try {
          const summary = await this.summarise(run.transcript!);
          await TaskRunModel.updateOne(
            { _id: run._id },
            {
              // Same DeepSeekMessage[] shape as a real transcript, so
              // AgenticJob loads it without a special case.
              transcript: JSON.stringify([{ role: "assistant", content: summary }]),
              compacted: true,
            }
          );
          compacted++;
        } catch (error) {
          // Left uncompacted so the next hour retries it. One bad run must not
          // stop the rest.
          failed++;
          console.warn(
            `Could not compact task run ${run._id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    if (compacted || failed) {
      console.log(`Transcript compaction: ${compacted} compacted, ${failed} failed`);
    }
  }

  /** Tasks with at least one finished, uncompacted, non-empty transcript. */
  private async tasksWithCompactableRuns(): Promise<Types.ObjectId[]> {
    return TaskRunModel.distinct("task", {
      compacted: false,
      status: { $in: CompactTranscriptsJob.FINISHED },
      transcript: { $nin: [null, ""] },
    });
  }

  /** That task's compactable runs, excluding the ones kept verbatim. */
  private async compactableRuns(taskId: Types.ObjectId) {
    const keep = await TaskRunModel.find({ task: taskId, status: "success" })
      .sort({ endedAt: -1, _id: -1 })
      .limit(CompactTranscriptsJob.KEEP_VERBATIM)
      .select("_id")
      .lean();

    return TaskRunModel.find({
      task: taskId,
      compacted: false,
      status: { $in: CompactTranscriptsJob.FINISHED },
      transcript: { $nin: [null, ""] },
      _id: { $nin: keep.map((run) => run._id) },
    })
      .select("_id transcript")
      .lean();
  }

  /**
   * One LLM call — no MCP tools.
   *
   * Summarising needs no filesystem, browser or shell, and the agent's tool
   * schemas are ~92k tokens that would be re-sent on every call.
   */
  private async summarise(transcript: string): Promise<string> {
    const { loadSettings } = await import("../models/settings.js");
    const settings = await loadSettings();

    const llm = new ChatDeepSeek({
      model: (settings.defaultModel as ModelType) ?? ModelType.DEEPSEEK_V4_FLASH,
      apiKey: process.env.DEEP_SEEK_API_KEY,
      maxTokens: 1500,
    });

    const body = transcript.slice(0, CompactTranscriptsJob.MAX_INPUT_CHARS);
    const truncated = body.length < transcript.length ? "\n\n[transcript truncated]" : "";

    const reply = await llm.invoke([
      { role: "system", content: CompactTranscriptsJob.PROMPT },
      { role: "user", content: body + truncated },
    ]);

    const summary = typeof reply.content === "string"
      ? reply.content.trim()
      : JSON.stringify(reply.content);

    if (!summary) throw new Error("model returned an empty summary");
    return summary;
  }
}
