# Widget Basics

> **v2 note:** v1's "widget" is a **view**. Files live at `views/<name>/view.tsx`,
> the module exports `viewConfig` (only `autoResize` and `displayModes`) plus a
> default component, and all of a view's data comes from its bound tool's
> `outputSchema` via `useToolContext<"tool-name">()`. There is no `props:` schema on
> the view module and no `exposeAsTool` — a view is reached through the tool that
> declares `view: { name }`.


Widgets are React components that provide visual UI for MCP tools. They let users browse, compare, and interact with data visually.

**Use widgets for:** Product lists, calendars, dashboards, search results, file browsers, any visual data representation

---

## When to Use Widgets

**Use a widget when:**
- ✅ Browsing or comparing multiple items
- ✅ Visual representation improves understanding (charts, images, layouts)
- ✅ Interactive selection is easier visually than through text
- ✅ User needs to see data structure at a glance

**Use plain tool (no widget) when:**
- ❌ Output is simple text or a single value
- ❌ No visual representation adds value
- ❌ Quick conversational response is sufficient

**When in doubt:** Use a widget. It makes the experience better.

---

## Minimal Widget

### 1. Create Tool with Widget Config

```typescript
// index.ts
import { MCPServer, widget, text } from "mcp-use";
import { z } from "zod";

const server = new MCPServer({
  name: "my-server",
  version: "1.0.0"
});

server.tool(
  {
    name: "show-weather",
    description: "Display weather for a city",
    schema: z.object({
      city: z.string().describe("City name")
    }),
    view: {
      name: "weather-display",  // Must match dir: views/weather-display/view.tsx
      // v2 has no invoking/invoked. Render your own pending state from
      // useToolContext().status inside the view.
    }
  },
  async ({ city }) => {
    const data = await getWeather(city);

    return widget({
      props: {
        city: data.city,
        temp: data.temperature,
        conditions: data.conditions,
        icon: data.icon
      },
      output: text(`Weather in ${city}: ${data.temperature}°C, ${data.conditions}`)
    });
  }
);
```

### 2. Create Widget Component

```tsx
// views/weather-display/view.tsx
import { ThemeProvider, useToolContext, type ViewConfig } from "mcp-use/react";
import { z } from "zod";

const propsSchema = z.object({
  city: z.string(),
  temp: z.number(),
  conditions: z.string(),
  icon: z.string()
});

// Only pre-render runtime settings live here. The view's DATA contract is the
// bound tool's `outputSchema`, and its resource facts (description, csp,
// prefersBorder) live on that tool's `view:` config.
export const viewConfig = {
  displayModes: ["inline", "fullscreen"],
} satisfies ViewConfig;

export default function WeatherDisplay() {
  // The generic is the TOOL NAME, not a props type.
  const view = useToolContext<"get-weather">();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) {
    return (
      <ThemeProvider>
        <div>Loading weather...</div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <div style={{ padding: 20 }}>
        <h2>{props.city}</h2>
        <img src={props.icon} alt={props.conditions} width={64} />
        <div style={{ fontSize: 48 }}>{props.temp}°C</div>
        <p>{props.conditions}</p>
      </div>
    </ThemeProvider>
  );
}
```

**Key requirements:**
1. Export a default component; `viewConfig` is optional
2. Pass the **tool name** to `useToolContext<"get-weather">()`
3. Export the tool's `ToolRef` from the server entry so the types resolve
4. Wrap root in `<ThemeProvider>`
5. **Narrow on `view.status` before reading `view.toolOutput`**

**Production builds (`mcp-use build`):** Never use bare `useToolContext()` without a props generic — fields default to `unknown` and TypeScript will fail (e.g. TS2322). If you use `callTool` from `useToolContext()`, treat `structuredContent` and nested values as `unknown` until you parse with Zod, narrow with `typeof`/`Array.isArray`, or assign to typed variables; do not pass `unknown` directly as JSX children or string props.

---

## Widget Metadata

The `viewConfig` export defines your widget's contract:

```typescript
export const viewConfig = {
  autoResize: true,                              // default; false = report size yourself
  displayModes: ["inline", "fullscreen", "pip"], // default; must contain "inline"
} satisfies ViewConfig;
```

**Fields — that is the whole surface:**
- `autoResize` - Let the host observe the document and track size changes (default `true`)
- `displayModes` - Modes this view renders correctly in (default all three)

Everything else moved to the **bound tool** in your server entry:

