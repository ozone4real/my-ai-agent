// MongoDB connection for the host server.
//
// Set MONGODB_URI in .env to point at your database; the default targets a
// local mongod. connectDB() is safe to call more than once — the connection
// promise is cached, so tsx reloads reuse one connection instead of stacking up.

import mongoose from "mongoose";

const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/my-mcp-server";

if(process.env.NODE_ENV !== "production") {
  mongoose.set('debug', (collectionName, methodName, ...methodArgs) => {
    const startTime = performance.now(); // High-resolution timestamp

    // Defer time calculation to the end of the current execution cycle
    setImmediate(() => {
      const duration = (performance.now() - startTime).toFixed(2);
      const args = methodArgs.map(arg => JSON.stringify(arg)).join(', ');
      
      console.log(`Mongoose: ${collectionName}.${methodName}(${args}) - ${duration}ms`);
    });
  });
}

let connection: Promise<typeof mongoose> | null = null;

export function connectDB(): Promise<typeof mongoose> {
  if (!connection) {
    // Clear the cache on failure so a later call can retry rather than
    // re-await the same rejected promise forever.
    connection = mongoose.connect(MONGODB_URI).catch((err) => {
      connection = null;
      throw err;
    });
  }
  return connection;
}

export async function disconnectDB(): Promise<void> {
  if (!connection) return;
  await mongoose.disconnect();
  connection = null;
}
