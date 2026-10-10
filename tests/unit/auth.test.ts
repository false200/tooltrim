import { describe, expect, it } from "vitest";
import {
  resolvePassthroughAuthorization,
  runWithInboundContext,
} from "../../src/upstream/manager.js";

describe("inbound auth context", () => {
  it("uses policy.defaultAuth when the server omits auth", async () => {
    await runWithInboundContext({ authorization: "Bearer a" }, async () => {
      expect(resolvePassthroughAuthorization(undefined, "passthrough")).toBe("Bearer a");
      expect(resolvePassthroughAuthorization(undefined, "none")).toBeUndefined();
      expect(resolvePassthroughAuthorization("none", "passthrough")).toBeUndefined();
      expect(resolvePassthroughAuthorization("passthrough", "none")).toBe("Bearer a");
    });
  });

  it("keeps concurrent requests on their own tokens", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithInboundContext({ authorization: "Bearer a" }, async () => {
        await new Promise((r) => setTimeout(r, 20));
        seen.push(resolvePassthroughAuthorization(undefined, "passthrough") ?? "missing-a");
      }),
      runWithInboundContext({ authorization: "Bearer b" }, async () => {
        seen.push(resolvePassthroughAuthorization(undefined, "passthrough") ?? "missing-b");
        await new Promise((r) => setTimeout(r, 20));
      }),
    ]);
    expect(seen.slice().sort()).toEqual(["Bearer a", "Bearer b"]);
  });
});
