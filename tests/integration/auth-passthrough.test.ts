import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runProxy } from "../../src/proxy.js";
import { buildTestConfig } from "../helpers.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // shutdown races are fine in this test
    }
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function startUpstream(): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = [];
  const server = createServer((req, res) => {
    if (typeof req.headers.authorization === "string") auths.push(req.headers.authorization);
    void handleUpstream(req, res);
  });
  const port = await listen(server);
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/mcp`, auths };
}

async function handleUpstream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mcp = new Server({ name: "up", version: "0.0.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping",
        description: "ping",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { content: [{ type: "text", text: "pong" }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    }
  }
}

async function connectClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "caller", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", token);
      return fetch(input, { ...init, headers });
    },
  });
  await client.connect(transport);
  closers.push(async () => {
    await client.close();
  });
  return client;
}

describe("HTTP auth passthrough", () => {
  it(
    "does not mix Authorization across concurrent clients",
    async () => {
      const upstream = await startUpstream();
      const cfg = buildTestConfig({
        servers: {
          up: { transport: "http", url: upstream.url, auth: "passthrough" },
        },
        shrink: { mode: "off" },
        inboundHttp: true,
      });
      cfg.inbound.http.port = 0;
      const proxy = await runProxy({ cfg, disableInboundStdio: true });
      closers.push(() => proxy.close());
      const proxyUrl = `http://127.0.0.1:${proxy.httpPort}/mcp`;

      const a = await connectClient(proxyUrl, "Bearer A");
      const b = await connectClient(proxyUrl, "Bearer B");
      await a.listTools();
      await b.listTools();

      upstream.auths.length = 0;
      await Promise.all([
        a.callTool({ name: "up.ping", arguments: {} }),
        b.callTool({ name: "up.ping", arguments: {} }),
      ]);
      expect(upstream.auths.slice().sort()).toEqual(["Bearer A", "Bearer B"]);
    },
    30_000,
  );
});
