import { Job, JobsOptions, Queue, RepeatOptions } from "bullmq"
import { underscore } from "inflection"

export enum JobQueueName {
  AGENTS = "agents",
  DEFAULT = "default"
}
export default abstract class ApplicationJob {
  protected abstract queueName: JobQueueName
  abstract process(job: Job): Promise<void>
  protected abstract attempts: number
  private _queue: Queue | undefined
  static repeat?: RepeatOptions

  async enqueue(jobData: any, jobOptions: JobsOptions = {}): Promise<void> {
    await this.queue.add(underscore(this.constructor.name), jobData, jobOptions)
  }

  get queue(): Queue {
    return (this._queue ||= new Queue(this.queueName, {
      defaultJobOptions: {
        attempts: this.attempts,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
      },
      connection: {
        host: process.env.REDIS_HOST,
        password: process.env.REDIS_PASSWORD
      },
    }))
  }
}
