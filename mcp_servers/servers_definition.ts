export default {
  // This project's own MCP server (mcp_servers/index.ts) — scheduled tasks and
  // their run history. Started with `npm run app-mcp`.
  //
  // A `url` rather than `command`/`args`: mcp-use v2's MCPServer is Hono/Fetch
  // based and has no stdio transport, so it can't be spawned as a child the way
  // the servers below are. It has to already be listening.
  app: {
    url: process.env.APP_MCP_URL ?? "http://localhost:8000/mcp",
  },
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ezenwaogbonna/Desktop"],
  },
  shellCommandExecutor: {
    command: "npx",
    args: ["tsx", "mcp_servers/command_executor.ts"]
  },
  chromedevtools: {
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222", "--ignoreDefaultChromeArg=--enable-automation"]
  },
  brevo: {
    command: "npx",
    args: [
      "mcp-remote",
      "https://mcp.brevo.com/v1/brevo/mcp",
      "--header",
      "Authorization: Bearer ${BREVO_MCP_TOKEN}"
    ],
    env: {
      BREVO_MCP_TOKEN: process.env.BREVO_MCP_TOKEN ?? ""
    }
  },
  // Web search against the local SearXNG in searxng/ (`npm run search:up`).
  // Fully self-hosted and key-free: SearXNG is AGPL-3.0, mcp-searxng is MIT.
  // If the container isn't running, this server starts but every search fails
  // — the agent's other tools are unaffected.
  websearch: {
    command: "npx",
    args: ["-y", "mcp-searxng"],
    // These are operator caps, not defaults the model can talk its way past —
    // mcp-searxng clamps whatever the model asks for down to them.
    env: {
        SEARXNG_URL: process.env.SEARXNG_URL ?? "http://localhost:8888",
        // `text` is title + url + snippet per hit; the JSON format also carries
        // engine names and per-engine scores the model has no use for.
        SEARXNG_DEFAULT_RESPONSE_FORMAT: "text",
        // Smaller tool schemas. These are re-sent on every model call, so the
        // saving is per-turn, not per-search.
        SEARXNG_LITE_TOOLS: "true",
        // A metasearch page is ~37 hits across engines. The answer is almost
        // always in the first few, and the tail is mostly near-duplicates.
        SEARXNG_MAX_RESULTS: "5",
        SEARXNG_MAX_RESULT_CHARS: "4000",
        // The one that actually dominates the bill: without a cap, one
        // web_url_read of a long article can outweigh every search in the turn.
        URL_READ_MAX_CHARS: "8000",
        // Stop before downloading something huge just to extract 8k of text.
        URL_READ_MAX_CONTENT_LENGTH_BYTES: "1000000",
        // Agents re-issue near-identical queries while reasoning; serve those
        // from memory instead of re-querying every engine.
        SEARCH_CACHE_TTL_MS: "300000",
      },
    },
}