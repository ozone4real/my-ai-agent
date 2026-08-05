import { execFile } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";


const exec = promisify(execFile);
const ALLOWED = new Set(["ls", "ruby", "cat", "git", "npm", "node", "curl", "*"]);

const server = new McpServer({
  name: "Shell Command Executor",
  title: "shell-command-executor",
  description: "Execute shell commands",
  version: "1.0"
})

server.registerTool(
  "shell-command-executor",
  {
    title: "Shell Command Executor",
    description: "Execute shell commands",
    inputSchema: z.object({
      cmd: z.string().describe("The command to execute"),
      args: z.array(z.string()).describe("The command's arguments").default([])
    }),
  },
  async ({ cmd, args }) => {
    if (!ALLOWED.has(cmd) && !(ALLOWED.has("*"))) {
      return {
        isError: true,
        content: [{ type: "text", text: `Command "${cmd}" not allowed.` }],
      };
    }
    try {
      const { stdout, stderr } = await exec(cmd, args, {
        cwd: process.env.AGENT_CWD ?? process.cwd(),
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      return { content: [{ type: "text", text: stdout || stderr || "(no output)" }] };
    } catch (e: any) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
)

server.connect(new StdioServerTransport())

