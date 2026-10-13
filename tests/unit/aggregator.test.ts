import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import {
  Aggregator,
  matchResourceTemplate,
  uriTemplateMatches,
} from "../../src/core/aggregator.js";
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

function aggregator(cfg: TooltrimConfig, conns: UpstreamConnection[]): Aggregator {
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
    const resources = (await agg.collectResources()) as Array<{
      name?: string;
      description?: string;
    }>;
    expect(resources).toHaveLength(1);
    expect(resources[0]?.name).toBe("a.readme");
    expect(resources[0]?.description).toBe("from-a");
  });

  it("routes an unlisted uri through the most specific template", async () => {
    const cfg = cfgFor(["wide", "fs"]);
    const agg = aggregator(cfg, [
      fakeConn(
        "wide",
        {
          listResources: async () => ({ resources: [] }),
          listResourceTemplates: async () => ({
            resourceTemplates: [{ name: "any", uriTemplate: "file://{path}" }],
          }),
        },
        { resources: {} },
      ),
      fakeConn(
        "fs",
        {
          listResources: async () => ({ resources: [] }),
          listResourceTemplates: async () => ({
            resourceTemplates: [{ name: "file", uriTemplate: "file:///tmp/{name}" }],
          }),
        },
        { resources: {} },
      ),
    ]);
    expect(await agg.routeResource("file:///tmp/a")).toBe("fs");
    expect(await agg.routeResource("file:///etc/passwd")).toBe("wide");
    expect(await agg.routeResource("mem://nope")).toBeUndefined();
  });

  it("does not route a read through a denied template", async () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: { secret: { transport: "stdio", command: ["node"] } },
      filters: { deny: ["secret.*"] },
      shrink: { mode: "off", cachePath: "" },
      observability: { trace: { sink: "off" } },
      logLevel: "silent",
    });
    const agg = aggregator(cfg, [
      fakeConn(
        "secret",
        {
          listResources: async () => ({ resources: [] }),
          listResourceTemplates: async () => ({
            resourceTemplates: [{ name: "keys", uriTemplate: "secret://{id}" }],
          }),
        },
        { resources: {} },
      ),
    ]);
    expect(await agg.routeResource("secret://abc")).toBeUndefined();
  });

  it("prefers a listed resource over a template", async () => {
    const cfg = cfgFor(["a", "b"]);
    const agg = aggregator(cfg, [
      fakeConn(
        "a",
        {
          listResources: async () => ({
            resources: [{ uri: "mem://hello", name: "hello" }],
          }),
          listResourceTemplates: async () => ({ resourceTemplates: [] }),
        },
        { resources: {} },
      ),
      fakeConn(
        "b",
        {
          listResources: async () => ({ resources: [] }),
          listResourceTemplates: async () => ({
            resourceTemplates: [{ name: "mem", uriTemplate: "mem://{id}" }],
          }),
        },
        { resources: {} },
      ),
    ]);
    expect(await agg.routeResource("mem://hello")).toBe("a");
  });

  it("matches templates without treating dots as wildcards", () => {
    expect(uriTemplateMatches("https://example.com/{id}", "https://example.com/a")).toBe(true);
    expect(uriTemplateMatches("https://example.com/{id}", "https://exampleXcom/a")).toBe(false);
    expect(
      matchResourceTemplate(
        [
          { upstreamId: "wide", uriTemplate: "{path}" },
          { upstreamId: "fs", uriTemplate: "file://{path}" },
        ],
        "file:///tmp/a",
      ),
    ).toBe("fs");
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
    expect(templates.map((t) => t.name)).toEqual(["pub.docs"]);
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

  it("keeps tools from earlier pages when a later page fails", async () => {
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
            throw new Error("page exploded");
          },
        },
        { tools: {} },
      ),
    ]);
    const tools = (await agg.collectTools()) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["gh.one"]);
  });

  it("keeps the first tool when namespaced names collide", async () => {
    const cfg = cfgFor(["git", "git-hub"]);
    cfg.namespaceSeparator = "-";
    const agg = aggregator(cfg, [
      fakeConn(
        "git",
        {
          listTools: async () => ({
            tools: [{ name: "hub-echo", description: "from-git", inputSchema: { type: "object" } }],
          }),
        },
        { tools: {} },
      ),
      fakeConn(
        "git-hub",
        {
          listTools: async () => ({
            tools: [{ name: "echo", description: "from-hub", inputSchema: { type: "object" } }],
          }),
        },
        { tools: {} },
      ),
    ]);
    const tools = (await agg.collectTools()) as Array<{ name: string; description?: string }>;
    expect(tools.map((t) => t.name)).toEqual(["git-hub-echo"]);
    expect(tools[0]?.description).toBe("from-git");
    expect(agg.resolveTool("git-hub-echo")).toEqual({
      upstreamId: "git",
      originalName: "hub-echo",
    });
  });

  it("hides a tool blocked by its original name", async () => {
    const cfg = cfgFor(["gh"], { defaultAuth: "none", blockedTools: ["delete_repo"] });
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

  it("fans out prompts/list once when two callers overlap", async () => {
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
          listPrompts: async () => {
            calls += 1;
            await gate;
            return { prompts: [{ name: "greet" }] };
          },
        },
        { prompts: {} },
      ),
    ]);
    const pending = Promise.all([agg.collectPrompts(), agg.collectPrompts()]);
    release();
    const [a, b] = await pending;
    expect(calls).toBe(1);
    expect(a).toBe(b);
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
