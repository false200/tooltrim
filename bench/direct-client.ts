/**
 * Direct fan-out MCP client — the "naive enterprise setup" baseline.
 *
 * Mimics what an LLM agent does when it talks to N MCP servers without a
 * proxy: open one Client per upstream, namespace their tools as `<id>.<name>`
 * so the agent can disambiguate, route a callTool by splitting on the first
 * dot. The agent loop in bench/agent.ts treats this as a drop-in for the
 * proxy's single Client so the prompts are identical.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UPSTREAMS, type UpstreamSpec } from "./config.js";

export interface DirectFanOutOptions {
  /** If provided, only spawn upstreams whose id is in this list. */
  only?: string[];
}

export class DirectFanOutClient {
  private readonly clients = new Map<string, Client>();

  /** Connect to every (selected) upstream. Skips github when GITHUB_TOKEN is missing. */
  static async open(options: DirectFanOutOptions = {}): Promise<DirectFanOutClient> {
    const inst = new DirectFanOutClient();
    const targets = options.only
      ? UPSTREAMS.filter((u) => options.only!.includes(u.id))
      : UPSTREAMS;
    for (const u of targets) {
      if (u.needsGithubToken && !process.env.GITHUB_TOKEN) {
        process.stderr.write(`[direct] skipping ${u.id} (no GITHUB_TOKEN)\n`);
        continue;
      }
      const client = await connectStdio(u);
      inst.clients.set(u.id, client);
    }
    return inst;
  }

  /** List every upstream's tools, prefixed with `<id>.`. Same name-shape as Tooltrim. */
  async listTools(): Promise<Tool[]> {
    const merged: Tool[] = [];
    for (const [id, client] of this.clients) {
      const list = await client.listTools();
      for (const t of list.tools ?? []) {
        merged.push({ ...t, name: `${id}.${t.name}` });
      }
    }
    return merged;
  }

  /** Route a call by splitting `<id>.<name>`, then strip the prefix for the upstream. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const dot = name.indexOf(".");
    if (dot < 0) throw new Error(`direct fan-out requires <upstream>.<tool>, got ${name}`);
    const id = name.slice(0, dot);
    const tool = name.slice(dot + 1);
    const client = this.clients.get(id);
    if (!client) throw new Error(`unknown upstream id ${id}`);
    return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) {
      await c.close().catch(() => undefined);
    }
    this.clients.clear();
  }

  get upstreamIds(): string[] {
    return [...this.clients.keys()];
  }
}

async function connectStdio(spec: UpstreamSpec): Promise<Client> {
  const [command, ...args] = spec.command;
  if (!command) throw new Error(`empty command for upstream ${spec.id}`);
  const transport = new StdioClientTransport({
    command,
    args,
    // SDK merges PATH/HOME. Copying process.env would leak API keys to printEnv.
    env: spec.env,
    stderr: "pipe",
  });
  const client = new Client(
    { name: `tooltrim-bench-direct-${spec.id}`, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}
