import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

export type UpstreamStatus = "starting" | "connected" | "reconnecting" | "errored" | "closed";

export interface UpstreamConnection {
  id: string;
  client: Client;
  status: UpstreamStatus;
  capabilities?: ServerCapabilities;
  serverInfo?: { name: string; version: string };
  lastError?: Error;
  /**
   * Per-call HTTP headers to merge into outbound HTTP requests, used for
   * inbound `Authorization` pass-through. stdio upstreams ignore this.
   */
  setRequestHeaders?: (headers: Record<string, string>) => void;
}
