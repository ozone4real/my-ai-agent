import { JobQueueName } from "../jobs/application_job.js"
import ApplicationWorker from "./application_worker.js"

/**
 * The non-agent queue: housekeeping like transcript compaction.
 *
 * Separate from AGENTS because reconcileTaskSchedulers() treats every scheduler
 * on that queue as belonging to a task and removes the ones that don't.
 *
 * Concurrency 1 — this work is a background tidy-up and shouldn't compete with
 * task runs for the model API.
 */
export default class DefaultWorker extends ApplicationWorker {
  protected queueName = JobQueueName.DEFAULT
  protected concurrency = 1
}
