import { Job, Worker } from "bullmq"
import ApplicationJob, { JobQueueName } from "../jobs/application_job.js"
import AgenticJob from "../jobs/agentic_job.js"

const JOBS: Record<string, typeof ApplicationJob> = { agentic_job: AgenticJob }


export default abstract class ApplicationWorker {
  protected abstract queueName: JobQueueName
  protected abstract concurrency: number
  private _worker: Worker | undefined

  get worker(): Worker {
    this._worker ||= new Worker(this.queueName, this.process.bind(this), {
      autorun: false,
      connection: { host: process.env.REDIS_HOST, password: process.env.REDIS_PASSWORD },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 20000, age: 24 * 3600 * 7 },
      concurrency: this.concurrency,
    })
    return this._worker
  }

  run() {
    this.worker.on("completed", (job) => {
      console.log(`Job ${job.id} on ${job.queueName} completed!`)
    })

    this.worker.on("progress", (job: Job) => {
      console.log(`Processing Job ${job}`)
    })

    this.worker.on("failed", (job, err) => {
      console.log(`Job ${job?.id} failed with error:`, err)
    })

    this.worker.on("error", (error) => {
      console.log(error)
      console.log(`Worker error: ${error.message}`)
    })
    this.worker.run()
  }

  /** Stop accepting jobs and wait for the one in flight to finish. */
  async close(): Promise<void> {
    await this.worker.close()
  }

  protected async process(job: Job) {
    const jobClass = JOBS[job.name]
    if (jobClass) {
      const instance = new (jobClass as any)()
      await instance.process(job)
    }
  }
}
