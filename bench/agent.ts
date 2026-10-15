/**
 * Phase 5: real Claude Sonnet 4.5 agent loop, run twice.
 *
 *   - Pass A ("direct"): hands Claude every tool from every upstream, no
 *                        filtering, no shrinking. Naive enterprise setup.
 *   - Pass B ("proxy"):  hands Claude only the tools the proxy chooses to
 *                        expose under the `task` filter scenario.
 *
 * Same prompt, same model, same max_tokens. We compare the cumulative
 * `usage.input_tokens` Anthropic returns. That delta is the real "money saved".
 *
 * Tool-name translation: Anthropic's API restricts names to ^[a-zA-Z0-9_-]{1,64}$,
 * but our namespacing uses dots (`everything.echo`). We round-trip with `__`.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool as AnthropicTool,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_LIMITS,
  AGENT_TASK_PROMPT,
  BENCH_HTTP_URL,
  DEFAULT_ANTHROPIC_MODEL,
  loadBenchProxyConfig,
  RESULTS_DIR,
  SCENARIOS,
} from "./config.js";
import { DirectFanOutClient } from "./direct-client.js";
import { runProxy, type ProxyHandle } from "../src/proxy.js";
import { configureLogger } from "../src/logger.js";

const SEPARATOR = "__";

export interface AgentRunResult {
  variant: "direct" | "proxy";
  toolsExposed: number;
  toolsExposedJsonBytes: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  wallMs: number;
  finalText: string;
  completed: boolean;
  stoppedReason: string;
  transcript: TranscriptEntry[];
}

export interface TranscriptEntry {
  turn: number;
  role: "user" | "assistant" | "tool_result";
  content: unknown;
  usage?: Message["usage"];
}

export interface AgentReport {
  model: string;
  prompt: string;
  direct?: AgentRunResult;
  proxy?: AgentRunResult;
  delta?: {
    inputTokens: number;
    inputTokensPct: number;
    toolCalls: number;
    wallMs: number;
  };
  skippedReason?: string;
}

interface ToolBackend {
  listTools: () => Promise<McpTool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

export async function runAgentBench(): Promise<AgentReport> {
  configureLogger({ level: "warn", toStderr: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = DEFAULT_ANTHROPIC_MODEL;
  const report: AgentReport = { model, prompt: AGENT_TASK_PROMPT };

  if (!apiKey) {
    report.skippedReason =
      "ANTHROPIC_API_KEY not set; skipping agent loop (this section will be omitted from the report)";
    process.stderr.write(`[agent] ${report.skippedReason}\n`);
    return report;
  }
  if (!process.env.GITHUB_TOKEN) {
    report.skippedReason =
      "GITHUB_TOKEN not set; the locked task requires the github MCP upstream — agent loop skipped";
    process.stderr.write(`[agent] ${report.skippedReason}\n`);
    return report;
  }
  if (process.env.BENCH_DRY_RUN === "1") {
    report.skippedReason = "BENCH_DRY_RUN=1 set; skipping live Anthropic call";
    process.stderr.write(`[agent] ${report.skippedReason}\n`);
    return report;
  }

  const anthropic = new Anthropic({ apiKey });

  // Pass A: direct fan-out
  process.stderr.write("\n[agent] === pass A: direct (no proxy, full unfiltered tool list) ===\n");
  const directBackend = await openDirectBackend();
  try {
    report.direct = await runOnce(anthropic, model, "direct", directBackend);
  } finally {
    await directBackend.close();
  }

  // Pass B: through Tooltrim with the task scenario applied
  process.stderr.write("\n[agent] === pass B: proxy (Tooltrim, task filter) ===\n");
  const proxyBackend = await openProxyBackend();
  try {
    report.proxy = await runOnce(anthropic, model, "proxy", proxyBackend);
  } finally {
    await proxyBackend.close();
  }

  if (report.direct && report.proxy) {
    const tokDelta = report.direct.inputTokens - report.proxy.inputTokens;
    const tokPct = report.direct.inputTokens
      ? (tokDelta / report.direct.inputTokens) * 100
      : 0;
    report.delta = {
      inputTokens: tokDelta,
      inputTokensPct: tokPct,
      toolCalls: report.direct.toolCalls - report.proxy.toolCalls,
      wallMs: report.direct.wallMs - report.proxy.wallMs,
    };
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    path.join(RESULTS_DIR, "agent.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  if (report.direct) {
    await writeFile(
      path.join(RESULTS_DIR, "agent-direct.json"),
      JSON.stringify(report.direct, null, 2),
      "utf8",
    );
  }
  if (report.proxy) {
    await writeFile(
      path.join(RESULTS_DIR, "agent-proxy.json"),
      JSON.stringify(report.proxy, null, 2),
      "utf8",
    );
  }
  printSummary(report);
  return report;
}

async function runOnce(
  anthropic: Anthropic,
  model: string,
  variant: "direct" | "proxy",
  backend: ToolBackend,
): Promise<AgentRunResult> {
  const mcpTools = await backend.listTools();
  const anthropicTools = toAnthropicTools(mcpTools);
  const toolsJsonBytes = Buffer.byteLength(JSON.stringify(anthropicTools), "utf8");
  process.stderr.write(
    `[agent ${variant}] tools exposed: ${anthropicTools.length} (${toolsJsonBytes} bytes of metadata)\n`,
  );

  const transcript: TranscriptEntry[] = [];
  const messages: MessageParam[] = [{ role: "user", content: AGENT_TASK_PROMPT }];
  transcript.push({ turn: 0, role: "user", content: AGENT_TASK_PROMPT });

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let finalText = "";
  let stoppedReason = "max_turns";
  let completed = false;

  const start = performance.now();
  for (let turn = 1; turn <= AGENT_LIMITS.maxTurns; turn++) {
    turns = turn;
    const response = await anthropic.messages.create({
      model,
      max_tokens: AGENT_LIMITS.maxTokensPerTurn,
      tools: anthropicTools,
      messages,
    });
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    cacheCreationTokens += response.usage?.cache_creation_input_tokens ?? 0;
    cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;
    transcript.push({
      turn,
      role: "assistant",
      content: response.content,
      usage: response.usage,
    });

    messages.push({ role: "assistant", content: response.content });
    process.stderr.write(
      `[agent ${variant}] turn ${turn}: stop=${response.stop_reason} in=${response.usage?.input_tokens ?? 0} out=${response.usage?.output_tokens ?? 0}\n`,
    );

    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    const textBlocks = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text);
    if (textBlocks.length > 0) finalText = textBlocks.join("\n").trim();

    if (toolUses.length === 0 || response.stop_reason === "end_turn") {
      stoppedReason = response.stop_reason ?? "end_turn";
      completed = response.stop_reason === "end_turn";
      break;
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls++;
      const realName = decodeToolName(use.name);
      const args = (use.input as Record<string, unknown>) ?? {};
      try {
        const result = await backend.callTool(realName, args);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: serializeToolResult(result),
          is_error: result.isError === true,
        });
        transcript.push({
          turn,
          role: "tool_result",
          content: { name: realName, args, result },
        });
      } catch (err) {
        const msg = (err as Error).message;
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: msg,
          is_error: true,
        });
        transcript.push({
          turn,
          role: "tool_result",
          content: { name: realName, args, error: msg },
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  const wallMs = performance.now() - start;
  return {
    variant,
    toolsExposed: anthropicTools.length,
    toolsExposedJsonBytes: toolsJsonBytes,
    turns,
    toolCalls,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    wallMs,
    finalText,
    completed,
    stoppedReason,
    transcript,
  };
}

function toAnthropicTools(tools: McpTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: encodeToolName(t.name),
    description: t.description ?? "",
    input_schema: (t.inputSchema as AnthropicTool["input_schema"]) ?? {
      type: "object",
      properties: {},
    },
  }));
}

function encodeToolName(name: string): string {
  // Replace dots with `__` so the name matches Anthropic's tool-name regex.
  // Names are also clipped to 64 chars; almost no real MCP tool exceeds that.
  return name.replace(/\./g, SEPARATOR).slice(0, 64);
}

function decodeToolName(name: string): string {
  return name.split(SEPARATOR).join(".");
}

function serializeToolResult(result: CallToolResult): string {
  if (!result.content) return "";
  const parts = result.content.map((b) => {
    if (b.type === "text") return b.text;
    return JSON.stringify(b);
  });
  return parts.join("\n").slice(0, 8000);
}

async function openDirectBackend(): Promise<ToolBackend> {
  const direct = await DirectFanOutClient.open();
  return {
    listTools: () => direct.listTools(),
    callTool: (name, args) => direct.callTool(name, args),
    close: () => direct.close(),
  };
}

async function openProxyBackend(): Promise<ToolBackend> {
  const config = await loadBenchProxyConfig();
  // Apply the tight task scenario for the proxy pass.
  config.filters.allow = SCENARIOS.task.allow;
  config.filters.deny = SCENARIOS.task.deny;
  const proxy: ProxyHandle = await runProxy({ cfg: config, disableInboundStdio: true });

  const transport = new StreamableHTTPClientTransport(new URL(BENCH_HTTP_URL));
  const client = new Client(
    { name: "tooltrim-bench-agent", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    listTools: async () => {
      const list = await client.listTools();
      return (list.tools ?? []) as McpTool[];
    },
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close().catch(() => undefined);
      await proxy.close();
    },
  };
}

function printSummary(report: AgentReport): void {
  if (report.skippedReason) return;
  process.stdout.write(`\n[agent] Claude Sonnet 4.5 agent loop summary (${report.model})\n`);
  const headers = ["Variant", "Tools", "ToolsBytes", "Turns", "Calls", "InTok", "OutTok", "Wall(s)", "Done"];
  const fmt = (r: AgentRunResult) => [
    r.variant,
    String(r.toolsExposed),
    r.toolsExposedJsonBytes.toLocaleString("en-US"),
    String(r.turns),
    String(r.toolCalls),
    r.inputTokens.toLocaleString("en-US"),
    r.outputTokens.toLocaleString("en-US"),
    (r.wallMs / 1000).toFixed(1),
    r.completed ? "yes" : "no",
  ];
  const rows: string[][] = [];
  if (report.direct) rows.push(fmt(report.direct));
  if (report.proxy) rows.push(fmt(report.proxy));
  if (report.delta) {
    rows.push([
      "Δ direct→proxy",
      "",
      "",
      "",
      String(-report.delta.toolCalls),
      `${report.delta.inputTokens > 0 ? "-" : "+"}${Math.abs(report.delta.inputTokens).toLocaleString("en-US")} (${report.delta.inputTokensPct.toFixed(1)}%)`,
      "",
      (report.delta.wallMs / 1000).toFixed(1),
      "",
    ]);
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  process.stdout.write(fmtRow(headers) + "\n");
  process.stdout.write(widths.map((w) => "─".repeat(w)).join("  ") + "\n");
  for (const r of rows) process.stdout.write(fmtRow(r) + "\n");
}

if (process.argv[1]?.endsWith("agent.ts")) {
  runAgentBench().catch((err) => {
    process.stderr.write(`agent failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
