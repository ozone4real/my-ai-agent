// Interactive REPL with the app pre-loaded — a Rails-console for this project.
//
//   npm run console
//
// Models, jobs, services and the Agent are all in scope under their export
// names, `*Model` exports aliased to the bare noun. Top-level await works, so
// everything reads the way it does in application code:
//
//   await Task.find().limit(5)
//   await TaskRun.countDocuments({ status: "failed" })
//   await Conversation.findById(id).populate("messages")
//   await new AgenticJob().enqueue({ taskId: task._id })
//   await new Agent().run("what's the weather in Lagos?")
//
// .ls lists everything loaded, .models lists the mongoose registrations, and
// .reload re-imports the source files after an edit. .exit (or Ctrl-D) closes
// the connection cleanly.

import repl from "node:repl";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { inspect } from "node:util";
import mongoose from "mongoose";

// Load .env before anything reads MONGODB_URI or an API key. Non-fatal: the
// connection falls back to the local default.
const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { connectDB, disconnectDB } = await import("./db");

// Directories loaded wholesale, plus the single files worth pulling in. Adding
// a model/job/service file is enough for it to show up here — no edit needed.
const SOURCE_DIRS = ["models", "jobs", "services"] as const;
const SOURCE_FILES = ["agents/index.ts"] as const;

type Loaded = Record<string, Record<string, unknown>>;

/**
 * Every runtime export whose name starts with a capital — classes, mongoose
 * models, enums, const tuples. Lowercase exports are helpers the REPL doesn't
 * need, and types have already vanished by the time this runs.
 *
 * A default export binds under its class/function name (`AgenticJob`,
 * `SSEStream`), since that's what the file calls it internally.
 */
function exportsOf(module: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(module)) {
    if (name === "default") {
      const inferred = typeof value === "function" ? value.name : "";
      if (inferred) out[inferred] = value;
      continue;
    }
    if (!/^[A-Z]/.test(name)) continue;

    // TaskModel -> Task, so queries read like the domain rather than the file.
    const alias = name.endsWith("Model") ? name.slice(0, -"Model".length) : name;
    out[alias || name] = value;
  }

  return out;
}

/**
 * Import the app's source files and group their exports by directory for the
 * banner. A cache-busting query string makes .reload pick up edits on disk.
 */
async function loadSources(): Promise<Loaded> {
  const v = `?v=${Date.now()}`;
  const loaded: Loaded = {};

  // One unimportable file (a missing dependency, a syntax error mid-edit)
  // shouldn't cost you the whole console — warn and keep the rest.
  const into = async (group: Record<string, unknown>, specifier: string) => {
    try {
      Object.assign(group, exportsOf(await import(specifier)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`  ! skipped ${specifier.split("?")[0]}: ${reason.split("\n")[0]}`);
    }
  };

  for (const dir of SOURCE_DIRS) {
    const files = (await readdir(path.join(import.meta.dirname, dir)))
      .filter((file) => file.endsWith(".ts"))
      .sort();

    const group: Record<string, unknown> = {};
    for (const file of files) await into(group, `./${dir}/${file}${v}`);
    loaded[dir] = group;
  }

  const root: Record<string, unknown> = {};
  for (const file of SOURCE_FILES) await into(root, `./${file}${v}`);
  loaded["server"] = root;

  return loaded;
}

await connectDB();
const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/my-mcp-server";
console.log(`Connected to ${mongoose.connection.name} (${uri})`);

let loaded = await loadSources();

function printLoaded(groups: Loaded) {
  for (const [group, values] of Object.entries(groups)) {
    const names = Object.keys(values).sort();
    if (names.length) console.log(`  ${group.padEnd(9)} ${names.join(", ")}`);
  }
}

printLoaded(loaded);
console.log("\nTop-level await is on — try `await Task.find().limit(5)`\n");

const server = repl.start({
  prompt: `${mongoose.connection.name}> `,
  // Documents print with too much mongoose internals at default depth.
  writer: (output) => inspect(output, { colors: true, depth: 4, maxArrayLength: 50 }),
});

function defineGlobals(defs: Record<string, unknown>) {
  for (const [name, value] of Object.entries(defs)) {
    Object.defineProperty(server.context, name, {
      configurable: true,
      enumerable: true,
      value,
    });
  }
}

function bindAll(groups: Loaded) {
  for (const values of Object.values(groups)) defineGlobals(values);
}

bindAll(loaded);
// `db` is the raw driver handle, for the odd thing mongoose won't do:
//   await db.collection("tasks").stats()
defineGlobals({ mongoose, db: mongoose.connection.db });

// Persist history across sessions, like a shell.
server.setupHistory(path.resolve(process.cwd(), ".console_history"), () => {});

server.defineCommand("ls", {
  help: "List everything loaded into the console, grouped by source directory",
  action() {
    printLoaded(loaded);
    this.displayPrompt();
  },
});

server.defineCommand("models", {
  help: "List the models registered with mongoose and their collections",
  action() {
    for (const name of Object.keys(mongoose.models).sort()) {
      console.log(`  ${name} → ${mongoose.models[name].collection.name}`);
    }
    this.displayPrompt();
  },
});

server.defineCommand("reload", {
  help: "Re-import models, jobs, services and the agent to pick up edits on disk",
  action() {
    loadSources()
      .then((fresh) => {
        loaded = fresh;
        bindAll(loaded);
        console.log("Reloaded:");
        printLoaded(loaded);
      })
      .catch((err) => console.error(err))
      .finally(() => this.displayPrompt());
  },
});

server.on("exit", async () => {
  await disconnectDB();
  process.exit(0);
});
