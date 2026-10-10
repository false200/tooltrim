import { cac } from "cac";
import { loadConfig, parseConfigText, redactSecrets, validateConfig } from "./config/load.js";
import { runProxy } from "./proxy.js";
import { runMeasure } from "./cli/measure.js";
import { runTraceTail } from "./cli/trace.js";
import { configureLogger, getLogger } from "./logger.js";
import { readFile } from "node:fs/promises";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const cli = cac("tooltrim");
  cli.version(VERSION);
  cli.help();

  cli
    .command("[]", "Start the proxy (default)")
    .option("-c, --config <path>", "Path to tooltrim.config.yaml")
    .action(async (_input: string[], flags: { config?: string }) => {
      await startProxyCmd(flags.config);
    });

  cli
    .command("start", "Start the proxy")
    .option("-c, --config <path>", "Path to tooltrim.config.yaml")
    .action(async (flags: { config?: string }) => {
      await startProxyCmd(flags.config);
    });

  cli
    .command("measure", "Connect to upstream servers, print bytes/tokens before vs after Tooltrim")
    .option("-c, --config <path>", "Path to tooltrim.config.yaml")
    .option("--json", "Also emit JSON output after the table")
    .action(async (flags: { config?: string; json?: boolean }) => {
      await runMeasure({ configPath: flags.config, json: flags.json });
    });

  cli
    .command("validate-config", "Validate the resolved config without starting the proxy")
    .option("-c, --config <path>", "Path to tooltrim.config.yaml")
    .action(async (flags: { config?: string }) => {
      try {
        const { config, filepath } = await loadConfig({ configPath: flags.config });
        process.stdout.write(`OK: ${filepath}\n`);
        process.stdout.write(JSON.stringify(redactSecrets(config), null, 2) + "\n");
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  cli
    .command("validate-file <path>", "Validate a raw config file (no env expansion)")
    .action(async (filePath: string) => {
      try {
        const text = await readFile(filePath, "utf8");
        validateConfig(parseConfigText(text));
        process.stdout.write("OK\n");
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  cli
    .command("trace tail", "Tail the trace NDJSON file in real time")
    .option("-c, --config <path>", "Path to tooltrim.config.yaml")
    .option("-p, --path <path>", "Override trace file path")
    .option("--no-follow", "Print existing content and exit")
    .option("--no-pretty", "Print raw JSON")
    .action(
      async (flags: { config?: string; path?: string; follow?: boolean; pretty?: boolean }) => {
        await runTraceTail({
          configPath: flags.config,
          path: flags.path,
          follow: flags.follow,
          pretty: flags.pretty,
        });
      },
    );

  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
}

async function startProxyCmd(configPath?: string): Promise<void> {
  const { config } = await loadConfig({ configPath });
  const handle = await runProxy({ cfg: config });
  const log = getLogger();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  configureLogger({ level: "error" });
  getLogger().error({ err: (err as Error).message }, "tooltrim failed");
  process.stderr.write(`tooltrim: ${(err as Error).message}\n`);
  process.exit(1);
});
