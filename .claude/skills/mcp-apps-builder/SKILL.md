---
name: mcp-apps-builder
description: |
  **MANDATORY for ALL MCP server work** - mcp-use framework best practices and patterns.

  **READ THIS FIRST** before any MCP server work, including:
  - Creating new MCP servers
  - Modifying existing MCP servers (adding/updating tools, resources, prompts, widgets)
  - Debugging MCP server issues or errors
  - Reviewing MCP server code for quality, security, or performance
  - Answering questions about MCP development or mcp-use patterns
  - Making ANY changes to server.tool(), server.resource(), server.prompt(), or widgets

  This skill contains critical architecture decisions, security patterns, and common pitfalls.
  Always consult the relevant reference files BEFORE implementing MCP features.
---

# IMPORTANT: How to Use This Skill

This file provides a NAVIGATION GUIDE ONLY. Before implementing any MCP server features, you MUST:

1. Read this overview to understand which reference files are relevant
2. **ALWAYS read the specific reference file(s)** for the features you're implementing
3. Apply the detailed patterns from those files to your implementation

**Do NOT rely solely on the quick reference examples in this file** - they are minimal examples only. The reference files contain critical best practices, security considerations, and advanced patterns.

---

# MCP Server Best Practices

Comprehensive guide for building production-ready MCP servers with tools, resources, prompts, and widgets using mcp-use.

## ⚠️ FIRST: New Project or Existing Project?

**Before doing anything else, determine whether you are inside an existing mcp-use project.**

**Detection:** Check the workspace for a `package.json` that lists `"mcp-use"` as a dependency, OR any `.ts` file that imports from `"mcp-use"`.

> **Version:** these docs target **mcp-use v2** (verified against 2.0.4). v2 split the
> package and renamed the UI layer. When reading code written for v1, expect:
>
> | v1 | v2 |
> |---|---|
> | `from "mcp-use/server"` | `from "mcp-use"` — the `./server` subpath was **deleted** |
> | `MCPAgent` / `MCPClient` from `mcp-use` | `@mcp-use/agent` (+ `/langchain`) / `@mcp-use/client` |
> | `baseUrl` in `MCPServer({...})` | removed; the CLI reads `MCP_URL` from the env |
> | `server.listen()` in the entry file | `export default server` — the CLI mounts and listens |
> | `server.uiResource()` | removed; bind a view via the tool's `view:` config |
> | tool `widget: { name, invoking, invoked }` | tool `view: { name, description, csp, … }` — no `invoking`/`invoked` |
> | `resources/<name>/widget.tsx` | `views/<name>/view.tsx` |
> | `widgetMetadata` export | `viewConfig` export (only `autoResize` / `displayModes`) |
> | `useWidget()` | `useToolContext()` + `useViewState()` + `useDisplayMode()` + `useHostContext()` + `useSendFollowUp()` |
> | `McpUseProvider` | `ThemeProvider` (+ `ViewControls`, `ErrorBoundary`) |
> | `useWidgetTheme()` | `useViewTheme()` |
>
> Throughout these docs "widget" and "view" mean the same thing; v2 calls it a **view**.

```
├─ mcp-use project FOUND → Do NOT scaffold. You are already in a project.
│  └─ Skip to "Quick Navigation" below to add features.
│
├─ NO mcp-use project (empty dir, unrelated project, or greenfield)
│  └─ Scaffold first with npx create-mcp-use-app, then add features.
│     See "Scaffolding a New Project" below.
│
└─ Inside an UNRELATED project (e.g. Next.js app) and user wants an MCP server
   └─ Ask the user where to create it, then scaffold in that directory.
      Do NOT scaffold inside an existing unrelated project root.
```

**NEVER manually create `MCPServer` boilerplate, `package.json`, or project structure by hand.** The CLI sets up TypeScript config, dev scripts, inspector integration, hot reload, and widget compilation that are difficult to replicate manually.

---

### Scaffolding a New Project

```bash
npx create-mcp-use-app my-server
cd my-server
npm run dev
```

For full scaffolding details and CLI flags, see **[quickstart.md](references/foundations/quickstart.md)**.

---

## Quick Navigation

**Choose your path based on what you're building:**

