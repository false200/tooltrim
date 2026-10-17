import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        path.join(repoRoot, "src/cli.ts"),
        ...args,
      ],
      { cwd },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

describe("cli", () => {
  it("default command loads config instead of crashing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-cli-"));
    try {
      const out = await runCli([], dir);
      expect(out.stderr).toContain("No Tooltrim config found");
      expect(out.stderr).not.toContain("reading 'config'");
      expect(out.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
