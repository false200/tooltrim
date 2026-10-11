import { describe, expect, it } from "vitest";
import { tooltrimConfigSchema } from "../../src/config/schema.js";
import { startOtel } from "../../src/observability/otel.js";

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
});
