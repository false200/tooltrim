import { mkdir } from "node:fs/promises";
import path from "node:path";
import pino, { type Logger } from "pino";
import { SpanStatusCode, trace as otelTrace } from "@opentelemetry/api";
import type { TooltrimConfig } from "../config/schema.js";

export interface TraceEvent {
  dir: "in" | "out";
  upstream?: string;
  method: string;
  id?: string | number;
  name?: string;
  ok?: boolean;
  durMs?: number;
  err?: string;
  argHash?: string;
  /** Free-form extra fields. */
  [key: string]: unknown;
}

export interface TracerOptions {
  sink: "off" | "stderr" | "file" | "otlp";
  path?: string;
}

/**
 * NDJSON tracer for every JSON-RPC frame entering or leaving the proxy.
 * Sinks: stderr, file (append-only), or "otlp" (forwards via the OTel SDK
 * if it has been initialized — otherwise silently degrades to stderr).
 */
export class Tracer {
  private readonly logger: Logger | null;
  private readonly sink: TracerOptions["sink"];

  private constructor(logger: Logger | null, sink: TracerOptions["sink"]) {
    this.logger = logger;
    this.sink = sink;
  }

  static async create(opts: TracerOptions): Promise<Tracer> {
    if (opts.sink === "off") return new Tracer(null, "off");

    const baseOptions = {
      base: { trace: true },
      messageKey: "msg",
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
    };

    if (opts.sink === "file" && opts.path) {
      await mkdir(path.dirname(opts.path), { recursive: true });
      const stream = pino.destination({ dest: opts.path, sync: false, mkdir: true });
      return new Tracer(pino(baseOptions, stream), "file");
    }

    // stderr (and "otlp" fallback). OTLP wiring lives in metrics.ts; the
    // tracer itself just emits structured logs which an OTel log
    // exporter or external collector can scrape.
    const stream = pino.destination({ dest: 2, sync: false });
    return new Tracer(pino(baseOptions, stream), opts.sink);
  }

  static async fromConfig(cfg: TooltrimConfig): Promise<Tracer> {
    return Tracer.create({ sink: cfg.observability.trace.sink, path: cfg.observability.trace.path });
  }

  trace(event: TraceEvent): void {
    this.logger?.info(event, event.method);
    const span = otelTrace.getTracer("tooltrim").startSpan(event.method);
    span.setAttribute("tooltrim.dir", event.dir);
    if (event.upstream) span.setAttribute("tooltrim.upstream", event.upstream);
    if (event.name) span.setAttribute("tooltrim.name", event.name);
    if (event.ok === false) {
      span.setStatus(
        event.err
          ? { code: SpanStatusCode.ERROR, message: event.err }
          : { code: SpanStatusCode.ERROR },
      );
    }
    span.end();
  }

  async flush(): Promise<void> {
    if (!this.logger) return;
    await new Promise<void>((resolve) => {
      this.logger!.flush(() => resolve());
    });
  }
}
