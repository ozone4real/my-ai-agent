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

The compose file publishes only the app port; Mongo, Redis, SearXNG and Chrome
are reachable on the internal network and nothing else. Before putting it on a
public host:

- **Put TLS in front of it.** `server` speaks plain HTTP and there is no
  authentication on the API — anyone who can reach the port can read and delete
  every conversation and task. Terminate TLS and add auth at a reverse proxy,
  or bind it to localhost and reach it over a tunnel.
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

In Docker it is just another service and needs no separate command. To run it
on its own for local (non-Docker) development:

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
(~2,400 → ~480 tokens). Raise them in `agents/index.ts` if answers start coming back
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
