import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "pino";
import type {
  HttpServerConfig,
  TooltrimConfig,
  StdioServerConfig,
} from "../config/schema.js";
import { child as childLogger } from "../logger.js";
import type { IdentityClaims } from "../policy/oauth.js";
import { VERSION } from "../version.js";
import type { UpstreamConnection, UpstreamStatus } from "./types.js";

const PROXY_CLIENT_INFO = { name: "tooltrim", version: VERSION };

export interface InboundContext {
  authorization?: string;
  identity?: IdentityClaims;
}

// One process serves many HTTP clients. Auth has to follow the request.
const inboundContext = new AsyncLocalStorage<InboundContext>();

export function runWithInboundContext<T>(ctx: InboundContext, fn: () => Promise<T>): Promise<T> {
  return inboundContext.run(ctx, fn);
}

export function getInboundContext(): InboundContext | undefined {
  return inboundContext.getStore();
}

/** Authorization header to add when this upstream's auth mode is passthrough. */
export function resolvePassthroughAuthorization(
  serverAuth: HttpServerConfig["auth"] | undefined,
  defaultAuth: "passthrough" | "none",
): string | undefined {
  const mode = serverAuth ?? defaultAuth;
  if (mode !== "passthrough") return undefined;
  return inboundContext.getStore()?.authorization;
}

/**
 * Owns the lifecycle of every upstream MCP server: spawns/connects, performs
 * the MCP `initialize` handshake, exposes `Client` instances, and reconnects
 * on unexpected exit.
 */
export type StatusListener = (id: string, status: UpstreamStatus) => void;

export class UpstreamManager {
  private readonly cfg: TooltrimConfig;
  private readonly log: Logger;
  private readonly conns = new Map<string, UpstreamConnection>();
  private readonly restartCounts = new Map<string, number>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly httpHeaders = new Map<string, Record<string, string>>();
  private readonly statusListeners = new Set<StatusListener>();
  private closing = false;

