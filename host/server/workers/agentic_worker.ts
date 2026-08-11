import { JobQueueName } from "../jobs/application_job.js"
import ApplicationWorker from "./application_worker.js"

export default class AgenticWorker extends ApplicationWorker {
  protected queueName = JobQueueName.AGENTS
  protected concurrency = 3
}