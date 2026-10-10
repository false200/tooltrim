import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Logger } from "pino";
import type { TooltrimConfig } from "../config/schema.js";
import { child as childLogger } from "../logger.js";
import { ToolFilter } from "./filter.js";
import { Shrinker } from "./shrinker.js";
import { getInboundContext, type UpstreamManager } from "../upstream/manager.js";
import type { Tracer } from "../observability/tracer.js";
import type { MetricsRecorder } from "../observability/metrics.js";
import type { AuditLogger } from "../observability/audit.js";
import { VERSION } from "../version.js";

const PROXY_INFO = { name: "tooltrim", version: VERSION };

export interface AggregatorDeps {
  cfg: TooltrimConfig;
  upstream: UpstreamManager;
  filter: ToolFilter;
  shrinker: Shrinker;
  tracer?: Tracer;
  metrics?: MetricsRecorder;
  audit?: AuditLogger;
}

interface ToolRouteEntry {
  upstreamId: string;
  originalName: string;
}

/**
 * Routes every list/call request to the right upstream. Always uses
 * `setRequestHandler` on the low-level `Server` (not `McpServer.registerTool`)
 * because the tool set is dynamic.
 *
 * IMPORTANT: the Streamable HTTP spec requires a fresh `Server` instance per
 * request in stateless mode. So this class doesn't *own* a Server — it just
 * exposes `attach(server)` and `createServer()` for inbound transports.
 *
 * Routing tables are kept on the Aggregator (shared across all per-request
 * Server instances) because they're rebuilt on every `tools/list` anyway.
 */
export class Aggregator {
  private readonly deps: AggregatorDeps;
  private readonly log: Logger;
  private readonly toolRoute = new Map<string, ToolRouteEntry>();
  private readonly promptRoute = new Map<string, { upstreamId: string; original: string }>();
  /** uri -> upstreamId for resources (URIs are unique upstream-side; we keep first wins on collision). */
  private readonly resourceRoute = new Map<string, string>();
  /** Short-lived cache for collectTools() to debounce redundant fan-out. */
  private toolsCache: { tools: unknown[]; ts: number } | null = null;
  private toolsInflight: Promise<unknown[]> | null = null;
  private readonly TOOLS_CACHE_TTL_MS = 2000;

  constructor(deps: AggregatorDeps) {
    this.deps = deps;
    this.log = childLogger({ component: "aggregator" });
  }

  /**
   * Build a fresh low-level `Server` and wire all handlers onto it.
   * Use one of these per inbound transport (or per request, for stateless HTTP).
   */
  createServer(): Server {
    const server = new Server(PROXY_INFO, {
      capabilities: this.computePlausibleCapabilities(),
      instructions:
        "You're talking to Tooltrim, a proxy that aggregates multiple MCP servers into one. " +
        "Tool names are namespaced as `<server>.<tool>`.",
    });
    this.wireHandlers(server);
    return server;
  }

  /**
   * Pre-declare the union of capabilities we *might* expose. The actual list
   * is filtered live at `tools/list`, so this just unblocks the negotiation.
   */
  private computePlausibleCapabilities(): ServerCapabilities {
    return {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
      prompts: { listChanged: true },
      logging: {},
    };
  }

