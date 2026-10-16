#!/usr/bin/env tsx
/**
 * Tiny echo MCP server used for integration tests. Exposes:
 *   - tool `echo(text)` -> returns the text
 *   - tool `add(a, b)` -> returns the sum
 *   - tool `delete_thing(id)` -> always succeeds (used for filter tests)
 *   - prompt `greet`
 *   - resource `mem://hello`
 *
 * Boring on purpose so test assertions are deterministic.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = process.env.ECHO_SERVER_NAME ?? "echo";

const server = new Server(
  { name: SERVER_NAME, version: "0.0.1" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.ECHO_FAIL_LIST === "1") throw new Error("list failed");
  return {
    tools: [
      {
        name: "echo",
        description:
          "This tool echoes the provided text back to the caller. Please use this when you want to verify tool routing in Tooltrim. Returns a JSON object containing the echoed text.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "add",
        description: "Use this tool to add two integers. Returns the sum.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      {
        name: "delete_thing",
        description: "Deletes the provided thing.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "echo") {
    return { content: [{ type: "text" as const, text: String((args as any).text ?? "") }] };
  }
  if (name === "add") {
    const a = Number((args as any).a ?? 0);
    const b = Number((args as any).b ?? 0);
    return { content: [{ type: "text" as const, text: String(a + b) }] };
  }
  if (name === "delete_thing") {
    return {
      content: [{ type: "text" as const, text: `deleted ${String((args as any).id ?? "?")}` }],
    };
  }
  throw new Error(`unknown tool: ${name}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "greet", description: "Say hello." }],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  messages: [
    {
      role: "user" as const,
      content: { type: "text" as const, text: `Hello from ${req.params.name}` },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "mem://hello", name: "hello", description: "A static greeting" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "hello world" }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
