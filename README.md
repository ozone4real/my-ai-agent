# MCP fullstack AI Agent

This is an MCP app project bootstrapped with [`create-mcp-use-app`](https://mcp-use.com/docs/typescript/getting-started/quickstart).

## Getting Started

First, run the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000/inspector](http://localhost:3000/inspector) with your browser to test your server.

You can start building by editing the entry file. Add tools, resources, and prompts — the server auto-reloads as you edit.

## Web search (local, no API keys)

The agent in `host/server/agent.ts` gets web search from a **self-hosted
[SearXNG](https://github.com/searxng/searxng)** (AGPL-3.0) instance via
[`mcp-searxng`](https://github.com/ihor-sokoliuk/mcp-searxng) (MIT). Nothing is
sent to a paid search API and there is no key to manage — SearXNG runs in Docker
on your machine and queries upstream engines directly.

```bash
npm run search:up      # start SearXNG on http://localhost:8888
npm run search:down    # stop it
npm run search:logs    # tail logs
```

Config lives in [`searxng/`](searxng/). Two things worth knowing if you edit it:

- `search.formats` **must** include `json` — it isn't in SearXNG's defaults, and
  `mcp-searxng` gets HTML back and returns nothing without it.
- Port is 8888, not SearXNG's usual 8080, which the host agent server uses.

The agent's `websearch` entry sets operator-level caps (`SEARXNG_MAX_RESULTS`,
`SEARXNG_MAX_RESULT_CHARS`, `URL_READ_MAX_CHARS`, `SEARXNG_LITE_TOOLS`) that
`mcp-searxng` clamps the model's requests down to. Measured against the
uncapped defaults, they cut tool schemas from ~6.4k to ~1.2k chars (paid on
every model call) and a single search result from ~9.7k to ~1.9k chars
(~2,400 → ~480 tokens). Raise them in `agent.ts` if answers start coming back
truncated.

If the container isn't running, the agent still starts — searches just fail,
and its other tools are unaffected.

## Learn More

To learn more about mcp-use and MCP:

- [mcp-use Documentation](https://mcp-use.com/docs/typescript/getting-started/quickstart) — guides, API reference, and tutorials

## Deploy on Manufact Cloud

```bash
npm run deploy
```
