/**
 * Phase 3: round-trip latency, direct vs through Tooltrim.
 *
 * We compare four call paths over 100 samples each, after a short warmup:
 *   - direct  tools/list        (echo upstream, single Client)
 *   - direct  tools/call (echo) (everything.echo)
 *   - proxy   tools/list        (Tooltrim HTTP inbound)
 *   - proxy   tools/call (echo) (everything.echo via proxy)
 *
 * The deltas are what we care about: how much overhead does Tooltrim add?
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProxy, type ProxyHandle } from "../src/proxy.js";
import { loadConfig } from "../src/config/load.js";
import { configureLogger } from "../src/logger.js";
import { BENCH_HTTP_URL, PROXY_CONFIG_PATH, RESULTS_DIR, UPSTREAMS } from "./config.js";

const SAMPLES = Number(process.env.BENCH_LATENCY_SAMPLES ?? 100);
const WARMUP = 5;

export interface LatencyStats {
  mode: "direct" | "proxy";
  op: "tools/list" | "tools/call";
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface LatencyReport {
  samples: number;
  rows: LatencyStats[];
}

export async function runLatency(): Promise<LatencyReport> {
  configureLogger({ level: "warn", toStderr: true });
  const directs = await openDirectEverythingClient();
  process.stderr.write("[latency] booting Tooltrim proxy...\n");
  const proxy = await bootProxy();
  const proxyClient = await openProxyClient();

  const rows: LatencyStats[] = [];
  try {
    rows.push(await time("direct", "tools/list", () => directs.client.listTools()));
    rows.push(
      await time("direct", "tools/call", () =>
        directs.client.callTool({ name: "echo", arguments: { message: "hi" } }),
      ),
    );
    rows.push(await time("proxy", "tools/list", () => proxyClient.listTools()));
    rows.push(
      await time("proxy", "tools/call", () =>
        proxyClient.callTool({ name: "everything.echo", arguments: { message: "hi" } }),
      ),
    );
  } finally {
    await Promise.all([
      directs.client.close().catch(() => undefined),
      proxyClient.close().catch(() => undefined),
    ]);
    await proxy.close();
  }

  const report: LatencyReport = { samples: SAMPLES, rows };
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path.join(RESULTS_DIR, "latency.json"), JSON.stringify(report, null, 2), "utf8");
  printTable(report);
  return report;
}

async function time(
  mode: LatencyStats["mode"],
  op: LatencyStats["op"],
  fn: () => Promise<unknown>,
): Promise<LatencyStats> {
  process.stderr.write(`[latency] ${mode} ${op} (${WARMUP} warmup + ${SAMPLES} samples)... `);
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const stats: LatencyStats = {
    mode,
    op,
    samples: SAMPLES,
    p50: pct(samples, 0.5),
    p95: pct(samples, 0.95),
    p99: pct(samples, 0.99),
    max: samples[samples.length - 1] ?? 0,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
  process.stderr.write(
    `p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms p99=${stats.p99.toFixed(1)}ms\n`,
  );
  return stats;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

async function openDirectEverythingClient(): Promise<{ client: Client }> {
  const everything = UPSTREAMS.find((u) => u.id === "everything")!;
  const [command, ...args] = everything.command;
  if (!command) throw new Error("missing 'everything' upstream command");
  const transport = new StdioClientTransport({
    command,
    args,
    // SDK merges PATH/HOME. Copying process.env would leak API keys to printEnv.
    env: everything.env,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "tooltrim-bench-direct", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client };
}

async function openProxyClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(BENCH_HTTP_URL));
  const client = new Client(
    { name: "tooltrim-bench-proxy", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function bootProxy(): Promise<ProxyHandle> {
  const { config } = await loadConfig({ configPath: PROXY_CONFIG_PATH });
  // Latency phase always uses the unfiltered "all" config so we can call
  // `everything.echo` without it being denied.
  config.filters.allow = [];
  config.filters.deny = [];
  // Disable shrinking so any latency overhead isn't due to shrink CPU work.
  config.shrink.mode = "off";
  return runProxy({ cfg: config, disableInboundStdio: true });
}

function printTable(report: LatencyReport): void {
  const headers = ["Mode", "Op", "p50", "p95", "p99", "max", "mean"];
  const rows = report.rows.map((r) => [
    r.mode,
    r.op,
    `${r.p50.toFixed(1)} ms`,
    `${r.p95.toFixed(1)} ms`,
    `${r.p99.toFixed(1)} ms`,
    `${r.max.toFixed(1)} ms`,
    `${r.mean.toFixed(1)} ms`,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  process.stdout.write(`\n[latency] ${report.samples} samples per row\n`);
  process.stdout.write(fmt(headers) + "\n");
  process.stdout.write(widths.map((w) => "─".repeat(w)).join("  ") + "\n");
  for (const row of rows) process.stdout.write(fmt(row) + "\n");
}

if (process.argv[1]?.endsWith("latency.ts")) {
  runLatency().catch((err) => {
    process.stderr.write(`latency failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
