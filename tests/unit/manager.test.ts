import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tooltrimConfigSchema } from "../../src/config/schema.js";
import { configureLogger } from "../../src/logger.js";
import { UpstreamManager } from "../../src/upstream/manager.js";

describe("UpstreamManager", () => {
  it("does not connect after shutdown", async () => {
    configureLogger({ level: "silent" });
    const cfg = tooltrimConfigSchema.parse({
      servers: { x: { transport: "stdio", command: ["node", "-e", "process.exit(0)"] } },
      logLevel: "silent",
      shrink: { mode: "off", cachePath: "" },
      observability: { trace: { sink: "off" } },
    });
    const mgr = new UpstreamManager(cfg);
    await mgr.closeAll();
    await expect(mgr.connectOne("x")).rejects.toThrow(/shutting down/);
  });

  it("does not pass the parent environment to a stdio child", async () => {
    configureLogger({ level: "silent" });
    const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-env-"));
    const file = path.join(dir, "env.json");
    const script = path.join(dir, "dump.cjs");
    await writeFile(
      script,
      `require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({
        leak: process.env.TOOLTRIM_LEAK_TEST ?? null,
        token: process.env.ONLY_THIS ?? null,
        path: process.env.PATH ? "yes" : "no",
      }));
      `,
    );
    process.env.TOOLTRIM_LEAK_TEST = "super-secret";
    const cfg = tooltrimConfigSchema.parse({
      servers: {
        x: {
          transport: "stdio",
          command: [process.execPath, script],
          env: { ONLY_THIS: "yes" },
          maxRestarts: 0,
        },
      },
      logLevel: "silent",
      shrink: { mode: "off", cachePath: "" },
      observability: { trace: { sink: "off" } },
    });
    const mgr = new UpstreamManager(cfg);
    try {
      await mgr.connectOne("x");
      const body = await waitForJson(file);
      expect(body.leak).toBeNull();
      expect(body.token).toBe("yes");
      expect(body.path).toBe("yes");
    } finally {
      delete process.env.TOOLTRIM_LEAK_TEST;
      await mgr.closeAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitForJson(file: string): Promise<{ leak: string | null; token: string | null; path: string }> {
  const started = Date.now();
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as {
        leak: string | null;
        token: string | null;
        path: string;
      };
    } catch (err) {
      if (Date.now() - started > 3000) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
