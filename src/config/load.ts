import { cosmiconfig, type Loader } from "cosmiconfig";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tooltrimConfigSchema, type TooltrimConfig } from "./schema.js";

const yamlLoader: Loader = async (filepath: string) => {
  const text = await readFile(filepath, "utf8");
  return parseYaml(text);
};

const explorer = cosmiconfig("tooltrim", {
  searchPlaces: [
    "tooltrim.config.yaml",
    "tooltrim.config.yml",
    "tooltrim.config.json",
    "tooltrim.config.js",
    "tooltrim.config.mjs",
    ".tooltrim.yaml",
    ".tooltrim.yml",
    ".tooltrim.json",
    "package.json",
  ],
  packageProp: "tooltrim",
  loaders: {
    ".yaml": yamlLoader,
    ".yml": yamlLoader,
  },
});

export interface LoadOptions {
  /** Explicit path to a config file. If absent, walks up from cwd. */
  configPath?: string;
  /** Where to start the search if `configPath` is not given. */
  cwd?: string;
}

export interface LoadedConfig {
  config: TooltrimConfig;
  filepath: string;
}

/**
 * Locate, parse, and validate the Tooltrim config. Substitutes `${VAR}` and
 * `${VAR:-default}` in string values from `process.env`.
 */
export async function loadConfig(opts: LoadOptions = {}): Promise<LoadedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const result = opts.configPath
    ? await explorer.load(path.resolve(cwd, opts.configPath))
    : await explorer.search(cwd);

  if (!result) {
    throw new Error(
      "No Tooltrim config found. Create tooltrim.config.yaml or pass --config <path>.",
    );
  }

  const expanded = expandEnv(result.config);
  return {
    config: validateConfig(expanded),
    filepath: result.filepath,
  };
}

/** Parse YAML or JSON config text. Does not expand env vars. */
export function parseConfigText(text: string): unknown {
  return parseYaml(text);
}

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key/i;

function isSecretFlag(flag: string): boolean {
  return /^-{1,2}[^\s=]*(?:token|secret|password|authorization|api[-_]?key)[^\s=]*$/i.test(flag);
}

export function redactSecrets(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const headerSecret = obj.type === "header";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "headers" && v && typeof v === "object" && !Array.isArray(v)) {
        const headers: Record<string, unknown> = {};
        for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
          headers[hk] = typeof hv === "string" && hv.length > 0 ? "***" : redactSecrets(hv);
        }
        out[k] = headers;
      } else if (typeof v === "string" && (SECRET_KEY.test(k) || (headerSecret && k === "value"))) {
        out[k] = v.length > 0 ? "***" : v;
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const prev = value[i - 1];
      if (
        typeof item === "string" &&
        typeof prev === "string" &&
        isSecretFlag(prev) &&
        item.length > 0
      ) {
        return "***";
      }
      return redactSecrets(item);
    });
  }
  if (typeof value === "string") return redactSecretText(value);
  return value;
}

function redactSecretText(value: string): string {
  // `*` so `redis://:password@host` is covered; `+` required a username.
  let out = value.replace(/:\/\/[^/\s:@]*:[^/\s@]+@/g, "://***@");
  out = out.replace(
    /([?&][^=&\s]*(?:token|secret|password|api[-_]?key)[^=&\s]*)=[^&\s]*/gi,
    "$1=***",
  );
  out = out.replace(/(--?[^\s=]*(?:token|secret|password|api[-_]?key)[^\s=]*)=\S+/gi, "$1=***");
  for (const [key, envValue] of Object.entries(process.env)) {
    if (!envValue || envValue.length < 8 || !SECRET_KEY.test(key)) continue;
    if (out.includes(envValue)) out = out.split(envValue).join("***");
  }
  return out;
}

export function validateConfig(raw: unknown): TooltrimConfig {
  const parsed = tooltrimConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Tooltrim config:\n${issues}`);
  }
  return parsed.data;
}

function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    const pattern = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi;
    return value.replace(pattern, (_match, name: string, fallback?: string) => {
      const envValue = process.env[name];
      if (envValue !== undefined) return envValue;
      if (fallback !== undefined) return fallback;
      throw new Error(
        `Missing environment variable ${name}. Set it, or use \${${name}:-default} in the config.`,
      );
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnv(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v);
    }
    return out as unknown as T;
  }
  return value;
}
