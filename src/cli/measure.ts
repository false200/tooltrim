import { UpstreamManager } from "../upstream/manager.js";
import { ToolFilter } from "../core/filter.js";
import { Shrinker } from "../core/shrinker.js";
import { byteLength, countTokens } from "../core/tokenizer.js";
import { configureLogger } from "../logger.js";
import { loadConfig } from "../config/load.js";

interface ServerRow {
  server: string;
  toolsRaw: number;
  toolsTrim: number;
  bytesRaw: number;
  bytesTrim: number;
  tokensRaw: number;
  tokensTrim: number;
}

export interface MeasureOptions {
  configPath?: string;
  /** When true, also emit machine-readable JSON to stdout after the table. */
  json?: boolean;
}

export async function runMeasure(opts: MeasureOptions = {}): Promise<void> {
  configureLogger({ level: "warn", toStderr: true });
  const { config } = await loadConfig({ configPath: opts.configPath });

  const filter = ToolFilter.fromConfig(config);
  const shrinker = Shrinker.fromConfig(config);
  await shrinker.loadCache();

  const upstream = new UpstreamManager(config);
  await upstream.connectAll();

  const rows: ServerRow[] = [];

  try {
    for (const [id, conn] of upstream.connections) {
      if (conn.status !== "connected" || !conn.capabilities?.tools) {
        rows.push({
          server: id,
          toolsRaw: 0,
          toolsTrim: 0,
          bytesRaw: 0,
          bytesTrim: 0,
          tokensRaw: 0,
          tokensTrim: 0,
        });
        continue;
      }
      const result = await conn.client.listTools();
      const raw = result.tools ?? [];
      const namespaced = raw.map((t) => ({
        ...t,
        name: `${id}${config.namespaceSeparator}${t.name}`,
      }));
      const filtered = namespaced.filter((t) => filter.isAllowed(t.name, "tool"));
      const cfgServer = config.servers[id];
      const perToolMax =
        cfgServer && "shrink" in cfgServer ? cfgServer.shrink?.maxDescriptionChars : undefined;
      const shrunk = filtered.map((t) => {
        const next = shrinker.shrinkTool(
          {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown> | undefined,
            outputSchema: t.outputSchema as Record<string, unknown> | undefined,
          },
          perToolMax,
        );
        return {
          ...t,
          name: next.name,
          description: next.description,
          inputSchema: next.inputSchema ?? t.inputSchema,
          ...(next.outputSchema ? { outputSchema: next.outputSchema } : {}),
        };
      });

      const rawJson = JSON.stringify(raw);
      const trimmedJson = JSON.stringify(shrunk);

      rows.push({
        server: id,
        toolsRaw: raw.length,
        toolsTrim: shrunk.length,
        bytesRaw: byteLength(rawJson),
        bytesTrim: byteLength(trimmedJson),
        tokensRaw: countTokens(rawJson),
        tokensTrim: countTokens(trimmedJson),
      });
    }
  } finally {
    await upstream.closeAll();
    await shrinker.flushCache();
  }

  printTable(rows);
  if (opts.json) {
    process.stdout.write("\n" + JSON.stringify({ rows }, null, 2) + "\n");
  }
}

function printTable(rows: ServerRow[]): void {
  const total: ServerRow = {
    server: "TOTAL",
    toolsRaw: rows.reduce((a, r) => a + r.toolsRaw, 0),
    toolsTrim: rows.reduce((a, r) => a + r.toolsTrim, 0),
    bytesRaw: rows.reduce((a, r) => a + r.bytesRaw, 0),
    bytesTrim: rows.reduce((a, r) => a + r.bytesTrim, 0),
    tokensRaw: rows.reduce((a, r) => a + r.tokensRaw, 0),
    tokensTrim: rows.reduce((a, r) => a + r.tokensTrim, 0),
  };
  const all = [...rows, total];

  const headers = [
    "Server",
    "Tools (raw → trim)",
    "Bytes (raw)",
    "Bytes (trim)",
    "Tokens (raw)",
    "Tokens (trim)",
    "Saved",
  ];
  const lines = all.map((r) => {
    const saved = r.tokensRaw === 0 ? 0 : ((r.tokensRaw - r.tokensTrim) / r.tokensRaw) * 100;
    return [
      r.server,
      `${r.toolsRaw} → ${r.toolsTrim}`,
      r.bytesRaw.toLocaleString("en-US"),
      r.bytesTrim.toLocaleString("en-US"),
      r.tokensRaw.toLocaleString("en-US"),
      r.tokensTrim.toLocaleString("en-US"),
      `${saved.toFixed(1)}%`,
    ];
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...lines.map((row) => row[i]!.length)),
  );

  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");

  process.stdout.write(fmt(headers) + "\n");
  process.stdout.write(widths.map((w) => "─".repeat(w)).join("  ") + "\n");
  for (const row of lines.slice(0, -1)) {
    process.stdout.write(fmt(row) + "\n");
  }
  process.stdout.write(widths.map((w) => "─".repeat(w)).join("  ") + "\n");
  process.stdout.write(fmt(lines[lines.length - 1]!) + "\n");
}
