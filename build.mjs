// Production build: one bundle per entrypoint, so nothing transpiles at runtime.
//
// `packages: "external"` keeps node_modules out of the bundles — mongoose,
// bullmq and the langchain packages all do dynamic requires and ship native
// bits that don't survive bundling. The win here is dropping tsx from the
// runtime, not shipping a single file.

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = "dist";

const ENTRIES = {
  server: "host/server/index.ts",
  worker: "host/server/workers/index.ts",
  "app-mcp": "mcp_servers/serve.ts",
  // Spawned as a child process by the agent's shell tool, so it needs to exist
  // as a runnable file of its own.
  "command-executor": "mcp_servers/command_executor.ts",
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await build({
  entryPoints: Object.entries(ENTRIES).map(([out, input]) => ({ in: input, out })),
  outdir: OUT,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});

// Read at runtime via import.meta.dirname, which is the bundle's directory.
await cp("host/server/agents/instructions.md", `${OUT}/instructions.md`);

console.log(`Built ${Object.keys(ENTRIES).length} entrypoints into ${OUT}/`);
