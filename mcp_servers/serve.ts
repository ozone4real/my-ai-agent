// Standalone runner for the Application MCP Server.
//
//   npm run app-mcp
//
// Deliberately NOT `mcp-use dev`. That CLI exists to bundle views, run the
// inspector, and regenerate types — and this server has no views. Worse, any
// `mcp-use dev --entry/--mcp-dir mcp_servers` run **rewrites the root
// `mcp-env.d.ts`** to point the React `Register` at this entry, which silently
// breaks typing for the fruit view in views/. Booting the server ourselves
// keeps that file alone.
//
// index.ts still default-exports the server, so it stays usable with the CLI if
// you ever add views to it.

import server from "./index.js";

const port = Number(process.env.APP_MCP_PORT ?? 8000);
const { port: bound } = await server.listen(port);

console.log(`Application MCP Server on http://localhost:${bound}/mcp`);
