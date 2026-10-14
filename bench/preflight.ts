/**
 * Spawn each upstream MCP server, perform `initialize`, list tools, and
 * record the resolved version + tool count. Aborts cleanly on the first
 * failure so the user sees a clear "this PAT is wrong" or "this package
 * isn't installed" message.
 *
 * Output: bench/results/versions.json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RESULTS_DIR, SANDBOX_DIR, UPSTREAMS } from "./config.js";

interface Probe {
  id: string;
  ok: boolean;
  pkg: string;
  serverName?: string;
  serverVersion?: string;
  toolCount?: number;
  err?: string;
  ms?: number;
}

async function main(): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  await mkdir(SANDBOX_DIR, { recursive: true });

  const probes: Probe[] = [];
  let allOk = true;

  for (const u of UPSTREAMS) {
    const pkg = u.command.find((a) => a.startsWith("@modelcontextprotocol/")) ?? u.command.join(" ");
    const probe: Probe = { id: u.id, ok: false, pkg };

    if (u.needsGithubToken && !process.env.GITHUB_TOKEN) {
      probe.err = "GITHUB_TOKEN not set; skipping (set it to enable the github upstream)";
      probes.push(probe);
      process.stderr.write(`[preflight] ${u.id}: SKIP (no GITHUB_TOKEN)\n`);
      continue;
    }

    process.stderr.write(`[preflight] ${u.id}: spawning ${pkg} ... `);
    const start = Date.now();
    const [command, ...args] = u.command;
    if (!command) {
      probe.err = "empty command";
      probes.push(probe);
      allOk = false;
      continue;
    }

    const transport = new StdioClientTransport({
      command,
      args,
      // SDK merges PATH/HOME. Copying process.env would leak API keys to printEnv.
      env: u.env,
      stderr: "pipe",
    });
    const client = new Client({ name: "tooltrim-bench-preflight", version: "0.1.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const info = client.getServerVersion();
      const list = await client.listTools();
      probe.ok = true;
      if (info?.name) probe.serverName = info.name;
      if (info?.version) probe.serverVersion = info.version;
      probe.toolCount = list.tools?.length ?? 0;
      probe.ms = Date.now() - start;
      process.stderr.write(`OK (${probe.toolCount} tools, ${probe.ms}ms)\n`);
    } catch (err) {
      probe.err = err instanceof Error ? err.message : String(err);
      probe.ms = Date.now() - start;
      allOk = false;
      process.stderr.write(`FAIL: ${probe.err}\n`);
    } finally {
      await client.close().catch(() => undefined);
    }

    probes.push(probe);
  }

  const out = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    probes,
  };
  await writeFile(
    path.join(RESULTS_DIR, "versions.json"),
    JSON.stringify(out, null, 2),
    "utf8",
  );

  process.stderr.write(`\nWrote ${path.join(RESULTS_DIR, "versions.json")}\n`);
  if (!allOk) {
    process.stderr.write("\nOne or more upstreams failed to start. Fix the errors above before running the full benchmark.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`preflight crashed: ${(err as Error).message}\n`);
  process.exit(1);
});
