import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { Aggregator } from "../../src/core/aggregator.js";
import { ToolFilter } from "../../src/core/filter.js";
import { Shrinker } from "../../src/core/shrinker.js";
import { tooltrimConfigSchema, type TooltrimConfig } from "../../src/config/schema.js";
import type { UpstreamConnection, UpstreamStatus } from "../../src/upstream/types.js";
import type { UpstreamManager } from "../../src/upstream/manager.js";

function cfgFor(ids: string[], policy?: TooltrimConfig["policy"]): TooltrimConfig {
  return tooltrimConfigSchema.parse({
    servers: Object.fromEntries(ids.map((id) => [id, { transport: "stdio", command: ["node"] }])),
    shrink: { mode: "off", cachePath: "" },
    observability: { trace: { sink: "off" } },
    logLevel: "silent",
    policy,
  });
}

function fakeConn(
  id: string,
  client: Partial<Client>,
  capabilities: UpstreamConnection["capabilities"],
): UpstreamConnection {
  return {
    id,
    client: client as Client,
    status: "connected" satisfies UpstreamStatus,
    capabilities,
  };
}

function aggregator(
  cfg: TooltrimConfig,
  conns: UpstreamConnection[],
): Aggregator {
  const connections = new Map(conns.map((c) => [c.id, c]));
  return new Aggregator({
    cfg,
    upstream: { connections } as unknown as UpstreamManager,
    filter: ToolFilter.fromConfig(cfg),
    shrinker: Shrinker.fromConfig(cfg),
  });
}

describe("Aggregator listings", () => {
  it("hides blocked tools", async () => {
    const cfg = cfgFor(["gh"], { defaultAuth: "none", blockedTools: ["gh.delete_repo"] });
    const agg = aggregator(cfg, [
      fakeConn(
        "gh",
        {
          listTools: async () => ({
            tools: [
              { name: "delete_repo", description: "x", inputSchema: { type: "object" } },
              { name: "search", description: "x", inputSchema: { type: "object" } },
            ],
          }),
        },
        { tools: {} },
      ),
    ]);
    const tools = (await agg.collectTools()) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["gh.search"]);
  });

  it("keeps the first resource when two upstreams share a uri", async () => {
    const cfg = cfgFor(["a", "b"]);
    const resource = (name: string, text: string) => ({
      uri: "file:///README.md",
      name,
      description: text,
    });
    const agg = aggregator(cfg, [
      fakeConn(
        "a",
        { listResources: async () => ({ resources: [resource("readme", "from-a")] }) },
        { resources: {} },
      ),
      fakeConn(
        "b",
        { listResources: async () => ({ resources: [resource("readme", "from-b")] }) },
        { resources: {} },
      ),
    ]);
    const resources = (await agg.collectResources()) as Array<{ description?: string }>;
    expect(resources).toHaveLength(1);
    expect(resources[0]?.description).toBe("from-a");
  });

  it("filters resource templates with the resource rules", async () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: {
        secret: { transport: "stdio", command: ["node"] },
        pub: { transport: "stdio", command: ["node"] },
      },
      filters: { deny: ["secret.*"] },
      shrink: { mode: "off", cachePath: "" },
      observability: { trace: { sink: "off" } },
      logLevel: "silent",
    });
    const agg = aggregator(cfg, [
      fakeConn(
        "secret",
        {
          listResourceTemplates: async () => ({
            resourceTemplates: [{ name: "keys", uriTemplate: "secret://{id}" }],
          }),
        },
        { resources: {} },
      ),
      fakeConn(
        "pub",
        {
          listResourceTemplates: async () => ({
            resourceTemplates: [{ name: "docs", uriTemplate: "docs://{id}" }],
          }),
        },
        { resources: {} },
      ),
    ]);
    const templates = (await agg.collectResourceTemplates()) as Array<{ name: string }>;
    expect(templates.map((t) => t.name)).toEqual(["docs"]);
  });

  it("fans out tools/list once when two callers overlap", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cfg = cfgFor(["gh"]);
    const agg = aggregator(cfg, [
      fakeConn(
        "gh",
        {
          listTools: async () => {
            calls += 1;
            await gate;
            return { tools: [{ name: "echo", description: "x", inputSchema: { type: "object" } }] };
          },
        },
        { tools: {} },
      ),
    ]);
    const pending = Promise.all([agg.collectTools(), agg.collectTools()]);
    release();
    const [a, b] = await pending;
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("follows tools/list cursors", async () => {
    const cfg = cfgFor(["gh"]);
    const agg = aggregator(cfg, [
      fakeConn(
        "gh",
        {
          listTools: async (params?: { cursor?: string }) => {
            if (!params?.cursor) {
              return {
                tools: [{ name: "one", description: "x", inputSchema: { type: "object" } }],
                nextCursor: "p2",
              };
            }
            return {
              tools: [{ name: "two", description: "x", inputSchema: { type: "object" } }],
            };
          },
        },
        { tools: {} },
      ),
    ]);
    const tools = (await agg.collectTools()) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["gh.one", "gh.two"]);
  });

  it("stops a tools/list cursor that never ends", async () => {
    let calls = 0;
    const cfg = cfgFor(["gh"]);
    const agg = aggregator(cfg, [
      fakeConn(
        "gh",
        {
          listTools: async () => {
            calls += 1;
            return {
              tools: [{ name: `t${calls}`, description: "x", inputSchema: { type: "object" } }],
              nextCursor: `p${calls}`,
            };
          },
        },
        { tools: {} },
      ),
    ]);
    const tools = (await agg.collectTools()) as Array<{ name: string }>;
    expect(calls).toBe(50);
    expect(tools).toHaveLength(50);
  });

  it("swallows a tools/list failure that arrives after the timeout", async () => {
    const cfg = cfgFor(["gh"]);
    cfg.upstreamTimeoutMs = 20;
    let rejectList: (err: Error) => void = () => undefined;
    const agg = aggregator(cfg, [
      fakeConn(
        "gh",
        {
          listTools: () =>
            new Promise((_, reject) => {
              rejectList = reject;
            }),
        },
        { tools: {} },
      ),
    ]);
    await expect(agg.collectTools()).resolves.toEqual([]);
    rejectList(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 20));
  });
});
