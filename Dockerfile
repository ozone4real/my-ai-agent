# One image for every Node service — server, worker and app MCP server run the
# same build, just a different entrypoint.
#
# Pinned to .nvmrc; mcp-use requires >= 22.22.2.
FROM node:23.11.1-bookworm-slim AS base

# The agent spawns MCP servers as child processes with `npx`. Installing them
# here means a cold start doesn't shell out to the registry.
#
# chrome-devtools-mcp pulls puppeteer, whose postinstall downloads ~200MB of
# Chromium. We talk to a separate Chrome container over CDP, so skip it.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# tsx is not installed in the runtime stage; the shell-executor MCP server calls
# out to git/curl, so those stay.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# ---------------------------------------------------------------------------
# Build — dev dependencies, typechecked, bundled. None of this ships.
# ---------------------------------------------------------------------------
FROM base AS build
RUN npm ci --ignore-scripts
COPY . .

# Fail the build on a type error. Neither esbuild nor vite typechecks, so
# without this a broken type ships silently.
RUN npx tsc --noEmit -p host/tsconfig.json \
 && npx tsc --noEmit -p tsconfig.node.json \
 && npx tsc --noEmit -p tsconfig.json

RUN npx vite build host
RUN node build.mjs

# ---------------------------------------------------------------------------
# Runtime — production dependencies and the built output only.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# No tsx, no esbuild, no vite in the final image.
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY --from=build /app/host/dist ./host/dist

# Read at runtime by servers_definition and the SPA handler.
ENV UI_DIST_DIR=/app/host/dist \
    COMMAND_EXECUTOR_ENTRY=/app/dist/command-executor.js

# The filesystem MCP server's sandbox. Compose mounts over it.
RUN mkdir -p /workspace

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Overridden per service in docker-compose.yml.
CMD ["node", "dist/server.js"]
