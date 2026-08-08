import { execFile } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";


const exec = promisify(execFile);

/**
 * Commands refused outright. Everything else runs.
 *
 * This is a guardrail against mistakes, not a security boundary — a determined
 * caller gets past a pattern list trivially (`/bin/rm`, `r""m`, base64, a
 * variable holding the word). The real containment is the sandbox the process
 * runs in. What this buys is that a plausible-looking wrong command fails
 * loudly instead of destroying something.
 *
 * Each entry says why, and the reason goes back to the caller so a model can
 * choose a different approach rather than retrying variations.
 */
const BLOCKED: { pattern: RegExp; why: string }[] = [
  // Deleting the world. Ordinary `rm -rf ./build` stays allowed on purpose —
  // the agent is told to clean up after itself.
  {
    pattern: /\brm\b[^|;&]*\s-[a-z]*[rR][a-z]*\b[^|;&]*\s(\/|~|\$HOME|\/\*)(\s|$)/,
    why: "recursive delete of a root, home or system path",
  },
  { pattern: /\brm\b[^|;&]*\s(\/etc|\/usr|\/var|\/bin|\/sbin|\/System|\/Library)\b/, why: "deleting a system directory" },

  // Privilege escalation — nothing here should need it.
  { pattern: /(^|[|;&\s])(sudo|doas|su)\s/, why: "privilege escalation" },

  // Disks and machine state.
  { pattern: /\b(mkfs|fdisk|parted)\b/, why: "formatting or partitioning a disk" },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\//, why: "writing directly to a device" },
  { pattern: /\bdiskutil\s+(erase|partition|reformat)/, why: "erasing a disk" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, why: "shutting down the machine" },

  // Remote code execution: fetch and pipe straight into a shell.
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?)\b/, why: "piping a download into a shell" },

  // Fork bomb.
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}/, why: "fork bomb" },

  // Killing everything, including this process.
  { pattern: /\bkill\s+-9\s+-1\b|\bkillall\s+-9\b/, why: "killing every process" },

  // Permissions on system paths.
  { pattern: /\b(chmod|chown)\b[^|;&]*\s-[a-zA-Z]*R[a-zA-Z]*\b[^|;&]*\s(\/|~|\/etc|\/usr|\/System)(\s|$)/, why: "recursive permission change on a system path" },

  // Credentials. Reading these is the shape of exfiltration, and the agent is
  // told to stay out of them anyway.
  { pattern: /\.ssh\/id_[a-z0-9_]+(?!\.pub)/, why: "reading a private SSH key" },
  { pattern: /\.aws\/credentials|\.config\/gcloud\/.*credential/, why: "reading cloud credentials" },

  // This app's own data stores — one command wipes every conversation and task.
  { pattern: /\bdropDatabase\s*\(|\bdb\.dropDatabase\b/, why: "dropping the database" },
  { pattern: /\bredis-cli\b[^|;&]*\b(flushall|flushdb)\b/i, why: "flushing Redis" },
  { pattern: /\bmongosh?\b[^|;&]*--eval[^|;&]*\bdrop\b/i, why: "dropping a Mongo collection" },

  // Irreversible git and publishing.
  { pattern: /\bgit\b[^|;&]*\s(reset\s+--hard|clean\s+-[a-z]*f)/, why: "discarding uncommitted work" },
  { pattern: /\bgit\s+push\b[^|;&]*\s(--force|-f)(\s|$)/, why: "force push" },
  { pattern: /\b(npm|yarn|pnpm)\s+publish\b/, why: "publishing a package" },

  // Docker: removing the stack's data.
  { pattern: /\bdocker\b[^|;&]*\b(system\s+prune|volume\s+rm|volume\s+prune)\b/, why: "removing Docker volumes or pruning the system" },
];

/** The first rule the command trips, if any. */
function blockedBy(command: string): string | undefined {
  return BLOCKED.find(({ pattern }) => pattern.test(command))?.why;
}

const server = new McpServer({
  name: "Shell Command Executor",
  title: "shell-command-executor",
  description: "Execute shell commands",
  version: "1.0"
})

/** Anything a shell would interpret rather than treat as a literal argument. */
const SHELL_SYNTAX = /[|&;<>()$`\\"'*?\[\]{}~\n]/

server.registerTool(
  "shell-command-executor",
  {
    title: "Shell Command Executor",
    description:
      "Run a command and return its combined output. Accepts either a whole " +
      "command line in `cmd` (run through sh, so pipes and redirects work), or " +
      "an executable in `cmd` with its arguments in `args`. Most commands are " +
      "allowed; a small set of destructive ones is refused.",
    inputSchema: z.object({
      cmd: z
        .string()
        .describe(
          "Either a full command line — 'ls -la /app', 'grep -r foo . | head' — " +
            "or just the executable, with its arguments in `args`."
        ),
      args: z
        .array(z.string())
        .describe(
          "Arguments, when `cmd` is only the executable. Leave empty if `cmd` " +
            "already contains the whole command line."
        )
        .default([]),
    }),
  },
  async ({ cmd, args }) => {
    const trimmed = cmd.trim()

    // `execFile` runs no shell, so a `cmd` of "ls -la" looks for an executable
    // literally named "ls -la" and fails with a bare `spawn ls -la ENOENT` —
    // which reads like the shell is missing rather than like a usage mistake.
    // A whole command line with no separate args is the obvious intent, so run
    // it the way it was clearly meant.
    const asCommandLine =
      args.length === 0 && (/\s/.test(trimmed) || SHELL_SYNTAX.test(trimmed))

    const [file, argv] = asCommandLine
      ? ["sh", ["-c", trimmed]]
      : [trimmed, args]

    // Checked against the whole command line, not the executable: a command
    // line runs through `sh`, so `file` is just "sh" and tells us nothing.
    const refused = blockedBy([trimmed, ...args].join(" "))
    if (refused) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Refused (${refused}): ${trimmed}\n` +
              `Blocked by policy. Find another way, or ask the user to run it themselves.`,
          },
        ],
      };
    }

    try {
      const { stdout, stderr } = await exec(file, argv, {
        cwd: process.env.AGENT_CWD ?? process.cwd(),
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      return { content: [{ type: "text", text: stdout || stderr || "(no output)" }] };
    } catch (e: any) {
      // A non-zero exit still carries the output the caller wants to read.
      const detail = [e.stdout, e.stderr].filter(Boolean).join("").trim()
      const reason =
        e.code === "ENOENT"
          ? `Command not found: ${file}`
          : e.killed
          ? `Timed out after 15s: ${trimmed}`
          : e.message

      return {
        isError: true,
        content: [{ type: "text", text: detail ? `${reason}\n${detail}` : reason }],
      };
    }
  }
)

server.connect(new StdioServerTransport())

