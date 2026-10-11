# Tooltrim

[![npm](https://img.shields.io/npm/v/tooltrim.svg)](https://www.npmjs.com/package/tooltrim)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Drop-in [MCP](https://modelcontextprotocol.io) proxy. Aggregate upstream servers into one endpoint, filter and shrink the tool list, trace calls, and measure token savings.

`tooltrim` on npm sits in front of your MCP servers so the agent sees one smaller tool catalog instead of every definition from every server.

---

## Features

- **Proxy** — one MCP entry in your editor; fans out to every upstream in config
- **Measure** — before/after token table from your real config (`tooltrim measure`)
- **Filters** — allow/deny globs on namespaced tools; enforced on list and call
- **Shrinker** — trims descriptions and dedupes JSON Schema deterministically
- **Tracing** — JSON-RPC frames as NDJSON (`.tooltrim/trace.ndjson`)
- **Metrics** — Prometheus and OpenTelemetry

Benchmarks against five official `@modelcontextprotocol/*` servers ([`bench/REPORT.md`](bench/REPORT.md)):

```text
Scenario                Tools  Tokens  vs raw
all (raw)                  63  10,401   −0.0%
common (filter+shrink)     17   3,084  −70.3%
task   (filter+shrink)      3     656  −93.7%
```

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Requirements](#requirements)
- [Repo and contributions](#repo-and-contributions)
- [License](#license)

---

## Installation

### npx (editors)

Point Cursor, Claude Desktop, or Codex at:

```json
{
  "mcpServers": {
    "tooltrim": {
      "command": "npx",
      "args": ["-y", "tooltrim"]
    }
  }
}
```

Use the project root (directory containing `tooltrim.config.yaml`) as the working directory.

### npm

```bash
npm install -g tooltrim
npm install tooltrim
```

Also `pnpm add tooltrim` and `yarn add tooltrim`.

### Docker

```bash
docker build -t tooltrim .
```

See [`docs/DOCKER.md`](docs/DOCKER.md).

---

## Usage

### Start the proxy

```bash
npx -y tooltrim
tooltrim start --config tooltrim.config.yaml
```

Loads `tooltrim.config.yaml` from the current directory unless `--config` is set.

### Measure token savings

```bash
npx -y tooltrim measure --config tooltrim.config.yaml
```

### Validate config

```bash
npx -y tooltrim validate-config
```

Redacts secrets. Useful before filing issues.

### Tail trace log

```bash
tooltrim trace tail
tooltrim trace tail --no-pretty
```

### Editor setup

1. Copy `examples/tooltrim.config.yaml` to your project root
2. Edit `servers`
3. Add the npx stdio config above to your MCP client

Replace per-server MCP entries with this single proxy entry.

---

## Configuration

Full example in [`examples/tooltrim.config.yaml`](examples/tooltrim.config.yaml).

```yaml
servers:
  github:
    transport: stdio
    command: ["npx", "-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }
  linear:
    transport: http
    url: https://mcp.linear.app/sse
    auth: passthrough

filters:
  allow: ["github.*", "linear.create_*"]
  deny:  ["github.delete_*", "*.admin_*"]

shrink:
  mode: rules
  maxDescriptionChars: 160
  dedupeSchemas: true

inbound:
  stdio: true
  http:
    enabled: true
    port: 8787
    path: /mcp

observability:
  trace:   { sink: file, path: .tooltrim/trace.ndjson }
  metrics: { prometheus: { enabled: true, port: 9464 } }
```

Globs match `<server>.<tool>`. Empty `allow` permits all; `deny` wins over `allow`.

HTTP `auth` is optional. When you leave it out, `policy.defaultAuth` is used (`passthrough` unless you change it).

Config search paths include `tooltrim.config.yaml`, `.tooltrim.json`, and a `"tooltrim"` key in `package.json`. `${VAR}` expands from the environment. If that variable is unset and you did not write `${VAR:-default}`, startup fails instead of inserting an empty string.

---

## Requirements

- Node.js 20+
- npx (for editor stdio transport)
- Upstream MCP servers via stdio or HTTP

---

## Repo and contributions

- Repo — https://github.com/false200/Tooltrim
- npm — https://www.npmjs.com/package/tooltrim
- Benchmarks — [`bench/REPORT.md`](bench/REPORT.md)

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
