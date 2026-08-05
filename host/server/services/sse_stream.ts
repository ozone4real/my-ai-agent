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

    // Emitted before the first token so the client can learn things it can't
    // get from the status line — notably the id of a just-created conversation,
    // which the non-streaming path returns in its JSON body.
    if (meta) res.write(this.format("meta", meta));

    // Stop streaming if the client disconnects (e.g. the Stop button).
    // NOTE: listen on `res`, not `req`. `req`'s "close" fires as soon as
    // express.json() finishes consuming the (fully-buffered) request body, so it is
    // NOT a disconnect signal. `res`'s "close" fires only when the socket actually
    // goes away; `writableFinished` guards against our own res.end() triggering it.
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