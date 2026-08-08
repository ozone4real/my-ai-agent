# One image for every Node service in the stack — express server, worker and
# app MCP server all run the same source, just a different entrypoint.
#
# Pinned to the project's .nvmrc; mcp-use requires >= 22.22.2.
FROM node:23.11.1-bookworm-slim AS base

# The agent spawns MCP servers as child processes with `npx`. Installing them
# here means a cold start doesn't shell out to the registry — and they still
# resolve, because npx prefers node_modules/.bin over downloading.
#
# chrome-devtools-mcp pulls puppeteer, whose postinstall downloads ~200MB of
# Chromium. We talk to a separate Chrome container over CDP, so skip it.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# `tsx` is how every entrypoint runs, and the shell-executor MCP server calls
# out to git/curl, so keep those available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# `npm ci` needs the lockfile to match; postinstall runs the mcp-use CLI which
# isn't needed in an image, so skip lifecycle scripts.
RUN npm ci --ignore-scripts

COPY . .

# ---------------------------------------------------------------------------
# Frontend build — only needed by the express service, but cheap to always do.
# ---------------------------------------------------------------------------
FROM base AS build
RUN npx vite build host

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
COPY --from=build /app/host/dist ./host/dist

# The filesystem MCP server's sandbox. Compose mounts over it.
RUN mkdir -p /workspace

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Overridden per service in docker-compose.yml.
CMD ["npx", "tsx", "host/server/index.ts"]
