// Every 10 minutes: close browser pages that have been open too long.
//
// Agents are told to close the pages they open, but a run that errors, hits
// maxSteps or simply forgets leaves its page behind, and the shared Chrome
// keeps it running indefinitely — ads, captchas and workers included.
//
// Chrome records neither when a page was opened nor when it was last used, and
// a leftover page's own scripts keep it busy, so activity can't tell an
// abandoned page from a working one. Age can: the first time this job sees a
// page stands in for when it was opened.

import { Job, RepeatOptions } from "bullmq";
import { Redis, RedisOptions } from "ioredis";
import ApplicationJob, { JobQueueName } from "./application_job.js";
import { redisConnection } from "../redis.js";

interface Target {
  id: string;
  type: string;
  url: string;
}

export default class CloseStalePagesJob extends ApplicationJob {
  static jobName = "close_stale_pages_job";
  public queueName = JobQueueName.DEFAULT;
  public attempts = 1;

  static repeat: RepeatOptions = { pattern: "*/10 * * * *" };

  private static readonly SCHEDULER_KEY = "close_stale_pages";

  /** Well past the longest agent run, so no live run still owns a page this old. */
  private static readonly MAX_AGE_MS = 1 * 60 * 60 * 1000;

  /** Hash of Chrome target id -> epoch ms this job first saw it. */
  private static readonly FIRST_SEEN_KEY = "chrome:page_first_seen";

  private static readonly CHROME_URL = process.env.CHROME_URL ?? "http://127.0.0.1:9222";

  /** Register the recurring job. Idempotent; call at worker startup. */
  static async schedule(): Promise<void> {
    const job = new CloseStalePagesJob();
    await ApplicationJob.withRedisTimeout(
      job.queue.upsertJobScheduler(
        CloseStalePagesJob.SCHEDULER_KEY,
        CloseStalePagesJob.repeat,
        { name: CloseStalePagesJob.jobName, data: {} }
      )
    );
  }

  async process(_job: Job): Promise<void> {
    const pages = await this.listPages();
    const firstSeen = await this.recordFirstSeen(pages);
    const now = Date.now();
    const stale = pages.filter(
      (page) => now - firstSeen.get(page.id)! > CloseStalePagesJob.MAX_AGE_MS
    );

    // Closing the last tab closes the window, and headful Chrome exits with it.
    if (stale.length && stale.length === pages.length) {
      await this.devtools("/json/new?about:blank", "PUT");
    }

    for (const page of stale) {
      await this.devtools(`/json/close/${page.id}`);
    }

    if (stale.length) {
      console.log(`Closed ${stale.length} stale browser page(s): ${stale.map((p) => p.url).join(", ")}`);
    }
  }

  private async listPages(): Promise<Target[]> {
    const targets: Target[] = await (await this.devtools("/json/list")).json();
    return targets.filter((target) => target.type === "page");
  }

  /** First-seen time for every open page, forgetting pages that have gone. */
  private async recordFirstSeen(pages: Target[]): Promise<Map<string, number>> {
    const redis = new Redis(redisConnection as RedisOptions);
    try {
      const stored = await redis.hgetall(CloseStalePagesJob.FIRST_SEEN_KEY);
      const now = Date.now();

      const firstSeen = new Map(pages.map((page) => [page.id, Number(stored[page.id] ?? now)]));
      const added = pages.filter((page) => !(page.id in stored));
      const gone = Object.keys(stored).filter((id) => !firstSeen.has(id));

      if (added.length) {
        await redis.hset(
          CloseStalePagesJob.FIRST_SEEN_KEY,
          Object.fromEntries(added.map((page) => [page.id, now]))
        );
      }
      if (gone.length) await redis.hdel(CloseStalePagesJob.FIRST_SEEN_KEY, ...gone);

      return firstSeen;
    } finally {
      redis.disconnect();
    }
  }

  private async devtools(path: string, method = "GET"): Promise<Response> {
    const response = await fetch(`${CloseStalePagesJob.CHROME_URL}${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Chrome ${method} ${path}: ${response.status}`);
    return response;
  }
}