```typescript
view: {
  name: "weather-display",
  description: "What the view resource is",   // was viewConfig.description
  csp: { connectDomains: ["https://api.weather.com"] },
  prefersBorder: false,
}
```

There is no `props` (the tool's `outputSchema` is the contract), no `exposeAsTool`,
and no `invoking` / `invoked` — v2 dropped those status strings entirely. Render your
own pending state from `useToolContext().status`.

```typescript
// On the TOOL, in your server entry — not on the view module:
view: {
  name: "weather-display",
  description: "Display weather information for a city",
  csp: { connectDomains: ["https://api.weather.com"] },
}
```

These status texts appear as animated shimmer text (pending) and static text (complete) in the MCP Inspector and ChatGPT. The values also flow to `openai/toolInvocation/invoking`/`invoked` in tool metadata automatically.

---

## useToolContext() Hook

The `useToolContext()` hook provides access to props and widget state:

```typescript
const {
  props,        // Widget props from tool response
  isPending,    // True while props are loading
  setState,     // Update widget state
  state,        // Current widget state
} = useToolContext();
```

**To call tools from a widget**, use the dedicated `useCallTool()` hook — see [interactivity.md](interactivity.md).

### props
Data passed from tool's `widget({ props })` response:

```typescript
const view = useToolContext();
  const props = view.toolOutput;

// Access props after isPending check
if (!isPending) {
  console.log(props.city);      // "Tokyo"
  console.log(props.temp);      // 28
}
```

**Always check `isPending` before accessing `props`:**
```typescript
❌ const view = useToolContext();
  const props = view.toolOutput;
   return <div>{props.city}</div>;  // Error! props undefined while loading

✅ const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;
   if (isPending) return <div>Loading...</div>;
   return <div>{props.city}</div>;  // Safe
```

### isPending
Boolean indicating if props are still loading.

**CRITICAL:** Widgets render **before** the tool completes execution. On first render:
- `isPending` is `true`
- `props` is an empty object `{}`
- Accessing `props` fields will cause errors

**Widget Lifecycle:**
1. Widget mounts immediately when tool is called → `isPending = true`, `props = {}`
2. Tool executes and returns `widget({ props })`
3. Widget re-renders → `isPending = false`, `props` contains data

```typescript
const isPending = useToolContext().status === "pending";

if (isPending) {
  return (
    <ThemeProvider>
      <div>Loading...</div>
    </ThemeProvider>
  );
}

// Now safe to access props - guaranteed to have data
```

**Multiple patterns for handling isPending:**

```typescript
// ✅ Pattern 1: Early return (recommended)
if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;
return <ThemeProvider><div>{props.data}</div></ThemeProvider>;

// ✅ Pattern 2: Conditional rendering
return (
  <ThemeProvider>
    {isPending ? <div>Loading...</div> : <div>{props.data}</div>}
  </ThemeProvider>
);

// ✅ Pattern 3: Optional chaining (when props might be undefined)
return <ThemeProvider><div>{props?.data ?? "Loading..."}</div></ThemeProvider>;
```

---

## ThemeProvider

**Required wrapper** for all widgets. Provides context and handles iframe sizing.

```typescript
import { ThemeProvider } from "mcp-use/react";

export default function MyWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) {
    return <ThemeProvider><div>Loading...</div></ThemeProvider>;
  }

  return (
    <ThemeProvider>
      <div>
        {/* Your widget content */}
      </div>
    </ThemeProvider>
  );
}
```

**Props:**
- `colorScheme` - Also set `color-scheme` on the document root to match the theme

Auto-resize is not a prop here. It is on by default; opt out with
`viewConfig.autoResize: false` and drive it with `useSendSizeChanged()`.

**Must wrap:**
- ✅ Every return path (including loading states)
- ✅ Root element of component

---

## Props Handling Patterns

### Simple Props
```typescript
export const viewConfig: ViewConfig = {
  props: z.object({
    message: z.string(),
    count: z.number()
  }),
};

export default function SimpleWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  return (
    <ThemeProvider>
      <div>
        <p>{props.message}</p>
        <p>Count: {props.count}</p>
      </div>
    </ThemeProvider>
  );
}
```

### Array Props
```typescript
export const viewConfig: ViewConfig = {
  props: z.object({
    items: z.array(z.object({
      id: z.string(),
      name: z.string()
    }))
  }),
};

export default function ListWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  return (
    <ThemeProvider>
      <ul>
        {props.items.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </ThemeProvider>
  );
}
```

### Nested Props
```typescript
export const viewConfig: ViewConfig = {
  props: z.object({
    user: z.object({
      name: z.string(),
      profile: z.object({
        bio: z.string(),
        avatar: z.string()
      })
    })
  }),
};

export default function ProfileWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  const { user } = props;

  return (
    <ThemeProvider>
      <div>
        <img src={user.profile.avatar} alt={user.name} />
        <h2>{user.name}</h2>
        <p>{user.profile.bio}</p>
      </div>
    </ThemeProvider>
  );
}
```

### Optional Props
```typescript
export const viewConfig: ViewConfig = {
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),  // May be undefined
    items: z.array(z.string())
  }),
};

export default function FlexibleWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  return (
    <ThemeProvider>
      <div>
        <h1>{props.title}</h1>
        {props.subtitle && <h2>{props.subtitle}</h2>}
        <ul>
          {props.items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </div>
    </ThemeProvider>
  );
}
```

---

## File Location

Widgets live in `resources/` directory:

```
my-server/
├── index.ts              # Server code
├── resources/
│   ├── weather-display.tsx    # Widget component
│   ├── product-list.tsx
│   └── calendar-view.tsx
└── package.json
```

**Naming convention:**
- Use kebab-case for widget names
- Tool config: `view: { name: "weather-display" }`
- File: `views/weather-display/view.tsx`

---

## TypeScript Types

For type safety, infer props type from schema:

⚠️ **CRITICAL:** Always define your Zod schema in a separate constant before `viewConfig`. Never infer types from `viewConfig.props` - TypeScript will lose type information and the result will be `unknown`.

```typescript
import { z } from "zod";
import { ThemeProvider, useToolContext, type ViewConfig } from "mcp-use/react";

const propsSchema = z.object({
  city: z.string(),
  temp: z.number(),
  conditions: z.string()
});

export const viewConfig = {} satisfies ViewConfig;

export default function WeatherWidget() {
  const view = useToolContext<"get-weather">();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  // Now props is fully typed!
  return (
    <ThemeProvider>
      <div>
        <h2>{props.city}</h2>  {/* ✓ TypeScript knows this is string */}
        <p>{props.temp}°C</p>   {/* ✓ TypeScript knows this is number */}
      </div>
    </ThemeProvider>
  );
}
```

---

## Common Mistakes

### ❌ Missing isPending Check
```typescript
// ❌ Bad - props undefined during loading
export default function BadWidget() {
  const view = useToolContext();
  const props = view.toolOutput;

  return (
    <ThemeProvider>
      <div>{props.title}</div>  {/* Error! */}
    </ThemeProvider>
  );
}

// ✅ Good
export default function GoodWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  return (
    <ThemeProvider>
      <div>{props.title}</div>
    </ThemeProvider>
  );
}
```

### ❌ Missing ThemeProvider
```typescript
// ❌ Bad - Missing provider
export default function BadWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <div>Loading...</div>;

  return <div>{props.title}</div>;  {/* Won't render correctly */}
}

// ✅ Good
export default function GoodWidget() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) return <ThemeProvider><div>Loading...</div></ThemeProvider>;

  return (
    <ThemeProvider>
      <div>{props.title}</div>
    </ThemeProvider>
  );
}
```


### ❌ Missing Type Parameter on useToolContext
```typescript
// ❌ Bad - props is UnknownObject, no autocomplete or type safety
const propsSchema = z.object({
  title: z.string(),
  count: z.number()
});

export default function BadWidget() {
  const view = useToolContext();
  const props = view.toolOutput;  // props is UnknownObject
  return <div>{props.title}</div>;  // No IDE support, runtime errors possible
}

// ✅ Good - props is fully typed with IDE support
const propsSchema = z.object({
  title: z.string(),
  count: z.number()
});

type Props = z.infer<typeof propsSchema>;

export default function GoodWidget() {
  const view = useToolContext<"get-weather">();
  const props = view.toolOutput;  // props is properly typed
  return <div>{props.title}</div>;  // Full autocomplete and type checking
}
```

### ❌ Inferring Type from viewConfig.props
```typescript
// ❌ Bad - Type inference fails, Props is unknown
export const viewConfig: ViewConfig = {
  description: "...",
  props: z.object({
    title: z.string(),
    count: z.number()
  })  // Inline schema definition
};

type Props = z.infer<typeof viewConfig.props>;  // Props is unknown!

export default function BadWidget() {
  const view = useToolContext<"get-weather">();
  const props = view.toolOutput;
  return <div>{props.title}</div>;  // No autocomplete, no type safety
}

// ✅ Good - Extract schema first for proper type inference
const propsSchema = z.object({
  title: z.string(),
  count: z.number()
});

export const viewConfig = {} satisfies ViewConfig;

export default function GoodWidget() {
  const view = useToolContext<"get-weather">();
  const props = view.toolOutput;
  return <div>{props.title}</div>;  // Full autocomplete and type checking
}
```

**Why this happens:** The `ViewConfig` type is generic, so TypeScript can't preserve the specific Zod schema type when defined inline. Always extract your schema to a separate constant before using it in `viewConfig`.

---

## Testing Widgets

### Option 1: Inspector (interactive)

1. Start dev server: `npm run dev`
2. Open inspector: `http://localhost:3000/inspector`
3. Click "List Tools" → Find your tool
4. Click "Call Tool" → Enter test input
5. Widget renders in inspector

**Quick iteration:**
- Change widget code → Auto-reload
- Adjust props schema → Update tool call input
- Test edge cases (empty lists, missing optional props)

### Option 2: Headless screenshot (agent-friendly)

For visual feedback loops where you want to verify a widget change without leaving the terminal — call the tool, save a PNG, eyeball it, edit, repeat:

```bash
# Saved-server form (assumes you ran `mcp-use client connect dev <url>` once)
npx mcp-use client dev screenshot --tool get-weather city=Tokyo \
  --width 800 --height 600 --theme light \
  --output ./weather.png

# Ad-hoc form — no saved server, pass auth headers inline if needed
npx mcp-use client screenshot --mcp http://localhost:3000/mcp \
  --tool get-weather city=Tokyo
```

- Args are `key=value` pairs, `key:='<json>'` for nested values, or one full JSON object
- The saved-server form reuses the auth from `mcp-use client connect` (OAuth or `--auth <token>`); the ad-hoc form accepts `-H "Header: value"` (repeatable) for authenticated servers
- Add `--device-scale-factor 2` for Retina output
- For sandboxed environments without a local Chrome, point `--cdp-url <ws>` at a hosted Chromium (e.g. Notte) and `--inspector <publicly-reachable-url>` at a deployed inspector

Equivalently, `mcp-use client <name> tools call <tool> ... --screenshot` calls the tool *and* saves a widget PNG in one step — useful for one-shot verification.

---

## Complete Example

```typescript
// index.ts
import { MCPServer, widget, text } from "mcp-use";
import { z } from "zod";

const server = new MCPServer({
  name: "product-server",
  version: "1.0.0"
});

server.tool(
  {
    name: "search-products",
    description: "Search products by keyword",
    schema: z.object({
      query: z.string().describe("Search query")
    }),
    view: {
      name: "product-list",
    }
  },
  async ({ query }) => {
    const products = await searchProducts(query);

    return widget({
      props: {
        products,
        query,
        totalCount: products.length
      },
      output: text(`Found ${products.length} products matching "${query}"`)
    });
  }
);

export default server;
```

```tsx
// views/product-list/view.tsx
import { ThemeProvider, useToolContext, type ViewConfig } from "mcp-use/react";
import { z } from "zod";

export const viewConfig: ViewConfig = {
  description: "Display product search results",
  props: z.object({
    products: z.array(z.object({
      id: z.string(),
      name: z.string(),
      price: z.number(),
      image: z.string()
    })),
    query: z.string(),
    totalCount: z.number()
  }),
};

export default function ProductList() {
  const view = useToolContext();
  const isPending = view.status === "pending";
  const props = view.toolOutput;

  if (isPending) {
    return (
      <ThemeProvider>
        <div style={{ padding: 20 }}>Loading products...</div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <div style={{ padding: 20 }}>
        <h2>Search: "{props.query}"</h2>
        <p>Found {props.totalCount} products</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
          {props.products.map(product => (
            <div key={product.id} style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
              <img src={product.image} alt={product.name} style={{ width: "100%", height: 150, objectFit: "cover" }} />
              <h3 style={{ fontSize: 16, margin: "8px 0" }}>{product.name}</h3>
              <p style={{ fontSize: 18, fontWeight: "bold" }}>${product.price}</p>
            </div>
          ))}
        </div>
      </div>
    </ThemeProvider>
  );
}
```

---

## Next Steps

- **Manage widget state** → [state.md](state.md)
- **Add interactivity** → [interactivity.md](interactivity.md)
- **Style with themes** → [ui-guidelines.md](ui-guidelines.md)
- **Advanced patterns** → [advanced.md](advanced.md)
