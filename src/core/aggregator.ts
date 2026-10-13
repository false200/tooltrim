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

// shortcut: 50 pages, raise if a real catalog is larger
const MAX_LIST_PAGES = 50;

// shortcut: {var} matches slashes too, revisit if templates differ only by RFC 6570 reserved chars
export function uriTemplateMatches(template: string, uri: string): boolean {
  let pattern = "^";
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) return false;
      pattern += ".*";
      i = end;
      continue;
    }
    pattern += template[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`).test(uri);
}

export function matchResourceTemplate(
  templates: ReadonlyArray<{ upstreamId: string; uriTemplate: string }>,
  uri: string,
): string | undefined {
  let best: { upstreamId: string; score: number } | undefined;
  for (const t of templates) {
    if (!uriTemplateMatches(t.uriTemplate, uri)) continue;
    const score = t.uriTemplate.replace(/\{[^}]*\}/g, "").length;
    if (!best || score > best.score) best = { upstreamId: t.upstreamId, score };
  }
  return best?.upstreamId;
}

/**
 * Follow an MCP list `nextCursor` until it stops.
 * A failure after the first page keeps the items already collected.
 */
export async function eachPage<T>(
  load: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<{ items: T[]; truncated: boolean; err?: string }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    let result: { items: T[]; nextCursor?: string };
    try {
      result = await load(cursor);
    } catch (err) {
      if (items.length === 0) throw err;
      return { items, truncated: true, err: err instanceof Error ? err.message : String(err) };
    }
    items.push(...result.items);
    if (!result.nextCursor || result.nextCursor === cursor) return { items, truncated: false };
    cursor = result.nextCursor;
  }
  return { items, truncated: true };
}

export function isBlockedTool(
  blocked: readonly string[],
  namespaced: string,
  original: string,
): boolean {
  return blocked.includes(namespaced) || blocked.includes(original);
}

/** Race `work` against a timer. A late rejection must not surface as unhandled. */
export async function raceTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  void work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function listStop(kind: string, err?: string): string {
  return err ? `${kind} stopped early` : `${kind} stopped after 50 pages`;
}

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
  private resourceTemplates: Array<{ upstreamId: string; uriTemplate: string }> = [];
  private resourcesListedAt = 0;
  private templatesListedAt = 0;
  /** Short-lived cache for collectTools() to debounce redundant fan-out. */
  private toolsCache: { tools: unknown[]; ts: number } | null = null;
  private toolsInflight: Promise<unknown[]> | null = null;
  private promptsInflight: Promise<unknown[]> | null = null;
  private resourcesInflight: Promise<unknown[]> | null = null;
  private templatesInflight: Promise<unknown[]> | null = null;
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
        `Tool names are namespaced as \`<server>${this.deps.cfg.namespaceSeparator}<tool>\`.`,
    });
    this.wireHandlers(server);
    return server;
  }

  /**
   * Pre-declare the union of capabilities we *might* expose. The actual list
   * is filtered live at `tools/list`, so this just unblocks the negotiation.
   */
  private computePlausibleCapabilities(): ServerCapabilities {
    // listChanged stays off: nothing emits list_changed, so clients must not wait for it.
    return {
      tools: {},
      resources: { subscribe: false },
      prompts: {},
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
      if (isBlockedTool(this.deps.cfg.policy.blockedTools, name, route.originalName)) {
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
      const upstreamId = await this.routeResource(uri);
      if (!upstreamId) {
        throw new Error(`resource "${uri}" not found in Tooltrim routing table`);
      }
      const conn = this.deps.upstream.connections.get(upstreamId);
      if (!conn || conn.status !== "connected") {
        throw new Error(`upstream "${upstreamId}" is not connected`);
      }
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
      if (!conn || conn.status !== "connected") {
        throw new Error(`upstream "${route.upstreamId}" is not connected`);
      }
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
    const countTokens = this.deps.cfg.observability.metrics.prometheus.enabled
      ? (await import("./tokenizer.js")).countTokens
      : null;

    const batches = await Promise.all(
      [...this.deps.upstream.connections].map(async ([id, conn]) => {
        if (conn.status !== "connected" || !conn.capabilities?.tools) return [];
        try {
          const {
            items: listed,
            truncated,
            err,
          } = await eachPage(async (cursor) => {
            const result = await this.callWithTimeout(
              id,
              "tools/list",
              conn.client.listTools(cursor ? { cursor } : undefined),
            );
            return { items: result.tools ?? [], nextCursor: result.nextCursor };
          });
          if (truncated) this.log.warn({ id, err }, listStop("tools/list", err));
          const trimmed: Array<{
            namespaced: string;
            route: ToolRouteEntry;
            tool: Record<string, unknown>;
          }> = [];
          const seen = new Set<string>();
          for (const t of listed) {
            const namespaced = this.namespace(id, t.name);
            if (seen.has(namespaced)) continue;
            seen.add(namespaced);
            if (!this.deps.filter.isAllowed(namespaced, "tool")) continue;
            if (isBlockedTool(this.deps.cfg.policy.blockedTools, namespaced, t.name)) continue;

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

            trimmed.push({
              namespaced,
              route: { upstreamId: id, originalName: t.name },
              tool: {
                ...t,
                name: namespaced,
                description: shrunk.description,
                inputSchema: shrunk.inputSchema ?? t.inputSchema,
                ...(shrunk.outputSchema ? { outputSchema: shrunk.outputSchema } : {}),
              },
            });
          }
          if (countTokens) {
            const saved =
              countTokens(JSON.stringify(listed)) -
              countTokens(JSON.stringify(trimmed.map((item) => item.tool)));
            this.deps.metrics?.setTokensSaved(id, Math.max(0, saved));
          }
          return trimmed;
        } catch (err) {
          this.log.warn({ id, err: errMsg(err) }, "upstream tools/list failed");
          return [];
        }
      }),
    );
    const nextRoute = new Map<string, ToolRouteEntry>();
    const out: unknown[] = [];
    for (const item of batches.flat()) {
      if (nextRoute.has(item.namespaced)) {
        this.log.warn({ name: item.namespaced }, "duplicate tool name; keeping the first");
        continue;
      }
      nextRoute.set(item.namespaced, item.route);
      out.push(item.tool);
    }
    this.toolRoute.clear();
    for (const [k, v] of nextRoute) this.toolRoute.set(k, v);
    this.toolsCache = { tools: out, ts: Date.now() };
    return out;
  }

  /**
   * Race an upstream call against the config timeout. A late rejection must not
   * become an unhandled rejection after the timeout already won.
   */
  private callWithTimeout<T>(id: string, method: string, work: Promise<T>): Promise<T> {
    const timeoutMs = this.deps.cfg.upstreamTimeoutMs ?? 30_000;
    return raceTimeout(
      work,
      timeoutMs,
      `upstream "${id}" ${method} timed out after ${timeoutMs}ms`,
    );
  }

  /**
   * Concrete `resources/list` hits win. A miss falls through to a resource
   * template (`file://{path}`), which is how filesystem servers expose reads.
   */
  async routeResource(uri: string): Promise<string | undefined> {
    const fresh = (ts: number) => Date.now() - ts < this.TOOLS_CACHE_TTL_MS;
    if (!fresh(this.resourcesListedAt)) await this.collectResources();
    const listed = this.resourceRoute.get(uri);
    if (listed) return listed;
    if (!fresh(this.templatesListedAt)) await this.collectResourceTemplates();
    return matchResourceTemplate(this.resourceTemplates, uri);
  }

  async collectResources(): Promise<unknown[]> {
    if (this.resourcesInflight) return this.resourcesInflight;
    const pending = this.loadResources().finally(() => {
      this.resourcesInflight = null;
    });
    this.resourcesInflight = pending;
    return pending;
  }

  private async loadResources(): Promise<unknown[]> {
    const groups = await Promise.all(
      [...this.deps.upstream.connections].map(async ([id, conn]) => {
        if (conn.status !== "connected" || !conn.capabilities?.resources) return [];
        try {
          const { items, truncated, err } = await eachPage(async (cursor) => {
            const result = await this.callWithTimeout(
              id,
              "resources/list",
              conn.client.listResources(cursor ? { cursor } : undefined),
            );
            return { items: result.resources ?? [], nextCursor: result.nextCursor };
          });
          if (truncated) this.log.warn({ id, err }, listStop("resources/list", err));
          return items.map((r) => ({ id, resource: r }));
        } catch (err) {
          this.log.warn({ id, err: errMsg(err) }, "upstream resources/list failed");
          return [];
        }
      }),
    );
    const next = new Map<string, string>();
    const out: unknown[] = [];
    for (const group of groups) {
      for (const { id, resource: r } of group) {
        const namespacedKey = this.namespace(id, r.name);
        if (!this.deps.filter.isAllowed(namespacedKey, "resource")) continue;
        const kept = next.get(r.uri);
        if (kept) {
          if (kept !== id) {
            this.log.warn(
              { uri: r.uri, kept, skipped: id },
              "duplicate resource uri; keeping the first",
            );
          }
          continue;
        }
        next.set(r.uri, id);
        out.push({ ...r, name: namespacedKey });
      }
    }
    this.resourceRoute.clear();
    for (const [k, v] of next) this.resourceRoute.set(k, v);
    this.resourcesListedAt = Date.now();
    return out;
  }

  async collectResourceTemplates(): Promise<unknown[]> {
    if (this.templatesInflight) return this.templatesInflight;
    const pending = this.loadResourceTemplates().finally(() => {
      this.templatesInflight = null;
    });
    this.templatesInflight = pending;
    return pending;
  }

  private async loadResourceTemplates(): Promise<unknown[]> {
    const groups = await Promise.all(
      [...this.deps.upstream.connections].map(async ([id, conn]) => {
        if (conn.status !== "connected" || !conn.capabilities?.resources) return [];
        try {
          const { items, truncated, err } = await eachPage(async (cursor) => {
            const result = await this.callWithTimeout(
              id,
              "resources/templates/list",
              conn.client.listResourceTemplates(cursor ? { cursor } : undefined),
            );
            return { items: result.resourceTemplates ?? [], nextCursor: result.nextCursor };
          });
          if (truncated) this.log.warn({ id, err }, listStop("resources/templates/list", err));
          return items
            .filter(
              (t) =>
                Boolean(t.uriTemplate) &&
                this.deps.filter.isAllowed(this.namespace(id, t.name), "resource"),
            )
            .map((t) => ({
              upstreamId: id,
              uriTemplate: t.uriTemplate,
              template: { ...t, name: this.namespace(id, t.name) },
            }));
        } catch (err) {
          this.log.debug({ id, err: errMsg(err) }, "resourceTemplates/list unsupported");
          return [];
        }
      }),
    );
    const flat = groups.flat();
    this.resourceTemplates = flat.map(({ upstreamId, uriTemplate }) => ({
      upstreamId,
      uriTemplate,
    }));
    this.templatesListedAt = Date.now();
    return flat.map((item) => item.template);
  }

  async collectPrompts(): Promise<unknown[]> {
    if (this.promptsInflight) return this.promptsInflight;
    const pending = this.loadPrompts().finally(() => {
      this.promptsInflight = null;
    });
    this.promptsInflight = pending;
    return pending;
  }

  private async loadPrompts(): Promise<unknown[]> {
    const groups = await Promise.all(
      [...this.deps.upstream.connections].map(async ([id, conn]) => {
        if (conn.status !== "connected" || !conn.capabilities?.prompts) return [];
        try {
          const { items, truncated, err } = await eachPage(async (cursor) => {
            const result = await this.callWithTimeout(
              id,
              "prompts/list",
              conn.client.listPrompts(cursor ? { cursor } : undefined),
            );
            return { items: result.prompts ?? [], nextCursor: result.nextCursor };
          });
          if (truncated) this.log.warn({ id, err }, listStop("prompts/list", err));
          const out: Array<{
            namespaced: string;
            route: { upstreamId: string; original: string };
            prompt: Record<string, unknown>;
          }> = [];
          const seen = new Set<string>();
          for (const p of items) {
            const namespaced = this.namespace(id, p.name);
            if (seen.has(namespaced)) continue;
            seen.add(namespaced);
            if (!this.deps.filter.isAllowed(namespaced, "prompt")) continue;
            out.push({
              namespaced,
              route: { upstreamId: id, original: p.name },
              prompt: { ...p, name: namespaced },
            });
          }
          return out;
        } catch (err) {
          this.log.warn({ id, err: errMsg(err) }, "upstream prompts/list failed");
          return [];
        }
      }),
    );
    const next = new Map<string, { upstreamId: string; original: string }>();
    const out: unknown[] = [];
    for (const item of groups.flat()) {
      if (next.has(item.namespaced)) {
        this.log.warn({ name: item.namespaced }, "duplicate prompt name; keeping the first");
        continue;
      }
      next.set(item.namespaced, item.route);
      out.push(item.prompt);
    }
    this.promptRoute.clear();
    for (const [k, v] of next) this.promptRoute.set(k, v);
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
