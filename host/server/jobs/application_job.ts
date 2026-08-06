import { Job, JobsOptions, Queue, RepeatOptions } from "bullmq"
import { underscore } from "inflection"

export enum JobQueueName {
  AGENTS = "agents",
  DEFAULT = "default"
}
/**
 * Queues shared across every instance.
 *
 * Each `new Queue()` opens its own Redis connection and nothing here ever
 * closes them, so memoising per *instance* leaked one connection per
 * `new AgenticJob()` — and the Task save hook constructs one on every write.
 * Keyed by queue name plus attempts, because `attempts` is baked into the
 * queue's `defaultJobOptions` and two job classes on one queue may want
 * different retry counts.
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
          // Bounds how long a single connect attempt waits. It does NOT make
          // commands fail fast on its own — see withRedisTimeout below.
          connectTimeout: 5000,
        },
      })
      queues.set(key, queue)
    }
    return queue
  }

  /**
   * Reject if a queue operation outlives `ms`.
   *
   * Necessary because BullMQ won't let a producer fail fast: it forces
   * `maxRetriesPerRequest = null` on the connection whenever `blocking` is set
   * (the default) and awaits `waitUntilReady()` before issuing a command. With
   * Redis unreachable that means commands wait forever, so a `save()` that
   * schedules in a post hook hangs the request instead of erroring — and you
   * can't compensate for a failure you never observe.
   *
   * The bounded command may still land later if Redis comes back. That leaves a
   * scheduler with no task behind it, which `reconcileTaskSchedulers()` removes.
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
