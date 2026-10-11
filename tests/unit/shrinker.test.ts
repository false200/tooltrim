import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Shrinker } from "../../src/core/shrinker.js";

const baseOpts = {
  mode: "rules" as const,
  maxDescriptionChars: 80,
  dedupeSchemas: true,
};

describe("Shrinker - description rules", () => {
  it("strips boilerplate prefixes and markdown decoration", () => {
    const s = new Shrinker(baseOpts);
    const out = s.shrinkDescription(
      "**This tool** echoes the provided text back to the caller. Returns a JSON object containing the echoed text.",
      80,
    );
    expect(out.toLowerCase()).not.toMatch(/^this tool/);
    expect(out).not.toContain("**");
    expect(out).not.toContain("Returns a JSON object containing");
  });

  it("removes filler phrases", () => {
    const s = new Shrinker(baseOpts);
    const out = s.shrinkDescription(
      "Please utilize this tool in order to perform a query.",
      120,
    );
    expect(out.toLowerCase()).not.toContain("please");
    expect(out.toLowerCase()).not.toContain("in order to");
    expect(out.toLowerCase()).not.toContain("utilize");
  });

  it("truncates at the first sentence boundary past maxChars", () => {
    const s = new Shrinker({ ...baseOpts, maxDescriptionChars: 30 });
    const desc =
      "Aaaaaa bbbbbbb ccccccc ddddddd eeeeeee. Fffff ggggg hhhhh. Iiiiiiii jjjjjj.";
    const out = s.shrinkDescription(desc, 30);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toMatch(/[.!?…]$/);
  });

  it("is deterministic - same input -> same output", () => {
    const s = new Shrinker(baseOpts);
    const desc =
      "This tool fetches a user. Use this when you need details. Returns a JSON object containing the user.";
    const a = s.shrinkDescription(desc, 80);
    const b = s.shrinkDescription(desc, 80);
    expect(a).toBe(b);
  });

  it("returns input unchanged when mode is 'off'", () => {
    const s = new Shrinker({ ...baseOpts, mode: "off" });
    const desc = "**This tool** is verbose.";
    expect(s.shrinkDescription(desc, 80)).toBe(desc);
  });

  it("keeps snake_case names and type parameters", () => {
    const s = new Shrinker(baseOpts);
    const out = s.shrinkDescription(
      "Pass max_tokens and call __init__. Returns List<User> from <code>id</code>.",
      160,
    );
    expect(out).toContain("max_tokens");
    expect(out).toContain("__init__");
    expect(out).toContain("List<User>");
    expect(out).not.toContain("<code>");
  });

  it("does not keep a whole paragraph when the next period is far away", () => {
    const s = new Shrinker({ ...baseOpts, maxDescriptionChars: 30 });
    const desc = `${"word ".repeat(40).trim()}.`;
    const out = s.shrinkDescription(desc, 30);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not cache an llm miss", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-shrink-"));
    const cachePath = path.join(dir, "cache.json");
    const s = new Shrinker({
      mode: "llm",
      maxDescriptionChars: 40,
      dedupeSchemas: false,
      cachePath,
    });
    await s.loadCache();
    const input = "A long original description that should stay uncached.";
    expect(s.shrinkDescription(input, 40)).toBe(input);
    await s.flushCache();
    await expect(readFile(cachePath, "utf8")).rejects.toThrow();
  });

  it("does not reuse a rules cache entry in llm mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tooltrim-shrink-"));
    const cachePath = path.join(dir, "cache.json");
    const input = "This tool does a thing. It has more words than the cap allows here.";
    const rules = new Shrinker({
      mode: "rules",
      maxDescriptionChars: 40,
      dedupeSchemas: false,
      cachePath,
    });
    await rules.loadCache();
    expect(rules.shrinkDescription(input, 40)).not.toBe(input);
    await rules.flushCache();

    const llm = new Shrinker({
      mode: "llm",
      maxDescriptionChars: 40,
      dedupeSchemas: false,
      cachePath,
    });
    await llm.loadCache();
    expect(llm.shrinkDescription(input, 40)).toBe(input);
  });
});

describe("Shrinker - schema dedup", () => {
  it("hoists repeated sub-schemas into $defs and replaces with $ref", () => {
    const s = new Shrinker(baseOpts);
    const userSchema = {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    };
    const schema = {
      type: "object",
      properties: {
        author: userSchema,
        reviewer: userSchema,
        title: { type: "string" },
      },
    };
    const out = s.dedupeSchema(schema as any) as any;
    const props = out.properties;
    expect(out.$defs).toBeTruthy();
    const defKeys = Object.keys(out.$defs);
    expect(defKeys.length).toBeGreaterThanOrEqual(1);
    expect(props.author.$ref).toMatch(/^#\/\$defs\//);
    expect(props.reviewer.$ref).toBe(props.author.$ref);
  });

  it("does not turn an existing $defs entry into a self-reference", () => {
    const s = new Shrinker(baseOpts);
    const userSchema = {
      type: "object",
      properties: { id: { type: "string" } },
    };
    const schema = {
      type: "object",
      $defs: { Existing: { type: "object", properties: { z: { type: "string" } } } },
      properties: { author: userSchema, reviewer: userSchema },
    };
    const out = s.dedupeSchema(schema as any) as any;
    const ref = out.properties.author.$ref as string;
    const id = ref.replace("#/$defs/", "");
    expect(out.$defs[id].type).toBe("object");
    expect(out.$defs[id].$ref).toBeUndefined();
    expect(out.$defs.Existing.properties.z.type).toBe("string");
  });

  it("leaves single-occurrence schemas alone", () => {
    const s = new Shrinker(baseOpts);
    const schema = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    const out = s.dedupeSchema(schema as any) as any;
    expect(out.$defs).toBeUndefined();
    expect(out.properties.x.type).toBe("string");
  });
});

describe("Shrinker.shrinkTool", () => {
  it("never mutates the input", () => {
    const s = new Shrinker(baseOpts);
    const tool = {
      name: "echo",
      description: "**This tool** echoes text.",
      inputSchema: {
        type: "object" as const,
        properties: { text: { type: "string" } },
      },
    };
    const original = structuredClone(tool);
    s.shrinkTool(tool);
    expect(tool).toEqual(original);
  });
});
