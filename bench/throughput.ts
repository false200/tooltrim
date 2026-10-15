/**
 * Phase 4: parallel throughput against the proxy.
 *
 * Fires N concurrent `tools/call` requests at `everything.echo` and records
 * total time, error count, and ops/sec. The Streamable HTTP transport is
 * stateless in the proxy, so this also exercises that the per-request Server
 * factory in src/server/http.ts holds up under fan-out.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProxy, type ProxyHandle } from "../src/proxy.js";
import { configureLogger } from "../src/logger.js";
import { BENCH_HTTP_URL, loadBenchProxyConfig, RESULTS_DIR } from "./config.js";

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 50);

export interface ThroughputReport {
  concurrency: number;
  totalMs: number;
  errors: number;
  opsPerSec: number;
  perCallMeanMs: number;
}

export async function runThroughput(): Promise<ThroughputReport> {
  configureLogger({ level: "warn", toStderr: true });
  process.stderr.write(`[throughput] booting Tooltrim proxy...\n`);
  const proxy = await bootProxy();
  // Fresh client per "request" mirrors how multiple browser tabs / sidecar
  // agents would each open their own MCP HTTP session against the proxy.
  // We pre-open them so the timer measures actual call concurrency, not
  // connection setup cost.
  process.stderr.write(`[throughput] opening ${CONCURRENCY} parallel clients...\n`);
  const clients: Client[] = [];
  try {
    for (let i = 0; i < CONCURRENCY; i++) {
      clients.push(await openClient());
    }
    // Warm the routing table so the first call doesn't pay the lazy-listing tax.
    await clients[0]!.callTool({ name: "everything.echo", arguments: { message: "warmup" } });

    process.stderr.write(`[throughput] firing ${CONCURRENCY} parallel calls...\n`);
    const start = performance.now();
    let errors = 0;
    const results = await Promise.all(
      clients.map(async (c, i) => {
        try {
          await c.callTool({ name: "everything.echo", arguments: { message: `req-${i}` } });
          return true;
        } catch (err) {
          process.stderr.write(`[throughput] error: ${(err as Error).message}\n`);
          errors++;
          return false;
        }
      }),
    );
    const totalMs = performance.now() - start;
    const ok = results.filter(Boolean).length;
    const opsPerSec = (ok / totalMs) * 1000;

    const report: ThroughputReport = {
      concurrency: CONCURRENCY,
      totalMs,
      errors,
      opsPerSec,
      perCallMeanMs: totalMs / Math.max(1, ok),
    };
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      path.join(RESULTS_DIR, "throughput.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );
    // Scrape Prometheus while the proxy still has hot metrics. The report
    // section embeds an excerpt so observability claims are auditable, not
    // theoretical.
    await snapshotMetrics().catch((err) => {
      process.stderr.write(`[throughput] metrics scrape failed: ${(err as Error).message}\n`);
    });
    printReport(report);
    return report;
  } finally {
    for (const c of clients) {
      await c.close().catch(() => undefined);
    }
    await proxy.close();
  }
}

async function bootProxy(): Promise<ProxyHandle> {
  const config = await loadBenchProxyConfig();
  config.filters.allow = [];
  config.filters.deny = [];
  config.shrink.mode = "off";
  return runProxy({ cfg: config, disableInboundStdio: true });
}

async function openClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(BENCH_HTTP_URL));
  const client = new Client(
    { name: "tooltrim-bench-throughput", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function snapshotMetrics(): Promise<void> {
  const url = "http://127.0.0.1:9464/metrics";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`metrics endpoint returned ${res.status}`);
  }
  const body = await res.text();
  // Only keep tooltrim_* counters/gauges + tail of histogram buckets that
  // matter for a report excerpt; drops 80% of the noise.
  const keep = body
    .split("\n")
    .filter((line) => {
      if (!line.startsWith("tooltrim_")) return false;
      // Skip noisy bucket rows except for a couple of representative ones.
      if (line.includes("_bucket") && !/le="(5|25|100|250)"/.test(line)) return false;
      return true;
    })
    .slice(0, 80)
    .join("\n");
  await writeFile(path.join(RESULTS_DIR, "metrics-snapshot.txt"), keep, "utf8");
}

function printReport(r: ThroughputReport): void {
  process.stdout.write(
    `\n[throughput] ${r.concurrency} concurrent tools/call against everything.echo\n`,
  );
  process.stdout.write(`Total time     ${r.totalMs.toFixed(1)} ms\n`);
  process.stdout.write(`Errors         ${r.errors}\n`);
  process.stdout.write(`Ops/sec        ${r.opsPerSec.toFixed(1)}\n`);
  process.stdout.write(`Per-call mean  ${r.perCallMeanMs.toFixed(2)} ms\n`);
}

if (process.argv[1]?.endsWith("throughput.ts")) {
  runThroughput().catch((err) => {
    process.stderr.write(`throughput failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