  constructor(cfg: TooltrimConfig) {
    this.cfg = cfg;
    this.log = childLogger({ component: "upstream" });
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(id: string, status: UpstreamStatus): void {
    for (const l of this.statusListeners) {
      try {
        l(id, status);
      } catch (err) {
        this.log.warn({ err: errMsg(err) }, "status listener failed");
      }
    }
  }

  get connections(): ReadonlyMap<string, UpstreamConnection> {
    return this.conns;
  }

  async connectAll(): Promise<void> {
    const ids = Object.keys(this.cfg.servers);
    await Promise.all(ids.map((id) => this.connectOne(id)));
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    await Promise.all(
      [...this.conns.values()].map(async (conn) => {
        try {
          await conn.client.close();
        } catch (err) {
          this.log.warn({ id: conn.id, err: errMsg(err) }, "error closing upstream");
        }
        conn.status = "closed";
      }),
    );
  }

  async connectOne(id: string): Promise<UpstreamConnection> {
    const cfg = this.cfg.servers[id];
    if (!cfg) throw new Error(`unknown upstream server "${id}"`);
    if (this.closing) {
      const existing = this.conns.get(id);
      if (existing) return existing;
      throw new Error(`upstream "${id}" is shutting down`);
    }
    const previous = this.conns.get(id);
    if (previous?.status === "connected") return previous;
    if (previous) {
      // Drop handlers first so close() does not schedule another reconnect.
      previous.client.onclose = undefined;
      previous.client.onerror = undefined;
      void previous.client.close().catch(() => undefined);
    }
    this.log.info({ id, transport: cfg.transport }, "connecting upstream");

    const client = new Client(PROXY_CLIENT_INFO, { capabilities: {} });

    try {
      if (cfg.transport === "stdio") {
        await this.connectStdio(id, cfg, client);
      } else {
        await this.connectHttp(id, cfg, client);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error({ id, err: error.message }, "upstream initial connect failed");
      const conn: UpstreamConnection = {
        id,
        client,
        status: "errored",
        lastError: error,
      };
      this.conns.set(id, conn);
      if (this.closing) {
        void client.close().catch(() => undefined);
        conn.status = "closed";
        return conn;
      }
      this.emitStatus(id, "errored");
      this.scheduleReconnect(id);
      return conn;
    }

    if (this.closing) {
      void client.close().catch(() => undefined);
      const closed: UpstreamConnection = { id, client, status: "closed" };
      this.conns.set(id, closed);
      return closed;
    }

    const conn: UpstreamConnection = {
      id,
      client,
      status: "connected",
      capabilities: client.getServerCapabilities(),
      serverInfo: client.getServerVersion(),
    };
    this.conns.set(id, conn);
    this.restartCounts.set(id, 0);
    this.attachLifecycleHandlers(conn);
    this.emitStatus(id, "connected");
    this.log.info(
      { id, server: conn.serverInfo, capabilities: conn.capabilities },
      "upstream ready",
    );
    return conn;
  }

  private async connectStdio(
    id: string,
    cfg: StdioServerConfig,
    client: Client,
  ): Promise<void> {
    const [command, ...args] = cfg.command;
    if (!command) throw new Error(`upstream "${id}" stdio command is empty`);
    const transport = new StdioClientTransport({
      command,
      args,
      // SDK merges this onto PATH/HOME/…. Spreading process.env would hand the child every secret.
      env: cfg.env,
      cwd: cfg.cwd,
      stderr: "pipe",
    });
    let stderrBytesThisMinute = 0;
    let stderrMinuteStart = Date.now();
    const stderrBudget = cfg.stderrLogBytesPerMinute ?? 10_000;

    transport.stderr?.on("data", (chunk: Buffer) => {
      const now = Date.now();
      if (now - stderrMinuteStart > 60_000) {
        stderrBytesThisMinute = 0;
        stderrMinuteStart = now;
      }
      if (stderrBudget === 0 || stderrBytesThisMinute < stderrBudget) {
        this.log.debug({ id, chunk: chunk.toString("utf8").trim() }, "upstream stderr");
        stderrBytesThisMinute += chunk.length;
      }
    });
    await client.connect(transport);
  }

  private async connectHttp(
    id: string,
    cfg: HttpServerConfig,
    client: Client,
  ): Promise<void> {
    const baseHeaders: Record<string, string> = { ...(cfg.headers ?? {}) };
    if (cfg.auth && typeof cfg.auth === "object" && cfg.auth.type === "header") {
      baseHeaders[cfg.auth.name] = cfg.auth.value;
    }
    this.httpHeaders.set(id, baseHeaders);

    const dynamicFetch: typeof fetch = (input, init) => {
      const merged: Record<string, string> = { ...this.httpHeaders.get(id) };
      const authorization = resolvePassthroughAuthorization(cfg.auth, this.cfg.policy.defaultAuth);
      if (authorization) merged["Authorization"] = authorization;
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(merged)) {
        if (!headers.has(k)) headers.set(k, v);
      }
      return fetch(input, { ...init, headers });
    };

    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      fetch: dynamicFetch,
    });
    await client.connect(transport);
  }

  private attachLifecycleHandlers(conn: UpstreamConnection): void {
    conn.client.onclose = () => {
      if (this.closing) return;
      this.log.warn({ id: conn.id }, "upstream connection closed");
      conn.status = "errored";
      this.emitStatus(conn.id, "errored");
      this.scheduleReconnect(conn.id);
    };
    conn.client.onerror = (err) => {
      this.log.warn({ id: conn.id, err: err.message }, "upstream error");
      conn.status = "errored";
      conn.lastError = err;
      this.emitStatus(conn.id, "errored");
    };
  }

  private scheduleReconnect(id: string): void {
    if (this.closing) return;
    const cfg = this.cfg.servers[id];
    if (!cfg) return;
    const attempt = (this.restartCounts.get(id) ?? 0) + 1;
    const max = cfg.transport === "stdio" ? cfg.maxRestarts : 5;
    if (attempt > max) {
      this.log.error({ id, attempt }, "giving up reconnect");
      return;
    }
    const baseBackoff = cfg.transport === "stdio" ? cfg.restartBackoffMs : 500;
    const delay = Math.min(baseBackoff * Math.pow(2, attempt - 1), 30_000);
    this.restartCounts.set(id, attempt);
    this.log.info({ id, attempt, delayMs: delay }, "scheduling upstream reconnect");
    const pending = this.restartTimers.get(id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      if (this.closing) return;
      this.connectOne(id).catch((err) => {
        this.log.warn({ id, err: errMsg(err) }, "reconnect attempt failed");
      });
    }, delay);
    this.restartTimers.set(id, timer);
  }

}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
