import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.js";
import type { TooltrimConfig } from "../src/config/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BENCH_ROOT = path.resolve(here, "..");
export const BENCH_DIR = here;
export const RESULTS_DIR = path.join(BENCH_DIR, "results");
export const SANDBOX_DIR = path.join(BENCH_DIR, "sandbox");
export const REPORT_PATH = path.join(BENCH_DIR, "REPORT.md");
export const PROXY_CONFIG_PATH = path.resolve(BENCH_ROOT, "examples", "benchmark.config.yaml");

export const BENCH_HTTP_PORT = Number(process.env.BENCH_HTTP_PORT ?? 8799);
export const BENCH_HTTP_URL = `http://127.0.0.1:${BENCH_HTTP_PORT}/mcp`;

/**
 * Load the bench proxy config. A missing GITHUB_TOKEN must not abort the
 * local phases: the github upstream is omitted and the others still start.
 * The token line in the yaml has no default, so it is filled only for this load.
 */
export async function loadBenchProxyConfig(): Promise<TooltrimConfig> {
  const previous = process.env.GITHUB_TOKEN;
  const missing = !previous;
  if (missing) process.env.GITHUB_TOKEN = " ";
  try {
    const { config } = await loadConfig({ configPath: PROXY_CONFIG_PATH });
    if (missing) delete config.servers.github;
    return config;
  } finally {
    if (missing) {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  }
}

/**
 * The 5 upstream MCP servers under test. These mirror examples/benchmark.config.yaml
 * so the bench's "direct fan-out" mode (no proxy) can spawn the same processes.
 */
export interface UpstreamSpec {
  id: string;
  command: string[];
  env?: Record<string, string>;
  /** Set to true if the server requires GITHUB_TOKEN to be set. Skipped otherwise. */
  needsGithubToken?: boolean;
}

export const UPSTREAMS: UpstreamSpec[] = [
  {
    id: "everything",
    command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
  },
  {
    id: "filesystem",
    command: [
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      process.env.BENCH_FS_ROOT ?? SANDBOX_DIR,
    ],
  },
  {
    id: "memory",
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sequentialthinking",
    command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  {
    id: "github",
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? "" },
    needsGithubToken: true,
  },
];

export interface FilterScenario {
  allow: string[];
  deny: string[];
}

/**
 * Filter scenarios used by the measure phase. `all` is the bloated baseline,
 * `common` is "tools I use daily", `task` is the tight set the agent actually
 * needs for the locked task in `AGENT_TASK_PROMPT`.
 */
export const SCENARIOS: Record<"all" | "common" | "task", FilterScenario> = {
  all: { allow: [], deny: [] },
  common: {
    allow: [
      "everything.echo",
      "everything.add",
      "everything.printEnv",
      "everything.longRunningOperation",
      "everything.sampleLLM",
      "filesystem.read_file",
      "filesystem.read_multiple_files",
      "filesystem.list_directory",
      "filesystem.search_files",
      "filesystem.get_file_info",
      "memory.create_entities",
      "memory.add_observations",
      "memory.open_nodes",
      "memory.search_nodes",
      "memory.read_graph",
      "sequentialthinking.sequentialthinking",
      "github.search_repositories",
      "github.get_file_contents",
      "github.list_issues",
      "github.get_issue",
      "github.search_code",
    ],
    deny: ["*.delete_*", "*.create_or_update_*"],
  },
  task: {
    allow: [
      "github.get_file_contents",
      "memory.create_entities",
      "memory.open_nodes",
    ],
    deny: [],
  },
};

/**
 * The locked agent task. Stays identical for both the `direct` and `proxy`
 * runs so token comparisons are apples-to-apples.
 */
export const AGENT_TASK_PROMPT = [
  "Use the GitHub MCP server to fetch the README of the modelcontextprotocol/servers repository (owner: modelcontextprotocol, repo: servers, path: README.md, ref: main).",
  "From it, identify the three most prominently-listed reference servers and write a short 1-line summary for each.",
  "Store the result in the memory MCP server by calling create_entities once with three entities, each having entityType 'mcp_server' and a single observation that contains the 1-line summary.",
  "Then read it back with open_nodes and present the three summaries as your final answer.",
].join("\n\n");

/** Hard caps that protect the user's wallet during the agent loop. */
export const AGENT_LIMITS = {
  maxTurns: 8,
  maxTokensPerTurn: 1024,
};

export const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
