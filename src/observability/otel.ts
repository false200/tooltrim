import type { TooltrimConfig } from "../config/schema.js";
import { child as childLogger } from "../logger.js";
import { VERSION } from "../version.js";

export interface OtelHandle {
  shutdown: () => Promise<void>;
}

/**
 * Lazy-init the OpenTelemetry SDK only when explicitly enabled.
 * Avoids loading the heavy OTel packages when the user just wants the proxy.
 */
export async function startOtel(cfg: TooltrimConfig): Promise<OtelHandle | null> {
  const log = childLogger({ component: "otel" });
  const otelCfg = cfg.observability.metrics.otel;
  const endpoint = otelCfg.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otelCfg.enabled && !endpoint) return null;
  if (!endpoint) {
    log.warn("OTel enabled but no endpoint configured; skipping init");
    return null;
  }

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
      "@opentelemetry/semantic-conventions"
    );

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "tooltrim",
        [ATTR_SERVICE_VERSION]: VERSION,
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    });
    sdk.start();
    log.info({ endpoint }, "OpenTelemetry SDK started");

    return {
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch (err) {
          log.warn({ err: (err as Error).message }, "OTel shutdown failed");
        }
      },
    };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Failed to start OpenTelemetry SDK");
    return null;
  }
}
