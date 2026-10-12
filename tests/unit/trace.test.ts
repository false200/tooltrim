import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTraceTail } from "../../src/cli/trace.js";

describe("trace tail", () => {
  it("returns when the file is missing and follow is off", async () => {
    await expect(
      runTraceTail({
        path: path.join(tmpdir(), "no-such-tooltrim-trace.ndjson"),
        follow: false,
        pretty: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("prints existing lines and exits when follow is off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-trace-"));
    const file = path.join(dir, "trace.ndjson");
    await writeFile(file, '{"method":"tools/list"}\n{"method":"tools/call"}\n');
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await runTraceTail({ path: file, follow: false, pretty: false });
      expect(chunks.join("")).toContain("tools/list");
      expect(chunks.join("")).toContain("tools/call");
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
