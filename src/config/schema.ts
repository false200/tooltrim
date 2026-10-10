import { z } from "zod";

const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Stop attempting to reconnect after this many failures. 0 = no retry. */
  maxRestarts: z.number().int().min(0).default(5),
  /** Initial backoff in ms, doubles up to 30s. */
  restartBackoffMs: z.number().int().min(0).default(500),
  /** Per-upstream stderr log budget in bytes per minute (0 = unlimited). */
  stderrLogBytesPerMinute: z.number().int().min(0).default(10_000),
  /** Per-server description-shrink override. */
  shrink: z
    .object({
      maxDescriptionChars: z.number().int().min(20).optional(),
    })
    .optional(),
});

const httpServerSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  /**
   * "passthrough" forwards the inbound `Authorization` header unchanged.
   * "none" sends no auth. "header" sends a literal header from the config.
   * Omitted → `policy.defaultAuth`.
   */
  auth: z
    .union([
      z.literal("passthrough"),
      z.literal("none"),
      z.object({
        type: z.literal("header"),
        name: z.string().default("Authorization"),
        value: z.string(),
      }),
    ])
    .optional(),
  /** Optional fixed headers always forwarded. */
  headers: z.record(z.string(), z.string()).optional(),
  shrink: z
    .object({
      maxDescriptionChars: z.number().int().min(20).optional(),
    })
    .optional(),
});

export const serverConfigSchema = z.discriminatedUnion("transport", [
  stdioServerSchema,
  httpServerSchema,
]);

const filtersSchema = z
  .object({
    /** Globs evaluated against the namespaced (`<server>.<tool>`) name. */
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    /** Optional scoping to specific MCP primitives. Defaults to all three. */
    apply: z
      .object({
        tools: z.boolean().default(true),
        resources: z.boolean().default(true),
        prompts: z.boolean().default(true),
      })
      .partial()
      .default({}),
  })
  .default({});

const shrinkSchema = z
  .object({
    mode: z.enum(["off", "rules", "llm"]).default("rules"),
    maxDescriptionChars: z.number().int().min(20).default(160),
    dedupeSchemas: z.boolean().default(true),
    cachePath: z.string().default(".tooltrim/shrink-cache.json"),
  })
  .default({});

const inboundSchema = z
  .object({
    stdio: z.boolean().default(true),
    http: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().default("127.0.0.1"),
        /** 0 lets the OS pick a free port. */
        port: z.number().int().min(0).max(65535).default(8787),
        path: z.string().default("/mcp"),
        sessions: z.union([z.literal("stateless"), z.string()]).default("stateless"),
      })
      .default({}),
  })
  .default({});

const observabilitySchema = z
  .object({
    trace: z
      .object({
        sink: z.enum(["off", "stderr", "file", "otlp"]).default("stderr"),
        path: z.string().default(".tooltrim/trace.ndjson"),
      })
      .default({}),
    metrics: z
      .object({
        prometheus: z
          .object({
            enabled: z.boolean().default(false),
            host: z.string().default("127.0.0.1"),
            port: z.number().int().min(1).max(65535).default(9464),
            path: z.string().default("/metrics"),
          })
          .default({}),
        otel: z
          .object({
            enabled: z.boolean().default(false),
            endpoint: z.string().optional(),
          })
          .default({}),
      })
      .default({}),
    audit: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().default(".tooltrim/audit.ndjson"),
      })
      .default({}),
  })
  .default({});

const policySchema = z
  .object({
    /** Default for all upstream HTTP calls when not specified per-server. */
    defaultAuth: z.enum(["passthrough", "none"]).default("passthrough"),
    /** Tools whose call must be denied unconditionally (post-filter). */
    blockedTools: z.array(z.string()).default([]),
  })
  .default({});

export const tooltrimConfigSchema = z.object({
  /** Map of upstream server id -> server config. Keys become the namespace prefix. */
  servers: z.record(z.string().regex(/^[a-z0-9_-]+$/i, {
    message: "server id must match [a-z0-9_-]+",
  }), serverConfigSchema),
  /** Separator between server id and original tool name in the aggregated namespace. */
  namespaceSeparator: z.string().default("."),
  filters: filtersSchema,
  shrink: shrinkSchema,
  inbound: inboundSchema,
  observability: observabilitySchema,
  policy: policySchema,
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  /** Timeout in ms for upstream listTools calls (default 30s). */
  upstreamTimeoutMs: z.number().int().min(1000).default(30_000),
});

export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type HttpServerConfig = z.infer<typeof httpServerSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type TooltrimConfig = z.infer<typeof tooltrimConfigSchema>;
