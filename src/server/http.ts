import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServerLowLevel } from "@modelcontextprotocol/sdk/server/index.js";
import type { TooltrimConfig } from "../config/schema.js";
import { runWithInboundContext, type UpstreamManager } from "../upstream/manager.js";
import { unsafeDecodeBearer } from "../policy/oauth.js";
import { child as childLogger } from "../logger.js";

export interface InboundHttpHandle {
  close: () => Promise<void>;
  /** Actual bound port (useful when config port is 0). */
  port: number;
}

/**
 * Inbound Streamable HTTP transport. Stateless by default per the 2026 MCP
 * roadmap (no in-memory session affinity). When `inbound.http.sessions` is
 * a Redis URL the v0.1 implementation still falls back to stateless and
 * logs a TODO — the real session adapter ships in v0.2.
 *
 * In stateless mode the SDK requires both a fresh transport AND a fresh
 * Server instance per request, so we accept a `createServer` factory
 * (provided by the Aggregator) and call it on every POST.
 */
export async function startHttpServer(args: {
  cfg: TooltrimConfig;
  createServer: () => McpServerLowLevel;
  upstream: UpstreamManager;
}): Promise<InboundHttpHandle> {
  const { cfg, createServer: createMcp, upstream } = args;
  const log = childLogger({ component: "inbound-http" });
  const { host, path: mcpPath, sessions } = cfg.inbound.http;
  const requestedPort = cfg.inbound.http.port;
  let boundPort = requestedPort;

  if (sessions !== "stateless") {
    log.warn(
      { sessions },
      "stateful sessions are not yet implemented in v0.1; falling back to stateless behavior",
    );
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);

    if (url.pathname === "/healthz") {
      const upstreams = [...upstream.connections.values()].map((c) => ({
        id: c.id,
        status: c.status,
      }));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", upstreams }));
      return;
    }

    if (url.pathname !== mcpPath) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : undefined;
    const identity = unsafeDecodeBearer(auth);

    // Stateless: fresh transport AND fresh Server instance per request, per
    // the Streamable HTTP spec and the official SDK example.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createMcp();
    res.on("close", () => {
      transport.close().catch(() => undefined);
      mcp.close().catch(() => undefined);
    });

    try {
      await runWithInboundContext({ authorization: auth, identity }, async () => {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "HTTP request handling failed");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { code: -32603, message: "internal error" } }));
      }
    }
  };

  const httpServer = createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error({ err: (err as Error).message }, "unhandled inbound HTTP error");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, () => {
      httpServer.off("error", reject);
      const addr = httpServer.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      resolve();
    });
  });
  log.info({ host, port: boundPort, path: mcpPath, sessions }, "inbound HTTP transport listening");

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}