### 🚀 Foundations
**When:** ALWAYS read these first when starting MCP work in a new conversation. Reference later for architecture/concept clarification.

1. **[concepts.md](references/foundations/concepts.md)** - MCP primitives (Tool, Resource, Prompt, Widget) and when to use each
2. **[architecture.md](references/foundations/architecture.md)** - Server structure (Hono-based), middleware system, server.use() vs server.app
3. **[quickstart.md](references/foundations/quickstart.md)** - Scaffolding, setup, and first tool example
4. **[deployment.md](references/foundations/deployment.md)** - Deploying to Manufact Cloud, self-hosting, Docker, managing deployments

Load these before diving into tools/resources/widgets sections.

---

### 🔐 Adding Authentication?
**When:** Protecting your server with OAuth (Auth0, Better Auth, Clerk, WorkOS, Supabase, Keycloak, or any other provider)

- **[overview.md](references/authentication/overview.md)**
  - When: First time adding auth, understanding `ctx.auth`, or choosing a provider / integration mode
  - Covers: Remote auth vs OAuth proxy, `oauth` config, `ctx.auth` shape, provider comparison, common mistakes

- **[auth0.md](references/authentication/auth0.md)**
  - When: Using Auth0 — DCR (Early Access) or a standard Regular Web App via `oauthProxy`
  - Covers: Setup for both modes, `extraAuthorizeParams.audience`, permissions via `rfc9068_profile_authz`

- **[better-auth.md](references/authentication/better-auth.md)**
  - When: Using Better Auth with the `@better-auth/oauth-provider` plugin (self-hosted OAuth 2.1)
  - Covers: `oauthBetterAuthProvider`, auth URL / metadata routes, login and consent flows

- **[clerk.md](references/authentication/clerk.md)**
  - When: Using Clerk (DCR-based OAuth)
  - Covers: `oauthClerkProvider`, enabling DCR, Frontend API URL, organization context

- **[workos.md](references/authentication/workos.md)**
  - When: Using WorkOS AuthKit (DCR only)
  - Covers: Setup, env vars, roles/permissions, multi-tenant org filtering, WorkOS API calls

- **[supabase.md](references/authentication/supabase.md)**
  - When: Using Supabase's OAuth 2.1 server
  - Covers: Setup, publishable keys, ES256 vs HS256, hosting the consent UI, RLS-aware SDK calls

- **[keycloak.md](references/authentication/keycloak.md)**
  - When: Using Keycloak via native DCR
  - Covers: DCR trusted hosts + web origins, audience enforcement, realm vs resource roles, userinfo

- **[custom.md](references/authentication/custom.md)**
  - When: Any other provider — DCR-capable via `oauthCustomProvider`, or pre-registered (Google, GitHub, Okta, Azure AD) via `oauthProxy`
  - Covers: `oauthCustomProvider`, `oauthProxy` + `jwksVerifier`, provider examples, opaque-token verification

---

### 🔧 Building Server Backend (No UI)?
**When:** Implementing MCP features (actions, data, templates). Read the specific file for the primitive you're building.

- **[tools.md](references/server/tools.md)**
  - When: Creating backend actions the AI can call (send-email, fetch-data, create-user)
  - Covers: Tool definition, schemas, annotations, context, error handling

- **[resources.md](references/server/resources.md)**
  - When: Exposing read-only data clients can fetch (config, user profiles, documentation)
  - Covers: Static resources, dynamic resources, parameterized resource templates, URI completion

- **[prompts.md](references/server/prompts.md)**
  - When: Creating reusable message templates for AI interactions (code-review, summarize)
  - Covers: Prompt definition, parameterization, argument completion, prompt best practices

- **[response-helpers.md](references/server/response-helpers.md)**
  - When: Formatting responses from tools/resources (text, JSON, markdown, images, errors)
  - Covers: `text()`, `object()`, `markdown()`, `image()`, `error()`, `mix()`

- **[proxy.md](references/server/proxy.md)**
  - When: Composing multiple MCP servers into one unified aggregator server
  - Covers: `server.proxy()`, config API, explicit sessions, sampling routing

- **[architecture.md](references/foundations/architecture.md)**
  - When: Adding cross-cutting logic (logging, auth checks, rate limiting, tool filtering) that spans multiple tools/resources
  - Covers: `server.use('mcp:...')` middleware, `MiddlewareContext` (method, params, auth, state), pattern matching, HTTP vs MCP middleware

