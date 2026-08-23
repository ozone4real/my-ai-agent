import { MCPServer } from "mcp-use";
import { z } from "zod";

const server = new MCPServer({
  name: "my-mcp-server",
  title: "my-mcp-server", // display name
  version: "1.0.0",
  description: "MCP server with MCP Apps integration",
  instructions:
    "Use search-tools to find fruit matches before calling get-fruit-details. Prefer the widget result when the user wants to browse or compare options visually.",
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com", // Can be customized later
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});


/**
 * TOOL THAT RETURNS A WIDGET
 * The `widget` config tells mcp-use which widget component to render.
 * The `widget()` helper in the handler passes props to that component.
 * Docs: https://mcp-use.com/docs/typescript/server/mcp-apps
 */

// Fruits data — color values are Tailwind bg-[] classes used by the carousel UI
const fruits = [
  { fruit: "mango", color: "bg-[#FBF1E1] dark:bg-[#FBF1E1]/10" },
  { fruit: "pineapple", color: "bg-[#f8f0d9] dark:bg-[#f8f0d9]/10" },
  { fruit: "cherries", color: "bg-[#E2EDDC] dark:bg-[#E2EDDC]/10" },
  { fruit: "coconut", color: "bg-[#fbedd3] dark:bg-[#fbedd3]/10" },
  { fruit: "apricot", color: "bg-[#fee6ca] dark:bg-[#fee6ca]/10" },
  { fruit: "blueberry", color: "bg-[#e0e6e6] dark:bg-[#e0e6e6]/10" },
  { fruit: "grapes", color: "bg-[#f4ebe2] dark:bg-[#f4ebe2]/10" },
  { fruit: "watermelon", color: "bg-[#e6eddb] dark:bg-[#e6eddb]/10" },
  { fruit: "orange", color: "bg-[#fdebdf] dark:bg-[#fdebdf]/10" },
  { fruit: "avocado", color: "bg-[#ecefda] dark:bg-[#ecefda]/10" },
  { fruit: "apple", color: "bg-[#F9E7E4] dark:bg-[#F9E7E4]/10" },
  { fruit: "pear", color: "bg-[#f1f1cf] dark:bg-[#f1f1cf]/10" },
  { fruit: "plum", color: "bg-[#ece5ec] dark:bg-[#ece5ec]/10" },
  { fruit: "banana", color: "bg-[#fdf0dd] dark:bg-[#fdf0dd]/10" },
  { fruit: "strawberry", color: "bg-[#f7e6df] dark:bg-[#f7e6df]/10" },
  { fruit: "lemon", color: "bg-[#feeecd] dark:bg-[#feeecd]/10" },
];

// structuredContent schema for the search-tools result. The widget renders this
// data (it arrives as the widget's tool output / structuredContent).
const fruitRowSchema = z.object({
  fruit: z.string(),
  color: z.string(),
});

export const searchTools = server.tool(
  {
    name: "search-tools",
    title: "Search fruits",
    description: "Search for fruits and display the results in a visual widget",
    schema: z.object({
      query: z.string().optional().describe("Search query to filter fruits"),
    }),
    // Hosts (e.g. ChatGPT) expect explicit hints. Use openWorldHint: true for HTTP/API calls;
    // destructiveHint: true when deleting or overwriting user data.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    outputSchema: z.object({
      query: z.string(),
      results: z.array(fruitRowSchema),
    }),
    // Binds this tool to views/product-search-result/view.tsx. The bound tool
    // owns the view's resource facts, so `description`/`csp`/`prefersBorder`
    // live here rather than in the view module.
    view: {
      name: "product-search-result",
      description:
        "Display product search results with filtering, state management, and tool interactions",
      prefersBorder: false,
      csp: {
        resourceDomains: ["https://cdn.openai.com"],
      },
    },
  },
  async ({ query }) => {
    const results = fruits.filter(
      (f) => !query || f.fruit.toLowerCase().includes(query.toLowerCase())
    );

    // let's emulate a delay to show the loading state
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // structuredContent is delivered to the view and is type-checked against
    // the outputSchema above; content is what the model reads.
    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} fruits matching "${query ?? "all"}"`,
        },
      ],
      structuredContent: { query: query ?? "", results },
    };
  }
);

export const getFruitDetails = server.tool(
  {
    name: "get-fruit-details",
    title: "Get fruit details",
    description: "Get detailed information about a specific fruit",
    schema: z.object({
      fruit: z.string().describe("The fruit name"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    outputSchema: z.object({
      fruit: z.string(),
      color: z.string(),
      facts: z.array(z.string()),
    }),
  },
  async ({ fruit }) => {
    const found = fruits.find(
      (f) => f.fruit?.toLowerCase() === fruit?.toLowerCase()
    );
    const details = {
      fruit: found?.fruit ?? fruit,
      color: found?.color ?? "unknown",
      facts: [
        `${fruit} is a delicious fruit`,
        `Color: ${found?.color ?? "unknown"}`,
      ],
    };

    return {
      content: [{ type: "text", text: JSON.stringify(details) }],
      structuredContent: details,
    };
  }
);

// v2 entry contract: default-export the server. The CLI imports it, primes the
// views bundled from views/, then mounts and listens — do not call
// server.listen() here or view bindings fail to resolve.
export default server;

