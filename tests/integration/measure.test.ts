import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const requireFromHere = createRequire(import.meta.url);
const tsxCli = requireFromHere.resolve("tsx/cli");
const cliEntry = path.resolve(root, "src", "cli.ts");
const echoStdio = path.resolve(root, "tests", "fixtures", "echo-mcp-server", "stdio.ts");

describe("tooltrim measure", () => {
  it(
    "prints a non-zero token-savings table for a real upstream",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-"));
      const cfgPath = path.join(dir, "tooltrim.config.json");
      const cfg = {
        servers: {
          a: {
            transport: "stdio",
            command: ["node", tsxCli, echoStdio],
            env: { ECHO_SERVER_NAME: "a" },
          },
        },
        shrink: { mode: "rules", maxDescriptionChars: 60, cachePath: path.join(dir, "cache.json") },
        observability: { trace: { sink: "off" } },
        inbound: { stdio: false, http: { enabled: false } },
        logLevel: "silent",
      };
      await writeFile(cfgPath, JSON.stringify(cfg), "utf8");

      try {
        const { stdout, code } = await runCli(["measure", "--config", cfgPath]);
        expect(code).toBe(0);
        expect(stdout).toMatch(/Server\s+Tools/);
        expect(stdout).toMatch(/^a\s+/m);
        expect(stdout).toMatch(/TOTAL/);
        // The fixture has at least 3 tools and verbose descriptions, so shrinking
        // must shave at least *some* tokens.
        const totalLine = stdout.split("\n").find((l) => l.startsWith("TOTAL"));
        expect(totalLine).toBeDefined();
        const m = /(\d+(?:[,\d]*))\s+%/.exec(totalLine ?? "");
        // Find the savings percentage cell (last number followed by %).
        const pctMatch = totalLine?.match(/(\d+(?:\.\d+)?)%/);
        expect(pctMatch).toBeTruthy();
        const pct = Number(pctMatch![1]);
        expect(pct).toBeGreaterThan(0);
        void m;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "omits blocked tools from the trimmed count",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-"));
      const cfgPath = path.join(dir, "tooltrim.config.json");
      const cfg = {
        servers: {
          a: {
            transport: "stdio",
            command: ["node", tsxCli, echoStdio],
            env: { ECHO_SERVER_NAME: "a" },
          },
        },
        shrink: { mode: "off", cachePath: path.join(dir, "cache.json") },
        observability: { trace: { sink: "off" } },
        inbound: { stdio: false, http: { enabled: false } },
        policy: { blockedTools: ["a.delete_thing"] },
        logLevel: "silent",
      };
      await writeFile(cfgPath, JSON.stringify(cfg), "utf8");

      try {
        const { stdout, code } = await runCli(["measure", "--config", cfgPath]);
        expect(code).toBe(0);
        expect(stdout).toMatch(/3 → 2/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [tsxCli, cliEntry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