  private wireHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.collectTools();
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      let route = this.toolRoute.get(name);
      if (!route) {
        // The client may have skipped tools/list (or the route table was
        // cleared since the last list). Refresh and try once more.
        await this.collectTools();
        route = this.toolRoute.get(name);
      }
      if (!route) {
        throw new Error(`tool "${name}" not found in Tooltrim routing table`);
      }
      if (!this.deps.filter.isAllowed(name, "tool")) {
        throw new Error(`tool "${name}" is denied by Tooltrim policy`);
      }
      if (this.deps.cfg.policy.blockedTools.includes(name)) {
        throw new Error(`tool "${name}" is on the blockedTools list`);
      }
      const conn = this.deps.upstream.connections.get(route.upstreamId);
      if (!conn || conn.status !== "connected") {
        throw new Error(`upstream "${route.upstreamId}" is not connected`);
      }
      const start = Date.now();
      this.deps.tracer?.trace({
        dir: "out",
        upstream: route.upstreamId,
        method: "tools/call",
        name,
      });
      try {
        const result = await conn.client.callTool({
          name: route.originalName,
          arguments: req.params.arguments ?? {},
        });
        const dur = Date.now() - start;
        this.deps.tracer?.trace({
          dir: "in",
          upstream: route.upstreamId,
          method: "tools/call",
          name,
          ok: true,
          durMs: dur,
        });
        this.deps.metrics?.recordCall(route.upstreamId, name, dur, true);
        await this.recordAudit(route.upstreamId, name, true, dur);
        return result;
      } catch (err) {
        const dur = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        this.deps.tracer?.trace({
          dir: "in",
          upstream: route.upstreamId,
          method: "tools/call",
          name,
          ok: false,
          durMs: dur,
          err: message,
        });
        this.deps.metrics?.recordCall(route.upstreamId, name, dur, false);
        await this.recordAudit(route.upstreamId, name, false, dur, message);
        throw err;
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = await this.collectResources();
      return { resources };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const templates = await this.collectResourceTemplates();
      return { resourceTemplates: templates };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const uri = req.params.uri;
      let upstreamId = this.resourceRoute.get(uri);
      if (!upstreamId) {
        await this.collectResources();
        upstreamId = this.resourceRoute.get(uri);
      }
      if (!upstreamId) {
        throw new Error(`resource "${uri}" not found in Tooltrim routing table`);
      }
      const conn = this.deps.upstream.connections.get(upstreamId);
      if (!conn) throw new Error(`upstream "${upstreamId}" is not connected`);
      return await conn.client.readResource({ uri });
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts = await this.collectPrompts();
      return { prompts };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const name = req.params.name;
      let route = this.promptRoute.get(name);
      if (!route) {
        await this.collectPrompts();
        route = this.promptRoute.get(name);
      }
      if (!route) {
        throw new Error(`prompt "${name}" not found in Tooltrim routing table`);
      }
      const conn = this.deps.upstream.connections.get(route.upstreamId);
      if (!conn) throw new Error(`upstream "${route.upstreamId}" is not connected`);
      return await conn.client.getPrompt({
        name: route.original,
        arguments: req.params.arguments,
      });
    });
  }

  /**
   * Fetch tool lists from every connected upstream, namespace+filter+shrink,
   * and return the merged list.
   */
  async collectTools(): Promise<unknown[]> {
    if (this.toolsCache && Date.now() - this.toolsCache.ts < this.TOOLS_CACHE_TTL_MS) {
      return this.toolsCache.tools;
    }
    if (this.toolsInflight) return this.toolsInflight;
    const pending = this.loadTools().finally(() => {
      this.toolsInflight = null;
    });
    this.toolsInflight = pending;
    return pending;
  }

  private async loadTools(): Promise<unknown[]> {
    this.toolRoute.clear();
    const out: Record<string, unknown>[] = [];
    const timeoutMs = this.deps.cfg.upstreamTimeoutMs ?? 30_000;
    const countTokens = this.deps.cfg.observability.metrics.prometheus.enabled
      ? (await import("./tokenizer.js")).countTokens
      : null;

    for (const [id, conn] of this.deps.upstream.connections) {
      if (conn.status !== "connected" || !conn.capabilities?.tools) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`upstream "${id}" tools/list timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        const result = await Promise.race([conn.client.listTools(), timeout]);
        clearTimeout(timer);
        const trimmed: Record<string, unknown>[] = [];
        for (const t of result.tools ?? []) {
          const namespaced = this.namespace(id, t.name);
          if (!this.deps.filter.isAllowed(namespaced, "tool")) continue;
          if (this.deps.cfg.policy.blockedTools.includes(namespaced)) continue;

          const cfg = this.deps.cfg.servers[id];
          const perToolMax = cfg && "shrink" in cfg ? cfg.shrink?.maxDescriptionChars : undefined;
          const shrunk = this.deps.shrinker.shrinkTool(
            {
              name: namespaced,
              description: t.description,
              inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              outputSchema: t.outputSchema as Record<string, unknown> | undefined,
            },
            perToolMax,
          );

          this.toolRoute.set(namespaced, {
            upstreamId: id,
            originalName: t.name,
          });
          const tool = {
            ...t,
            name: namespaced,
            description: shrunk.description,
            inputSchema: shrunk.inputSchema ?? t.inputSchema,
            ...(shrunk.outputSchema ? { outputSchema: shrunk.outputSchema } : {}),
          };
          trimmed.push(tool);
          out.push(tool);
        }
        if (countTokens) {
          const saved =
            countTokens(JSON.stringify(result.tools ?? [])) - countTokens(JSON.stringify(trimmed));
          this.deps.metrics?.setTokensSaved(id, Math.max(0, saved));
        }
      } catch (err) {
        clearTimeout(timer);
        this.log.warn({ id, err: errMsg(err) }, "upstream tools/list failed");
      }
    }
    this.toolsCache = { tools: out, ts: Date.now() };
    return out;
  }

  async collectResources(): Promise<unknown[]> {
    this.resourceRoute.clear();
    const out: unknown[] = [];
    for (const [id, conn] of this.deps.upstream.connections) {
      if (conn.status !== "connected" || !conn.capabilities?.resources) continue;
      try {
        const result = await conn.client.listResources();
        for (const r of result.resources ?? []) {
          const namespacedKey = this.namespace(id, r.name);
          if (!this.deps.filter.isAllowed(namespacedKey, "resource")) continue;
          if (this.resourceRoute.has(r.uri)) continue;
          this.resourceRoute.set(r.uri, id);
          out.push(r);
        }
      } catch (err) {
        this.log.warn({ id, err: errMsg(err) }, "upstream resources/list failed");
      }
    }
    return out;
  }

  async collectResourceTemplates(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const [id, conn] of this.deps.upstream.connections) {
      if (conn.status !== "connected" || !conn.capabilities?.resources) continue;
      try {
        const result = await conn.client.listResourceTemplates();
        for (const t of result.resourceTemplates ?? []) {
          const namespacedKey = this.namespace(id, t.name);
          if (!this.deps.filter.isAllowed(namespacedKey, "resource")) continue;
          out.push(t);
        }
      } catch (err) {
        this.log.debug({ id, err: errMsg(err) }, "resourceTemplates/list unsupported");
      }
    }
    return out;
  }

  async collectPrompts(): Promise<unknown[]> {
    this.promptRoute.clear();
    const out: Record<string, unknown>[] = [];
    for (const [id, conn] of this.deps.upstream.connections) {
      if (conn.status !== "connected" || !conn.capabilities?.prompts) continue;
      try {
        const result = await conn.client.listPrompts();
        for (const p of result.prompts ?? []) {
          const namespaced = this.namespace(id, p.name);
          if (!this.deps.filter.isAllowed(namespaced, "prompt")) continue;
          this.promptRoute.set(namespaced, { upstreamId: id, original: p.name });
          out.push({ ...p, name: namespaced });
        }
      } catch (err) {
        this.log.warn({ id, err: errMsg(err) }, "upstream prompts/list failed");
      }
    }
    return out;
  }

  /**
   * Inverse of {@link namespace}: splits the namespaced name back into
   * `(serverId, originalName)`. Returns `undefined` for unknown names.
   */
  resolveTool(namespaced: string): { upstreamId: string; originalName: string } | undefined {
    return this.toolRoute.get(namespaced);
  }

  private async recordAudit(
    upstream: string,
    tool: string,
    ok: boolean,
    durMs: number,
    err?: string,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.record({
        upstream,
        tool,
        ok,
        durMs,
        err,
        identity: getInboundContext()?.identity,
      });
    } catch (auditErr) {
      this.log.warn({ err: errMsg(auditErr) }, "audit write failed");
    }
  }

  private namespace(serverId: string, name: string): string {
    return `${serverId}${this.deps.cfg.namespaceSeparator}${name}`;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
