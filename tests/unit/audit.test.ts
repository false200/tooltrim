import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../../src/observability/audit.js";

describe("AuditLogger", () => {
  it("keeps writing after one append fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-audit-"));
    const file = path.join(dir, "audit.ndjson");
    const logger = new AuditLogger(true, file);
    await logger.record({ upstream: "a", tool: "first", ok: true });

    await rm(file);
    await mkdir(file);
    await expect(logger.record({ upstream: "a", tool: "blocked", ok: false })).rejects.toThrow();
    await rm(file, { recursive: true });

    await logger.record({ upstream: "a", tool: "second", ok: true });
    const text = await readFile(file, "utf8");
    expect(text).toContain("second");
    expect(text).not.toContain("blocked");
  });
});
