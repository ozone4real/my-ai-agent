import  type { Request, Response } from "express";

export default class SSEStream {
  private req: Request

  constructor(req: Request){
    if(!SSEStream.wantsStream(req)) throw("Request doesn't suppport streaming")
    this.req = req
  }

  async stream(res: Response, input: any[], streamCallback: (...args: any) => AsyncGenerator<any>, doneCallback: (args: any) => Promise<void>, meta?: Record<string, unknown>) {
    res.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();

    // Before the first token, so the client can learn e.g. the id of a
    // just-created conversation.
    if (meta) res.write(this.format("meta", meta));

    // Listen on `res`, not `req`: req's "close" fires when express.json()
    // finishes reading the body, so it is not a disconnect signal.
    // `writableFinished` guards against our own res.end() triggering it.
    let aborted = false;
    res.on("close", () => {
      if (!res.writableFinished) aborted = true
    });

    const result = streamCallback(...input)

    try {
      let data
      for await (data of result) res.write(this.format("token", data))
      await doneCallback(data)

      if (!aborted) res.write(this.format("done", {}));
    } catch (err) {
      // The client only ever sees a generic message, so log the real cause.
      console.error("SSE stream failed:", err)
      if (!aborted) res.write(this.format("error", { message: "Server error" }))
    } finally {
      res.end();
    }
  }

  static wantsStream(req: Request){
    return (req.headers.accept ?? "").includes("text/event-stream");
  }

  private format(event: string, data: any) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }
}