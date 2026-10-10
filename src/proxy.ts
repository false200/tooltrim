import { Aggregator } from "./core/aggregator.js";
import { ToolFilter } from "./core/filter.js";
import { Shrinker } from "./core/shrinker.js";
import { UpstreamManager } from "./upstream/manager.js";
import { Tracer } from "./observability/tracer.js";
import { startMetrics } from "./observability/metrics.js";
import { AuditLogger } from "./observability/audit.js";
import { startOtel } from "./observability/otel.js";
import { startStdioServer } from "./server/stdio.js";
import { startHttpServer } from "./server/http.js";
import { configureLogger, getLogger } from "./logger.js";
import type { TooltrimConfig } from "./config/schema.js";

export interface RunProxyOptions {
  cfg: TooltrimConfig;
  /** Used by tests/the SDK to supply a non-stdio inbound. */
  disableInboundStdio?: boolean;
}

export interface ProxyHandle {
  close: () => Promise<void>;
  /** Set when inbound HTTP is enabled; actual bound port (config port 0 → OS-assigned). */
  httpPort?: number;
}

export async function runProxy(opts: RunProxyOptions): Promise<ProxyHandle> {
  const { cfg } = opts;
  // When stdio is the inbound transport, every byte on stdout MUST be a
  // JSON-RPC frame, so logs go to stderr.
  configureLogger({ level: cfg.logLevel, toStderr: cfg.inbound.stdio });
  const log = getLogger();

  const tracer = await Tracer.fromConfig(cfg);
  const filter = ToolFilter.fromConfig(cfg);
  const shrinker = Shrinker.fromConfig(cfg);
  await shrinker.loadCache();
  const audit = AuditLogger.fromConfig(cfg);

  const otel = await startOtel(cfg);
  const metricsHandle = await startMetrics(cfg);

  const upstream = new UpstreamManager(cfg);
  upstream.onStatusChange((id, status) => {
    metricsHandle.recorder.setUpstreamUp(id, status === "connected");
  });
  await upstream.connectAll();
  for (const [id, conn] of upstream.connections) {
    metricsHandle.recorder.setUpstreamUp(id, conn.status === "connected");
  }

  const aggregator = new Aggregator({
    cfg,
    upstream,
    filter,
    shrinker,
    tracer,
    metrics: metricsHandle.recorder,
    audit,
  });

  const closers: Array<() => Promise<void>> = [];
  closers.push(() => upstream.closeAll());
  closers.push(metricsHandle.close);
  if (otel) closers.push(otel.shutdown);
  closers.push(() => shrinker.flushCache());

  if (cfg.inbound.stdio && !opts.disableInboundStdio) {
    const handle = await startStdioServer(aggregator.createServer());
    closers.push(handle.close);
  }
  let httpPort: number | undefined;
  if (cfg.inbound.http.enabled) {
    const handle = await startHttpServer({
      cfg,
      createServer: () => aggregator.createServer(),
      upstream,
    });
    httpPort = handle.port;
    closers.push(handle.close);
  }

  log.info(
    {
      upstreams: [...upstream.connections.keys()],
      stdio: cfg.inbound.stdio,
      http: cfg.inbound.http.enabled,
    },
    "Tooltrim proxy is running",
  );

  return {
    httpPort,
    close: async () => {
      for (const c of [...closers].reverse()) {
        try {
          await c();
        } catch (err) {
          log.warn({ err: (err as Error).message }, "shutdown step failed");
        }
      }
      await tracer.flush();
    },
  };
}
