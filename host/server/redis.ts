// Redis connection options shared by everything that talks to BullMQ — the
// queues jobs enqueue onto, the workers that drain them, and the Bull Board UI.
//
// One definition on purpose: these three must agree on host and password or
// they silently operate on different Redis instances. Bull Board is the case
// that makes this concrete — pointed at the default localhost it renders a
// working, permanently empty board rather than an error.

import type { ConnectionOptions } from "bullmq";

export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD,
  // Bounds one connect attempt; does NOT make commands fail fast.
  connectTimeout: 5000,
};
