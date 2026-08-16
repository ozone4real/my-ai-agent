// Bull Board — the queue inspector, mounted at /api/admin/queues.
//
// Behind the same Basic auth as the rest of the API (registered in index.ts
// before the /api mount), which matters: the board can retry, promote and
// delete jobs, not just display them.

import { createBullBoard } from "@bull-board/api"
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter"
import { ExpressAdapter } from "@bull-board/express"
import { Queue } from "bullmq"
import { JobQueueName } from "../../jobs/application_job.js"
import { redisConnection } from "../../redis.js"

/**
 * Where the board believes it lives, used to build every link and asset URL it
 * renders. It has to spell out the full path from the domain root — the router
 * mounts at /admin/queues but sits under the /api mount in index.ts, and with
 * only the inner half the UI would request its JS from /admin/queues/static,
 * fall through to the SPA catch-all, and load a blank page that serves HTML
 * where the script should be.
 */
const BASE_PATH = "/api/admin/queues"

const serverAdapter = new ExpressAdapter()
serverAdapter.setBasePath(BASE_PATH)

/**
 * The board's own Queue handles — read/control connections, distinct from the
 * ones ApplicationJob memoises for enqueueing. Held here so they can be closed
 * on shutdown instead of keeping the process alive.
 */
const queues = Object.values(JobQueueName).map(
  (name) => new Queue(name, { connection: redisConnection })
)

createBullBoard({
  queues: queues.map((queue) => new BullMQAdapter(queue)),
  serverAdapter,
})

/** Close the board's Redis connections. For clean shutdown. */
export async function closeBullBoardQueues(): Promise<void> {
  await Promise.all(queues.map((queue) => queue.close()))
}

export default serverAdapter.getRouter()