---

### 🎨 Building Visual Widgets (Interactive UI)?
**When:** Creating React-based visual interfaces for browsing, comparing, or selecting data

- **[basics.md](references/widgets/basics.md)**
  - When: Creating your first widget or adding UI to an existing tool
  - Covers: Widget setup, `useToolContext()` hook, `isPending` checks, props handling

- **[state.md](references/widgets/state.md)**
  - When: Managing UI state (selections, filters, tabs) within widgets
  - Covers: `useState`, `setState`, state persistence, when to use tool vs widget state

- **[interactivity.md](references/widgets/interactivity.md)**
  - When: Adding buttons, forms, or calling tools from within widgets
  - Covers: `useCallTool()`, form handling, action buttons, optimistic updates

- **[ui-guidelines.md](references/widgets/ui-guidelines.md)**
  - When: Styling widgets to support themes, responsive layouts, or accessibility
  - Covers: `useViewTheme()`, light/dark mode, `viewConfig.autoResize`, layout patterns, CSS best practices

- **[advanced.md](references/widgets/advanced.md)**
  - When: Building complex widgets with async data, error boundaries, or performance optimizations
  - Covers: Loading states, error handling, memoization, code splitting

- **[model-context.md](references/widgets/model-context.md)**
  - When: Keeping the AI model aware of what the user is currently seeing (active tab, hovered item, selected product) without requiring tool calls
  - Covers: `<ModelContext>` component, `modelContext.set/remove` imperative API, nesting, tree serialization, lifecycle rules
- **[files.md](references/widgets/files.md)**
  - When: Uploading or downloading files from within a widget (ChatGPT Apps SDK only)
  - Covers: `useFiles()` hook, `isSupported` guard, model visibility (`modelVisible`), storing `fileId`, temporary download URLs

---

### 📚 Need Complete Examples?
**When:** You want to see full implementations of common use cases

- **[common-patterns.md](references/patterns/common-patterns.md)**
  - End-to-end examples: weather app, todo list, recipe browser
  - Shows: Server code + widget code + best practices in context

---

### 🔁 Testing from the Terminal (Agent Feedback Loops)
**When:** You want to verify a tool or widget *without* the inspector UI — the canonical flow for AI agents iterating on MCP servers.

- **`mcp-use client`** — drives MCP servers from the terminal. Auto-runs OAuth on 401, persists saved servers under a short name, and one-shot subcommands exit cleanly so they're safe to spawn from harnesses.

  ```bash
  npx mcp-use client connect dev http://localhost:3000/mcp
  npx mcp-use client dev tools list
  npx mcp-use client dev tools call get-weather city=Tokyo --screenshot
  ```

  Every per-server command takes the saved name as its first positional arg (`mcp-use client <name> <scope> <action>`) — there is no "active session". Args use `key=value` (with `key:='<json>'` for nested values) or a single JSON object. When a tool renders a widget, pass `--screenshot` to also save a PNG (`./<view>-<timestamp>.png` by default, or override with `--screenshot-output <path>`).

- **`mcp-use client screenshot`** — headless render of a widget tool to a PNG. Use this when you want to visually verify a widget change without opening the inspector, especially in loops where you call a tool, screenshot, eyeball the output, and edit. Two forms:

  ```bash
  # Saved-server form — reuses the auth from `mcp-use client connect`
  npx mcp-use client dev screenshot --tool get-weather city=Tokyo \
    --width 800 --height 600 --theme light \
    --output ./weather.png

  # Ad-hoc form — connect inline (use -H for headers on authenticated servers)
  npx mcp-use client screenshot --mcp http://localhost:3000/mcp \
    --tool get-weather city=Tokyo
  ```

  Add `--device-scale-factor 2` for Retina output, or `--cdp-url <ws>` plus `--inspector <publicly-reachable-url>` to drive a remote Chromium (e.g. Notte) from a sandbox without a local Chrome install.

