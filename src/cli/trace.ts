import { createReadStream } from "node:fs";
import { stat, watch } from "node:fs/promises";
import { createInterface } from "node:readline";
import { loadConfig } from "../config/load.js";

export interface TraceTailOptions {
  configPath?: string;
  /** Override path; falls back to the config's trace.path. */
  path?: string;
  /** Pretty-print each line. Default true when stdout is a TTY. */
  pretty?: boolean;
  /** Follow new lines (`tail -f`). Default true. */
  follow?: boolean;
}

export async function runTraceTail(opts: TraceTailOptions = {}): Promise<void> {
  let target = opts.path;
  if (!target) {
    const { config } = await loadConfig({ configPath: opts.configPath });
    target = config.observability.trace.path;
  }
  const pretty = opts.pretty ?? Boolean(process.stdout.isTTY);
  const follow = opts.follow ?? true;

  const fileExists = async () => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  };

  if (!(await fileExists())) {
    if (!follow) return;
    process.stderr.write(`waiting for ${target}\n`);
    while (!(await fileExists())) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  let position = 0;
  const initial = await stat(target);
  position = Math.max(0, initial.size - 64 * 1024); // start at last 64KiB
  let skipPartial = position > 0;

  const readChunk = async () => {
    let s;
    try {
      s = await stat(target);
    } catch {
      return;
    }
    if (s.size < position) {
      position = 0;
      skipPartial = false;
    }
    if (s.size <= position) return;
    await new Promise<void>((resolve) => {
      const stream = createReadStream(target, { start: position, end: s.size - 1 });
      const rl = createInterface({ input: stream });
      rl.on("line", (line) => {
        if (skipPartial) {
          skipPartial = false;
          return;
        }
        emitLine(line, pretty);
      });
      rl.on("close", () => resolve());
    });
    position = s.size;
  };

  await readChunk();
  if (!follow) return;

  const watcher = watch(target);
  for await (const _evt of watcher) {
    await readChunk();
  }
}

function emitLine(line: string, pretty: boolean): void {
  if (!line.trim()) return;
  if (!pretty) {
    process.stdout.write(line + "\n");
    return;
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const ts = String(obj.time ?? obj.ts ?? "");
    const dir = String(obj.dir ?? "");
    const method = String(obj.method ?? obj.msg ?? "");
    const upstream = obj.upstream ? String(obj.upstream) : "";
    const name = obj.name ? String(obj.name) : "";
    const ok = obj.ok === undefined ? "" : obj.ok ? "ok" : "ERR";
    const dur = obj.durMs !== undefined ? `${String(obj.durMs)}ms` : "";
    const arrow = dir === "out" ? "→" : dir === "in" ? "←" : " ";
    process.stdout.write(
      `${ts} ${arrow} ${method.padEnd(14)} ${upstream.padEnd(10)} ${name.padEnd(28)} ${ok.padStart(3)} ${dur}\n`,
    );
  } catch {
    process.stdout.write(line + "\n");
  }
}
