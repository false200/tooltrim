import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runProxy } from "../../src/proxy.js";
import { buildTestConfig, echoStdioConfig } from "../helpers.js";

interface ProxyHarness {
  close: () => Promise<void>;
  client: Client;
  url: string;
}

let harnesses: ProxyHarness[] = [];

beforeEach(() => {
  harnesses = [];
});

afterEach(async () => {
  for (const h of harnesses) {
    try {
      await h.client.close();
    } catch {
      // ignore
    }
    await h.close();
  }
  harnesses = [];
});

async function startHarness(opts: {
  servers: Record<string, ReturnType<typeof echoStdioConfig>>;
  filters?: { allow?: string[]; deny?: string[] };
  shrink?: { mode?: "off" | "rules" | "llm" };
  policy?: { blockedTools?: string[] };
  auditPath?: string;
}): Promise<ProxyHarness> {
  const cfg = buildTestConfig({
    servers: opts.servers,
    filters: opts.filters,
    shrink: opts.shrink,
    policy: opts.policy,
    auditPath: opts.auditPath,
    inboundHttp: true,
  });
  // Port 0 → OS picks a free port. Random high ports flake on Windows CI (EACCES).
  cfg.inbound.http.port = 0;
  cfg.inbound.http.host = "127.0.0.1";
  const handle = await runProxy({ cfg, disableInboundStdio: true });
  const port = handle.httpPort;
  if (!port) throw new Error("proxy HTTP port not available");

  const url = `http://127.0.0.1:${port}/mcp`;
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);

  const harness: ProxyHarness = { close: handle.close, client, url };
  harnesses.push(harness);
  return harness;
}

describe.sequential("end-to-end proxy", () => {
  it(
    "merges tool lists from two upstream stdio servers under namespaced names",
    async () => {
      const h = await startHarness({
        servers: {
          a: echoStdioConfig("a"),
          b: echoStdioConfig("b"),
        },
        shrink: { mode: "off" },
      });
      const result = await h.client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toContain("a.echo");
      expect(names).toContain("a.add");
      expect(names).toContain("b.echo");
      expect(names).toContain("b.add");
    },
    30_000,
  );

  it(
    "routes tools/call to the right upstream",
    async () => {
      const h = await startHarness({
        servers: { a: echoStdioConfig("a"), b: echoStdioConfig("b") },
        shrink: { mode: "off" },
      });
      const out = await h.client.callTool({ name: "a.echo", arguments: { text: "hi" } });
      const text = (out.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(text).toBe("hi");

      const sum = await h.client.callTool({ name: "b.add", arguments: { a: 2, b: 3 } });
      const sumText = (sum.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(sumText).toBe("5");
    },
    30_000,
  );

  it(
    "filters tools according to allow/deny",
    async () => {
      const h = await startHarness({
        servers: { a: echoStdioConfig("a") },
        filters: { allow: ["a.echo", "a.add"], deny: ["a.delete_*"] },
        shrink: { mode: "off" },
      });
      const result = await h.client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["a.add", "a.echo"]);
    },
    30_000,
  );

  it(
    "rejects calls to filtered-out tools",
    async () => {
      const h = await startHarness({
        servers: { a: echoStdioConfig("a") },
        filters: { allow: ["a.echo"], deny: [] },
        shrink: { mode: "off" },
      });
      await expect(
        h.client.callTool({ name: "a.delete_thing", arguments: { id: "x" } }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    "shrinks descriptions when mode is rules",
    async () => {
      const h = await startHarness({
        servers: { a: echoStdioConfig("a") },
        shrink: { mode: "rules" },
      });
      const result = await h.client.listTools();
      const echo = result.tools.find((t) => t.name === "a.echo");
      expect(echo?.description).toBeTruthy();
      expect(echo?.description ?? "").not.toContain("Returns a JSON object containing");
      expect(echo?.description ?? "").not.toMatch(/^this tool/i);
    },
    30_000,
  );

  it(
    "exposes prompts and resources from upstream",
    async () => {
      const h = await startHarness({
        servers: { a: echoStdioConfig("a") },
        shrink: { mode: "off" },
      });
      const prompts = await h.client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toContain("a.greet");

      const resources = await h.client.listResources();
      expect(resources.resources.map((r) => r.uri)).toContain("mem://hello");

      const read = await h.client.readResource({ uri: "mem://hello" });
      const c = (read.contents as Array<{ text?: string }>)[0];
      expect(c?.text).toBe("hello world");
    },
    30_000,
  );

  it(
    "hides blocked tools and writes an audit line for a call",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-proxy-"));
      const auditPath = path.join(dir, "audit.ndjson");
      try {
        const h = await startHarness({
          servers: { a: echoStdioConfig("a") },
          shrink: { mode: "off" },
          policy: { blockedTools: ["a.delete_thing"] },
          auditPath,
        });
        const names = (await h.client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("a.echo");
        expect(names).not.toContain("a.delete_thing");
        await h.client.callTool({ name: "a.echo", arguments: { text: "hi" } });
        const audit = await readFile(auditPath, "utf8");
        expect(audit).toContain('"tool":"a.echo"');
        expect(audit).toContain('"ok":true');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
