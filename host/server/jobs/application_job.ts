import { Job, JobsOptions, Queue, RepeatOptions } from "bullmq"
import { underscore } from "inflection"

export enum JobQueueName {
  AGENTS = "agents",
  DEFAULT = "default"
}
/**
 * Queues shared across instances — memoising per instance leaked a Redis
 * connection per `new AgenticJob()`, and the Task save hook makes one per write.
 * Keyed on attempts too, since that's baked into `defaultJobOptions`.
 */
const queues = new Map<string, Queue>()

export default abstract class ApplicationJob {
  protected abstract queueName: JobQueueName
  abstract process(job: Job): Promise<void>
  protected abstract attempts: number
  static repeat?: RepeatOptions

  async enqueue(jobData: any, jobOptions: JobsOptions = {}): Promise<void> {
    await this.queue.add(underscore(this.constructor.name), jobData, jobOptions)
  }

  get queue(): Queue {
    const key = `${this.queueName}:${this.attempts}`
    let queue = queues.get(key)
    if (!queue) {
      queue = new Queue(this.queueName, {
        defaultJobOptions: {
          attempts: this.attempts,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
        },
        connection: {
          host: process.env.REDIS_HOST,
          password: process.env.REDIS_PASSWORD,
          // Bounds one connect attempt; does NOT make commands fail fast.
          connectTimeout: 5000,
        },
      })
      queues.set(key, queue)
    }
    return queue
  }

  /**
   * Reject if a queue op outlives `ms`.
   *
   * BullMQ forces `maxRetriesPerRequest = null` and awaits `waitUntilReady()`,
   * so with Redis down commands wait forever — a `save()` that schedules in a
   * post hook hangs rather than erroring, and you can't compensate for a
   * failure you never see.
   *
   * A bounded command may still land later; reconcileTaskSchedulers() cleans up.
   */
  static async withRedisTimeout<T>(work: Promise<T>, ms = 5000): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis did not respond within ${ms}ms`)),
            ms
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Close every shared queue. For tests and clean shutdown. */
  static async closeQueues(): Promise<void> {
    await Promise.all([...queues.values()].map((q) => q.close()))
    queues.clear()
  }
}
