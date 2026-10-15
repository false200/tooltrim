/**
 * Phase 2 of the benchmark: token-savings table across filter scenarios.
 *
 * We boot the upstreams once via UpstreamManager, then for each scenario we
 * spin up a fresh Aggregator with a different (Filter, Shrinker) pair and
 * call `collectTools()` to get the merged + filtered + shrunk tool list.
 * Each pass records bytes and tokens for the JSON-stringified `tools` array,
 * which is what the LLM actually sees in its context window.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Aggregator } from "../src/core/aggregator.js";
import { ToolFilter } from "../src/core/filter.js";
import { Shrinker } from "../src/core/shrinker.js";
import { byteLength, countTokens } from "../src/core/tokenizer.js";
import type { TooltrimConfig } from "../src/config/schema.js";
import { UpstreamManager } from "../src/upstream/manager.js";
import { configureLogger } from "../src/logger.js";
import { loadBenchProxyConfig, RESULTS_DIR, SCENARIOS } from "./config.js";

export interface MeasureRow {
  scenario: string;
  filterAllow: number;
  filterDeny: number;
  shrink: "off" | "rules";
  toolCount: number;
  bytes: number;
  tokens: number;
}

export interface MeasureReport {
  baselineBytes: number;
  baselineTokens: number;
  baselineToolCount: number;
  rows: MeasureRow[];
}

export async function runMeasureScenarios(): Promise<MeasureReport> {
  configureLogger({ level: "warn", toStderr: true });
  process.stderr.write("[measure] loading config...\n");
  const config = await loadBenchProxyConfig();

  const upstream = new UpstreamManager(config);
  process.stderr.write("[measure] connecting upstreams...\n");
  await upstream.connectAll();
  const connected = [...upstream.connections.values()].filter((c) => c.status === "connected");
  process.stderr.write(`[measure] ${connected.length}/${upstream.connections.size} upstreams ready\n`);

  const rows: MeasureRow[] = [];
  try {
    // Pass 1: raw baseline — no filter, no shrink. This is what naive
    // multi-upstream setups put in the LLM's context window today.
    rows.push(
      await measureOnce(config, upstream, "all (raw)", { allow: [], deny: [] }, "off"),
    );

    // Pass 2: shrink-only — quantifies the value of the description+schema
    // shrinker independent of filtering.
    rows.push(
      await measureOnce(config, upstream, "all (shrunk)", { allow: [], deny: [] }, "rules"),
    );

    // Pass 3: common filter + shrink — typical "I use these daily" set.
    rows.push(
      await measureOnce(config, upstream, "common (filter+shrink)", SCENARIOS.common, "rules"),
    );

    // Pass 4: tight task filter — what the agent actually needs.
    rows.push(
      await measureOnce(config, upstream, "task (filter+shrink)", SCENARIOS.task, "rules"),
    );
  } finally {
    await upstream.closeAll();
  }

  const baseline = rows[0]!;
  const report: MeasureReport = {
    baselineBytes: baseline.bytes,
    baselineTokens: baseline.tokens,
    baselineToolCount: baseline.toolCount,
    rows,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path.join(RESULTS_DIR, "measure.json"), JSON.stringify(report, null, 2), "utf8");

  printTable(report);
  return report;
}

async function measureOnce(
  config: TooltrimConfig,
  upstream: UpstreamManager,
  label: string,
  filter: { allow: string[]; deny: string[] },
  shrinkMode: "off" | "rules",
): Promise<MeasureRow> {
  const toolFilter = new ToolFilter({ allow: filter.allow, deny: filter.deny });
  const shrinker = new Shrinker({
    mode: shrinkMode,
    maxDescriptionChars: config.shrink.maxDescriptionChars,
    dedupeSchemas: config.shrink.dedupeSchemas,
    cachePath: undefined,
  });

  const aggregator = new Aggregator({
    cfg: config,
    upstream,
    filter: toolFilter,
    shrinker,
  });

  const tools = await aggregator.collectTools();
  const json = JSON.stringify(tools);

  return {
    scenario: label,
    filterAllow: filter.allow.length,
    filterDeny: filter.deny.length,
    shrink: shrinkMode,
    toolCount: tools.length,
    bytes: byteLength(json),
    tokens: countTokens(json),
  };
}

function printTable(report: MeasureReport): void {
  const headers = [
    "Scenario",
    "Tools",
    "Bytes",
    "Tokens",
    "vs raw (bytes)",
    "vs raw (tokens)",
  ];
  const rows = report.rows.map((r) => {
    const bytesPct = report.baselineBytes
      ? ((1 - r.bytes / report.baselineBytes) * 100).toFixed(1)
      : "0.0";
    const tokensPct = report.baselineTokens
      ? ((1 - r.tokens / report.baselineTokens) * 100).toFixed(1)
      : "0.0";
    return [
      r.scenario,
      String(r.toolCount),
      r.bytes.toLocaleString("en-US"),
      r.tokens.toLocaleString("en-US"),
      `-${bytesPct}%`,
      `-${tokensPct}%`,
    ];
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");

  process.stdout.write("\n[measure] tool-list size across scenarios\n");
  process.stdout.write(fmt(headers) + "\n");
  process.stdout.write(widths.map((w) => "─".repeat(w)).join("  ") + "\n");
  for (const row of rows) {
    process.stdout.write(fmt(row) + "\n");
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("measure-scenarios.ts")) {
  runMeasureScenarios().catch((err) => {
    process.stderr.write(`measure-scenarios failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
