// The MCP servers the agent connects to. Hosts and paths are env-driven so the
// same definition works natively and in a container.

/**
 * Where the filesystem server may read and write.
 *
 * No default on purpose: a fallback would silently expose a whole home
 * directory wherever this wasn't set. Throwing here also beats the failure it
 * prevents — a bad path kills the filesystem server, and one dead connector
 * aborts every agent run with an error that never names this variable.
 */
const FILESYSTEM_ROOT = process.env.AGENT_FILESYSTEM_ROOT;
if (!FILESYSTEM_ROOT) {
  throw new Error(
    "AGENT_FILESYSTEM_ROOT is not set. Point it at the directory the agent may " +
      "read and write, e.g. AGENT_FILESYSTEM_ROOT=/Users/you/agent-workspace"
  );
}

/** A Chrome already listening for DevTools connections. */
const CHROME_URL = process.env.CHROME_URL ?? "http://127.0.0.1:9222";

export default {
  // This project's own server (tasks + run history), started by `npm run app-mcp`.
  // A `url` because mcp-use v2 has no stdio transport — it must already be up.
  app: {
    url: process.env.APP_MCP_URL ?? "http://localhost:8000/mcp",
  },
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", FILESYSTEM_ROOT],
  },
  shellCommandExecutor: {
    command: "npx",
    args: ["tsx", "mcp_servers/command_executor.ts"]
  },
  chromedevtools: {
    command: "npx",
    args: [
      "-y",
      "chrome-devtools-mcp@latest",
      `--browser-url=${CHROME_URL}`,
      "--ignoreDefaultChromeArg=--enable-automation",
    ],
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
  // Local SearXNG (`npm run search:up`). If it's down, searches fail but the
  // agent's other tools are unaffected.
  websearch: {
    command: "npx",
    args: ["-y", "mcp-searxng"],
    // Operator caps, not defaults — mcp-searxng clamps the model's requests.
    env: {
      SEARXNG_URL: process.env.SEARXNG_URL ?? "http://localhost:8888",
      // title + url + snippet; JSON adds engine metadata the model can't use.
      SEARXNG_DEFAULT_RESPONSE_FORMAT: "text",
      // Smaller tool schemas — re-sent every model call, so this saves per-turn.
      SEARXNG_LITE_TOOLS: "true",
      // ~37 hits across engines; the tail is near-duplicates.
      SEARXNG_MAX_RESULTS: "5",
      SEARXNG_MAX_RESULT_CHARS: "4000",
      // Dominates the bill: one uncapped page read outweighs every search.
      URL_READ_MAX_CHARS: "8000",
      // Don't download 50MB to extract 8k of text.
      URL_READ_MAX_CONTENT_LENGTH_BYTES: "1000000",
      // Agents re-issue near-identical queries while reasoning.
      SEARCH_CACHE_TTL_MS: "300000",
    },
  },
}
