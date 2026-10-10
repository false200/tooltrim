import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { tooltrimConfigSchema } from "../../src/config/schema.js";
import { parseConfigText, redactSecrets, validateConfig } from "../../src/config/load.js";
import { VERSION } from "../../src/version.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

describe("config schema", () => {
  it("accepts a minimal stdio-only config", () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: {
        x: { transport: "stdio", command: ["node", "x.js"] },
      },
    });
    expect(cfg.servers.x.transport).toBe("stdio");
    expect(cfg.namespaceSeparator).toBe(".");
    expect(cfg.shrink.mode).toBe("rules");
    expect(cfg.inbound.stdio).toBe(true);
  });

  it("rejects invalid server ids", () => {
    expect(() =>
      tooltrimConfigSchema.parse({
        servers: { "weird id!": { transport: "stdio", command: ["x"] } },
      }),
    ).toThrow();
  });

  it("requires command to be a non-empty array for stdio", () => {
    expect(() =>
      validateConfig({
        servers: { x: { transport: "stdio", command: [] } },
      }),
    ).toThrow();
  });

  it("accepts http transport with passthrough auth", () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: {
        api: { transport: "http", url: "https://example.com/mcp", auth: "passthrough" },
      },
    });
    expect(cfg.servers.api.transport).toBe("http");
    expect(cfg.servers.api.transport === "http" && cfg.servers.api.auth).toBe("passthrough");
  });

  it("validates URL format for http", () => {
    expect(() =>
      tooltrimConfigSchema.parse({
        servers: { api: { transport: "http", url: "not-a-url" } },
      }),
    ).toThrow();
  });

  it("leaves omitted http auth unset and accepts port 0", () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: { api: { transport: "http", url: "https://example.com/mcp" } },
      inbound: { http: { enabled: true, port: 0 } },
    });
    expect(cfg.servers.api.transport === "http" && cfg.servers.api.auth).toBeUndefined();
    expect(cfg.policy.defaultAuth).toBe("passthrough");
    expect(cfg.inbound.http.port).toBe(0);
  });

  it("parses a yaml config file", () => {
    const cfg = validateConfig(
      parseConfigText("servers:\n  x:\n    transport: stdio\n    command: [node, x.js]\n"),
    );
    expect(cfg.servers.x.transport).toBe("stdio");
  });

  it("redacts api_key and authorization values", () => {
    expect(
      redactSecrets({
        API_KEY: "super-secret",
        Authorization: "Bearer abc",
        name: "visible",
      }),
    ).toEqual({ API_KEY: "***", Authorization: "***", name: "visible" });
  });

  it("reports the package version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("normalizes empty optional sections via defaults", () => {
    const cfg = tooltrimConfigSchema.parse({
      servers: { x: { transport: "stdio", command: ["a"] } },
    });
    expect(cfg.filters.allow).toEqual([]);
    expect(cfg.filters.deny).toEqual([]);
    expect(cfg.observability.audit.enabled).toBe(false);
    expect(cfg.observability.metrics.prometheus.enabled).toBe(false);
  });
});
