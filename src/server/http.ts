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
 * Block a browser page that DNS-rebinds onto this port. The page's Origin
 * stays the attacker's site, and a loopback bind also requires a loopback
 * Host (browsers cannot set either header). Not authentication.
 */
export function inboundRequestAllowed(opts: {
  hostHeader: string | undefined;
  originHeader: string | undefined;
  bindHost: string;
  port: number;
}): boolean {
  if (!originAllowed(opts.originHeader)) return false;
  if (!loopbackBind(opts.bindHost)) return true;
  return loopbackHost(opts.hostHeader, opts.port);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function loopbackBind(bindHost: string): boolean {
  const bind = bindHost.trim().toLowerCase();
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1" || bind === "[::1]";
}

function loopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const header = hostHeader.trim().toLowerCase();
  for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
    if (header === `${name}:${port}`) return true;
    if ((port === 80 || port === 443) && header === name) return true;
  }
  return false;
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

  // Never log the raw value: a Redis URL often carries the password.
  const sessionsMode = sessions === "stateless" ? "stateless" : "custom";
  if (sessions !== "stateless") {
    log.warn(
      { sessions: sessionsMode },
      "stateful sessions are not yet implemented in v0.1; falling back to stateless behavior",
    );
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // Fixed base: `host` may be an IPv6 address, which is not a valid URL host bare.
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (
      !inboundRequestAllowed({
        hostHeader: req.headers.host,
        originHeader: req.headers.origin,
        bindHost: host,
        port: boundPort,
      })
    ) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }

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

    const auth =
      typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : undefined;
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
  log.info(
    { host, port: boundPort, path: mcpPath, sessions: sessionsMode },
    "inbound HTTP transport listening",
  );

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}
