import { describe, expect, it } from "vitest";
import { tooltrimConfigSchema } from "../../src/config/schema.js";
import { otlpTracesUrl, startOtel } from "../../src/observability/otel.js";

describe("OpenTelemetry startup", () => {
  it("stays off when enabled is false, even if an endpoint is set", async () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: { x: { transport: "stdio", command: ["node"] } },
      observability: {
        metrics: { otel: { enabled: false, endpoint: "http://127.0.0.1:9/v1/traces" } },
      },
    });
    const handle = await startOtel(cfg);
    expect(handle).toBeNull();
  });

  it("appends /v1/traces once", () => {
    expect(otlpTracesUrl("http://localhost:4318")).toBe("http://localhost:4318/v1/traces");
    expect(otlpTracesUrl("http://localhost:4318/")).toBe("http://localhost:4318/v1/traces");
    expect(otlpTracesUrl("http://localhost:4318/v1/traces")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });
});
