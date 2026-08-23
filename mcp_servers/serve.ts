// Standalone runner: `npm run app-mcp`.
//
// Not `mcp-use dev` — that rewrites mcp-env.d.ts to point at this entry,
// silently breaking types for the example server in examples/fruit-server.

import server from "./index.js";

const port = Number(process.env.APP_MCP_PORT ?? 8000);
const { port: bound } = await server.listen(port);

console.log(`Application MCP Server on http://localhost:${bound}/mcp`);
