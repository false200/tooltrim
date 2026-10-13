import { describe, expect, it } from "vitest";
import { inboundRequestAllowed } from "../../src/server/http.js";

describe("inboundRequestAllowed", () => {
  it("allows a loopback client with no Origin", () => {
    expect(
      inboundRequestAllowed({
        hostHeader: "127.0.0.1:8787",
        originHeader: undefined,
        bindHost: "127.0.0.1",
        port: 8787,
      }),
    ).toBe(true);
    expect(
      inboundRequestAllowed({
        hostHeader: "localhost:8787",
        originHeader: undefined,
        bindHost: "127.0.0.1",
        port: 8787,
      }),
    ).toBe(true);
  });

  it("rejects a DNS-rebinding origin and a foreign host on loopback", () => {
    expect(
      inboundRequestAllowed({
        hostHeader: "127.0.0.1:8787",
        originHeader: "http://evil.com",
        bindHost: "0.0.0.0",
        port: 8787,
      }),
    ).toBe(false);
    expect(
      inboundRequestAllowed({
        hostHeader: "evil.com:8787",
        originHeader: undefined,
        bindHost: "127.0.0.1",
        port: 8787,
      }),
    ).toBe(false);
    expect(
      inboundRequestAllowed({
        hostHeader: "127.0.0.1:8787",
        originHeader: "null",
        bindHost: "127.0.0.1",
        port: 8787,
      }),
    ).toBe(false);
  });

  it("allows a non-browser client on an open bind", () => {
    expect(
      inboundRequestAllowed({
        hostHeader: "192.168.1.5:8787",
        originHeader: undefined,
        bindHost: "0.0.0.0",
        port: 8787,
      }),
    ).toBe(true);
    expect(
      inboundRequestAllowed({
        hostHeader: "127.0.0.1:8787",
        originHeader: "http://127.0.0.1:8787",
        bindHost: "127.0.0.1",
        port: 8787,
      }),
    ).toBe(true);
  });
});
