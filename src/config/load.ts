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

export function redactSecrets(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && typeof v === "string") {
        out[k] = v.length > 0 ? "***" : v;
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  return value;
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

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi;

function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
      const envValue = process.env[name];
      if (envValue !== undefined) return envValue;
      if (fallback !== undefined) return fallback;
      return "";
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