Both commands are documented in full at [docs/typescript/client/cli](https://docs.mcp-use.com/typescript/client/cli).

---

## Decision Tree

```
What do you need?

├─ New project from scratch
│  └─> quickstart.md (scaffolding + setup)
│
├─ OAuth / user authentication
│  └─> authentication/overview.md → provider-specific guide
│
├─ Simple backend action (no UI)
│  └─> Use Tool: server/tools.md
│
├─ Read-only data for clients
│  └─> Use Resource: server/resources.md
│
├─ Reusable prompt template
│  └─> Use Prompt: server/prompts.md
│
├─ Cross-cutting logic (logging, auth checks, rate limiting, tool filtering)
│  └─> Use Middleware: architecture.md#mcp-middleware
│
├─ Visual/interactive UI
│  └─> Use Widget: widgets/basics.md
│
├─ Keep model aware of what user is seeing in widget
│  └─> widgets/model-context.md
├─ Upload/download files in a widget
│  └─> widgets/files.md (ChatGPT Apps SDK only)
│
├─ Verify a tool or widget from the terminal (agent feedback loop)
│  └─> See "Testing from the Terminal" above — `mcp-use client` for tool runs,
│      `mcp-use client <server> screenshot --tool <tool>` for headless widget PNGs
│
└─ Deploy to production
   └─> deployment.md (cloud deploy, self-hosting, Docker)
```

---

## Core Principles

1. **Tools for actions** - Backend operations with input/output
2. **Resources for data** - Read-only data clients can fetch
3. **Prompts for templates** - Reusable message templates
4. **Widgets for UI** - Visual interfaces when helpful
5. **Mock data first** - Prototype quickly, connect APIs later

---

## ❌ Common Mistakes

Avoid these anti-patterns found in production MCP servers:

### Tool Definition
- ❌ Using the deprecated `object()`/`text()` helpers on a tool with an `outputSchema`
  - ✅ Return a raw `CallToolResult`: `{ content: [...], structuredContent: data }`
- ❌ Skipping Zod schema `.describe()` on every field
  - ✅ Add descriptions to all schema fields for better AI understanding
- ❌ No input validation or sanitization
  - ✅ Validate inputs with Zod, sanitize user-provided data
- ❌ Throwing exceptions out of a tool callback
  - ✅ Return `{ isError: true, content: [{ type: "text", text: msg }] }`

### View (Widget) Development
- ❌ Reading `view.toolOutput` without narrowing on `view.status` first
  - ✅ `if (view.status === "pending") return <Loading/>` — and handle `"error"` too
- ❌ Passing a props type to the hook: `useToolContext<Props>()`
  - ✅ Pass the *tool name*: `useToolContext<"search-products">()`
- ❌ View handles server state (filters, selections)
  - ✅ Views own their UI state with `useState` / `useViewState`
- ❌ Missing `ThemeProvider` wrapper
  - ✅ Wrap root component: `<ThemeProvider>` (auto-resize is on by default via `viewConfig`)
- ❌ Inline styles without theme awareness
  - ✅ Use `useViewTheme()` for light/dark mode support

### Security & Production
- ❌ Hardcoded API keys or secrets in code
  - ✅ Use `process.env.API_KEY`, document in `.env.example`
- ❌ No error handling in tool handlers
  - ✅ Wrap in try/catch, return `error()` on failure
- ❌ Expensive operations without caching
  - ✅ Cache API calls, computations with TTL
- ❌ Missing CORS configuration
  - ✅ Configure CORS for production deployments

---

## 🔒 Golden Rules

**Opinionated architectural guidelines:**

### 1. One Tool = One Capability
Split broad actions into focused tools:
- ❌ `manage-users` (too vague)
- ✅ `create-user`, `delete-user`, `list-users`

### 2. Return Complete Data Upfront
Tool calls are expensive. Avoid lazy-loading:
- ❌ `list-products` + `get-product-details` (2 calls)
- ✅ `list-products` returns full data including details

### 3. Widgets Own Their State
UI state lives in the widget, not in separate tools:
- ❌ `select-item` tool, `set-filter` tool
- ✅ View manages with `useState`, or `useViewState` for model-visible state

### 4. A View's Data Comes From Its Bound Tool
There is no `props:` schema on the view module any more. A view renders the
`structuredContent` of the tool it is bound to, typed by that tool's
`outputSchema`. Wiring it up correctly is three steps, all required:

```typescript
// ── index.ts ────────────────────────────────────────────────
// Step 1: EXPORT the tool ref. `mcp-env.d.ts` registers this module, and the
// typed React hooks derive tool names and types from the exported refs. Forget
// the `export` and the view's hooks fall back to untyped.
export const searchProducts = server.tool(
  {
    name: "search-products",
    inputSchema: z.object({ query: z.string().describe("Search text") }),

    // Step 2: outputSchema IS the view's prop contract.
    outputSchema: z.object({
      query: z.string(),
      results: z.array(z.object({ id: z.string(), title: z.string() })),
    }),

    // Binds views/product-list/view.tsx. Requires outputSchema.
    view: { name: "product-list" },
  },
  async ({ query }) => {
    const data = { query, results: await search(query) };
    return {
      content: [{ type: "text", text: `Found ${data.results.length}` }],
      structuredContent: data,   // ← this is what the view receives
    };
  }
);

// ── views/product-list/view.tsx ─────────────────────────────
// Step 3: name the TOOL in the generic — not a props type.
export default function ProductList() {
  const view = useToolContext<"search-products">();

  if (view.status === "error") return <Error message={view.error.message} />;
  if (view.status === "pending") return <Skeleton query={view.toolInput?.query} />;

  const { query, results } = view.toolOutput;   // fully typed
  return <Results query={query} items={results} />;
}
```

⚠️ **Common mistakes:**
- Passing a props type (`useToolContext<Props>()`) instead of the tool name — the
  generic is `keyof RegisteredTools`, a string literal.
- Not exporting the `ToolRef` from the server entry, which silently drops typing.
- Reading `view.toolOutput` without narrowing on `status` first — it is `undefined`
  until the result lands.

### 5. Validate at Boundaries Only
- Trust internal code and framework guarantees
- Validate user input, external API responses
- Don't add error handling for scenarios that can't happen

### 6. Prefer Widgets for Browsing/Comparing
When in doubt, add a widget. Visual UI improves:
- Browsing multiple items
- Comparing data side-by-side
- Interactive selection workflows

---

## Quick Reference

### Minimal Server
```typescript
import { MCPServer, text } from "mcp-use";
import { z } from "zod";

const server = new MCPServer({
  name: "my-server",
  title: "My Server",
  version: "1.0.0"
});

server.tool(
  {
    name: "greet",
    description: "Greet a user",
    schema: z.object({ name: z.string().describe("User's name") })
  },
  async ({ name }) => text("Hello " + name + "!"),
);

export default server;
```

---

## Response Helpers

⚠️ **All response helpers are deprecated in v2, and they do not typecheck on a tool
that declares an `outputSchema`.** They still exist and still run — but `object()`
returns `structuredContent` as *optional*, while a schema-backed tool's callback
requires it, so TypeScript rejects it. Same for `error()`, whose `isError` is not
the literal `true` the return type needs.

| Tool | What to return |
|---|---|
| has `outputSchema` | a raw `CallToolResult` — helpers will not compile |
| no `outputSchema` | helpers still work (`return text(msg)`) |

```typescript
// ✅ v2 — raw CallToolResult, works with or without an outputSchema
return {
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
};

// ✅ v2 — failure
return { isError: true, content: [{ type: "text", text: "Not found" }] };

// ⚠️ deprecated; breaks as soon as the tool declares an outputSchema
return object(data);
return error("Not found");
```

Still exported from `mcp-use` for now: `text`, `object`, `error`, `widget`, `mix`,
`markdown`, `html`, `image`, `audio`, `binary`, `resource`, `array`, `css`,
`javascript`, `xml`. There is no `content()` helper — there never was.

**Server methods:**
- `server.tool()` - Define executable tool (bind a view with `view: { name }`)
- `server.resource()` - Define static/dynamic resource
- `server.resourceTemplate()` - Define parameterized resource
- `server.prompt()` - Define prompt template
- `server.proxy()` - Compose/Proxy multiple MCP servers
- `export default server` - Entry contract; the CLI mounts and listens
- `server.listen(port)` - Only when self-hosting outside the CLI
- `server.use('mcp:tools/call', fn)` - MCP middleware (tools, resources, prompts, list ops)
- `server.use('mcp:*', fn)` - Catch-all MCP middleware
- `server.use(fn)` - HTTP middleware (Hono)


