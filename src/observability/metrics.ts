import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { createServer, type Server as HttpServer } from "node:http";
import type { TooltrimConfig } from "../config/schema.js";
import { child as childLogger } from "../logger.js";

export interface MetricsServerHandle {
  registry: Registry;
  recorder: MetricsRecorder;
  close: () => Promise<void>;
}

/**
 * Thin wrapper used by the rest of the proxy to record metrics without
 * importing prom-client everywhere.
 */
export class MetricsRecorder {
  private readonly callsTotal: Counter<string>;
  private readonly callDuration: Histogram<string>;
  private readonly tokensSavedGauge: Gauge<string>;
  private readonly upstreamUp: Gauge<string>;

  constructor(registry: Registry) {
    this.callsTotal = new Counter({
      name: "tooltrim_calls_total",
      help: "Total tool/resource/prompt calls forwarded by Tooltrim.",
      labelNames: ["upstream", "tool", "ok"],
      registers: [registry],
    });
    this.callDuration = new Histogram({
      name: "tooltrim_call_duration_ms",
      help: "Tool call duration in milliseconds.",
      labelNames: ["upstream", "tool", "ok"],
      buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000],
      registers: [registry],
    });
    this.tokensSavedGauge = new Gauge({
      name: "tooltrim_tokens_saved",
      help: "Tokens removed from tool listings by filtering and shrinking, since startup.",
      labelNames: ["upstream"],
      registers: [registry],
    });
    this.upstreamUp = new Gauge({
      name: "tooltrim_upstream_up",
      help: "1 if the upstream MCP server is currently connected.",
      labelNames: ["upstream"],
      registers: [registry],
    });
  }

  recordCall(upstream: string, tool: string, durMs: number, ok: boolean): void {
    const labels = { upstream, tool, ok: ok ? "true" : "false" } as const;
    this.callsTotal.inc(labels);
    this.callDuration.observe(labels, durMs);
  }

  setUpstreamUp(upstream: string, up: boolean): void {
    this.upstreamUp.set({ upstream }, up ? 1 : 0);
  }

  setTokensSaved(upstream: string, value: number): void {
    this.tokensSavedGauge.set({ upstream }, value);
  }
}

/**
 * Spin up the optional /metrics HTTP endpoint and return a recorder you can
 * pass into the aggregator. If Prometheus is disabled, returns a no-op
 * recorder bound to a private registry.
 */
export async function startMetrics(cfg: TooltrimConfig): Promise<MetricsServerHandle> {
  const log = childLogger({ component: "metrics" });
  const registry = new Registry();
  registry.setDefaultLabels({ service: "tooltrim" });
  const recorder = new MetricsRecorder(registry);

  if (!cfg.observability.metrics.prometheus.enabled) {
    return { registry, recorder, close: async () => undefined };
  }

  collectDefaultMetrics({ register: registry });

  const { host, port, path: metricsPath } = cfg.observability.metrics.prometheus;

  const server: HttpServer = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === metricsPath) {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } else if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.end("ok");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log.info({ host, port, path: metricsPath }, "metrics endpoint listening");

  return {
    registry,
    recorder,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
