# MCP Agent Platform (built for personal use)

A self-hosted platform for running AI agents: chat with one, schedule it to work
unattended, and give it real tools through MCP — a headful browser, a shell, a
sandboxed filesystem, local web search, and email.

The agent loop itself is [mcp-use](https://mcp-use.com)'s. What's here is
everything around it — the tool surface, context management, scheduling,
persistence, and the UI to watch it work.

- **Chat** with the agent and watch it work — reasoning, tool calls and the
  reply stream in as they happen.
- **Schedule tasks** it runs unattended on a cron schedule, each with its own
  run history and transcript.
- **Answer it mid-run.** When a task needs something only you know — a salary
  figure, a login code — it asks, and the run continues once you reply.

The pieces: an Express API and React UI in [`host/`](host/), a BullMQ worker for
scheduled runs, MongoDB and Redis for state, and the agent's own MCP server in
[`mcp_servers/`](mcp_servers/) exposing its tasks as tools.

## Getting Started

Docker is the shortest path — it brings up the databases, the browser and search
alongside the app:

```bash
cp .env.sample .env      # fill in AGENT_FILESYSTEM_ROOT and one model API key
docker compose up -d --build
```

The UI is on [http://localhost:8080](http://localhost:8080), behind HTTP Basic
auth using `LOGIN_USER` / `LOGIN_PASSWORD` from your `.env`.

To run it natively instead, you need MongoDB and Redis reachable, then:

```bash
npm install
npm run app-mcp      # the agent's own MCP server, on :8000
npm run web:server   # API + UI, on :8080
npm run workers      # runs scheduled tasks (`worker` is the same, without watch)
```

`npm run typecheck` covers all three TypeScript projects — nothing else does,
since neither esbuild nor Vite typechecks.

### Choosing a model

Settings in the UI picks the model every new agent uses. The catalogue lives in
[`host/server/agents/models.ts`](host/server/agents/models.ts): Claude and
DeepSeek directly, plus Gemini, GPT, Grok, Llama and a few no-cost models
through OpenRouter. Each needs its provider's key in `.env`; adding another is
three lines.

## Running with Docker

```bash
docker compose up -d --build          # everything, UI on http://localhost:8080
docker compose logs -f server worker  # follow the app
docker compose down                   # stop (data survives in volumes)
```

For development, add the overlay — Vite on :5173 with hot reload, and `tsx watch`
on the Node services with the source bind-mounted:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Services: `mongo` (single-node replica set, so transactions work), `redis`,
`searxng`, `chrome` (headless, for the browser tools), `app-mcp`, `server`,
`worker` — plus `web` in dev. `.env` supplies `DEEP_SEEK_API_KEY` and friends.

Two things worth knowing:

- **`TZ` matters.** Cron schedules fire in container time. It defaults to
  `Europe/London` in compose; set `TZ` in `.env` to match where you actually are,
  or a `0 9 * * 1` task will run at the wrong hour.
- **The agent's sandbox is `./workspace`.** That's what the filesystem MCP server
  can read and write, and what the shell tool sees — not your home directory.

## Deploying to a remote server

[`config/deploy.yml`](config/deploy.yml) deploys the whole stack with
[Kamal](https://kamal-deploy.org) — the app image plus Redis, SearXNG and Chrome
as accessories, with Let's Encrypt in front:

```bash
kamal setup     # first time
kamal deploy    # thereafter
```

The compose file publishes only the app port; Mongo, Redis, SearXNG and Chrome
are reachable on the internal network and nothing else. Before putting it on a
public host:

- **Set `LOGIN_USER` and `LOGIN_PASSWORD`.** They gate the whole API and UI with
  HTTP Basic auth, and the server refuses to start in production without them —
  the agent behind it can run shell commands, so an open port is not an option.
  Terminate TLS too: Basic auth over plain HTTP sends the password in the clear.
- **The agent can run shell commands and read files** inside its container. That
  is `/workspace` plus the application source. Treat the container as something
  the model can act inside, and don't mount anything you wouldn't hand it.
- **Chrome's VNC is unauthenticated.** It is published on `127.0.0.1` only and
  off unless `CHROME_ENABLE_VNC=true`. Reach it over an SSH tunnel, never by
  opening the port.
- **Set `TZ`** to the server's intended timezone or cron schedules shift.
- **Secrets** come from `.env`, which is read at container start — keep it off
  the image (it is in `.dockerignore`) and out of version control.
- **Back up the `mongo-data` volume.** It holds every conversation, task and run.

## Browser automation

`chrome` runs **headful** Chromium on an Xvfb virtual display rather than
`--headless=new`. A headful browser has real WebGL renderer strings, a real font
list and real screen metrics; a headless one with a spoofed User-Agent has none
of those, and sites that fingerprint browsers can tell.

The profile persists in the `chrome-profile` volume, so a session established
once is not thrown away on the next deploy.

To watch what it is doing on a headless server:

```bash
CHROME_ENABLE_VNC=true docker compose up -d chrome
ssh -L 5900:127.0.0.1:5900 you@server     # then connect a VNC client to :5900
```

Note that some sites deliberately block automated browsers regardless of how the
browser is configured. A task that stops and notifies you when it hits a
challenge is more durable than one that tries to get through it unattended.

## Web search (local, no API keys)

The agent in `host/server/agents/index.ts` gets web search from a **self-hosted
[SearXNG](https://github.com/searxng/searxng)** (AGPL-3.0) instance via
[`mcp-searxng`](https://github.com/ihor-sokoliuk/mcp-searxng) (MIT). Nothing is
sent to a paid search API and there is no key to manage — SearXNG runs in Docker
on your machine and queries upstream engines directly.

It is a service in the main compose file, published on `127.0.0.1:8888` so a
natively-run app can use it too. To run it on its own:

```bash
npm run search:up      # docker compose up -d searxng
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
(~2,400 → ~480 tokens). Raise them in `agents/index.ts` if answers start coming back
truncated.

If the container isn't running, the agent still starts — searches just fail,
and its other tools are unaffected.

## Examples

[`examples/fruit-server/`](examples/fruit-server/) holds the demo MCP server
that `create-mcp-use-app` scaffolds — a tool bound to a React view, showing how
an MCP App renders UI in a host like ChatGPT. Nothing the agent runs depends on
it; it is kept as a reference for building views.

```bash
npm run example:dev    # serves it with the mcp-use inspector
```

It has to run from its own directory: the mcp-use CLI rewrites `mcp-env.d.ts`
next to the entry it finds, and pointing that at the agent's server would break
the view's typing.
