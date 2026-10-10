import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TooltrimConfig } from "../config/schema.js";

export interface ShrinkOptions {
  mode: "off" | "rules" | "llm";
  maxDescriptionChars: number;
  dedupeSchemas: boolean;
  cachePath?: string;
}

export interface ShrinkResult {
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ShrinkableTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface CacheFile {
  version: 1;
  entries: Record<string, string>;
}

const BOILERPLATE_PREFIXES = [
  /^this\s+(tool|function|endpoint|operation|method|api|service)\s+/i,
  /^use\s+this\s+(tool|function|when)\s+/i,
  /^use\s+(when|to)\s+/i,
];

/**
 * Boilerplate phrases that add no information and can safely be deleted
 * anywhere in the text. Order matters: longer phrases first so we don't
 * leave dangling fragments.
 */
const BOILERPLATE_PHRASES: RegExp[] = [
  /\breturns?\s+(an?\s+)?(json\s+|javascript\s+)?object\s+(containing|with|that\s+contains)\s+/gi,
  /\breturns?\s+(an?\s+)?(json\s+)?(response|result)\s+(containing|with)\s+/gi,
  /\breturns?\s+(an?\s+)?(json\s+|javascript\s+)?object\b/gi,
  /\bthis\s+(tool|function|method|api|service|endpoint|operation)\s+/gi,
];

// Closing tags, tags with attributes, and a short list of common tags.
// `List<User>` has none of those, so type parameters stay intact.
const HTML_TAG =
  /<\/?[A-Za-z][^>]*\s[^>]*>|<\/[A-Za-z][^>]*>|<[A-Za-z][^>]*\/>|<(?:br|hr|p|li|ul|ol|div|span|code|pre|em|strong|b|i|a|img|blockquote|h[1-6])>/gi;

const FILLER_PHRASES: Array<[RegExp, string]> = [
  [/\bplease\s+/gi, ""],
  [/\bnote\s+that\s+/gi, ""],
  [/\bin\s+order\s+to\b/gi, "to"],
  [/\butilize[sd]?\b/gi, "use"],
  [/\bperform\s+a\s+/gi, ""],
  [/\bthe\s+following\s+/gi, ""],
];

/**
 * Deterministic, content-addressable description and schema shrinker.
 *
 * v0.1 only ships the "rules" mode. The "llm" mode is wired but defers to the
 * cache: if a hash isn't cached the original is returned and a warning is
 * logged so the user can populate the cache offline.
 */
export class Shrinker {
  private readonly opts: ShrinkOptions;
  private cache: CacheFile = { version: 1, entries: {} };
  private cacheDirty = false;
  private cacheLoaded = false;

  constructor(opts: ShrinkOptions) {
    this.opts = opts;
  }

  static fromConfig(cfg: TooltrimConfig): Shrinker {
    return new Shrinker({
      mode: cfg.shrink.mode,
      maxDescriptionChars: cfg.shrink.maxDescriptionChars,
      dedupeSchemas: cfg.shrink.dedupeSchemas,
      cachePath: cfg.shrink.cachePath,
    });
  }

  async loadCache(): Promise<void> {
    if (this.cacheLoaded || !this.opts.cachePath) {
      this.cacheLoaded = true;
      return;
    }
    try {
      const text = await readFile(this.opts.cachePath, "utf8");
      const parsed = JSON.parse(text) as CacheFile;
      if (parsed && parsed.version === 1 && parsed.entries) {
        this.cache = parsed;
      }
    } catch {
      // missing cache is fine
    }
    this.cacheLoaded = true;
  }

  async flushCache(): Promise<void> {
    if (!this.cacheDirty || !this.opts.cachePath) return;
    await mkdir(path.dirname(this.opts.cachePath), { recursive: true });
    await writeFile(this.opts.cachePath, JSON.stringify(this.cache, null, 2));
    this.cacheDirty = false;
  }

  /**
   * Shrink a single tool. Returns a *new* object — never mutates input.
   */
  shrinkTool<T extends ShrinkableTool>(tool: T, perToolMaxChars?: number): T {
    if (this.opts.mode === "off") return tool;

    const maxChars = perToolMaxChars ?? this.opts.maxDescriptionChars;
    const out: T = { ...tool };

    if (typeof tool.description === "string") {
      out.description = this.shrinkDescription(tool.description, maxChars);
    }
    if (tool.inputSchema && this.opts.dedupeSchemas) {
      out.inputSchema = this.dedupeSchema(tool.inputSchema);
    }
    if (tool.outputSchema && this.opts.dedupeSchemas) {
      out.outputSchema = this.dedupeSchema(tool.outputSchema);
    }
    return out;
  }

  shrinkDescription(input: string, maxChars: number): string {
    if (this.opts.mode === "off") return input;
    const cacheKey = `desc:${maxChars}:${this.hash(input)}`;
    const cached = this.cache.entries[cacheKey];
    if (cached !== undefined) return cached;

    if (this.opts.mode === "llm") {
      // A miss must stay a miss. Caching the original would hide a later offline fill.
      return input;
    }
    const result = this.applyRules(input, maxChars);

    this.cache.entries[cacheKey] = result;
    this.cacheDirty = true;
    return result;
  }

  private applyRules(input: string, maxChars: number): string {
    let s = input;

    // 1. strip code-fence markers and html tags
    s = s.replace(/```[\s\S]*?```/g, " ");
    s = s.replace(HTML_TAG, " ");

    // 2. strip markdown decoration
    s = s.replace(/^#{1,6}\s+/gm, ""); // headings
    s = s.replace(/\*\*(.+?)\*\*/g, "$1"); // bold
    s = s.replace(/\*([^*\n]+)\*/g, "$1"); // italic. `_` stays: it is snake_case and __init__, not emphasis.
    s = s.replace(/`([^`]+)`/g, "$1"); // inline code
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // images
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links

    // 3. collapse whitespace
    s = s.replace(/\s+/g, " ").trim();

    // 4. drop boilerplate prefixes
    for (const re of BOILERPLATE_PREFIXES) {
      s = s.replace(re, "");
    }
    // 5. drop boilerplate phrases anywhere in the text
    for (const re of BOILERPLATE_PHRASES) {
      s = s.replace(re, "");
    }
    // 6. filler phrases
    for (const [re, repl] of FILLER_PHRASES) {
      s = s.replace(re, repl);
    }
    // 7. drop sentences that became empty after stripping
    s = s
      .split(/(?<=[.!?])\s+/)
      .map((sent) => sent.trim())
      .filter((sent) => sent.replace(/[\s.!?]/g, "").length > 0)
      .join(" ");
    s = s.replace(/\s+/g, " ").trim();

    // 8. capitalise first letter for readability
    if (s.length > 0) s = s[0]!.toUpperCase() + s.slice(1);

    // 9. truncate at the first sentence boundary past `maxChars`
    if (s.length > maxChars) {
      let sliceEnd = this.findSentenceEnd(s, maxChars);
      // Finish a nearby sentence, but a single huge sentence must still stop.
      if (sliceEnd > maxChars * 2) sliceEnd = maxChars;
      s = s.slice(0, sliceEnd).trimEnd();
      if (!/[.!?…]$/.test(s)) s += "…";
    }
    return s;
  }

  private findSentenceEnd(s: string, minChars: number): number {
    for (let i = minChars; i < s.length; i++) {
      const ch = s[i];
      if (ch === "." || ch === "!" || ch === "?") {
        return i + 1;
      }
    }
    return Math.min(s.length, minChars);
  }

  /**
   * Deduplicate JSON-Schema sub-trees: if the same sub-schema appears 2+ times,
   * hoist it under `$defs` and replace with `$ref`. Only schemas that contain
   * a `type` and at least one of `properties|items|enum|oneOf|anyOf|allOf` are
   * candidates — primitives are too cheap to dedupe.
   */
  dedupeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!this.opts.dedupeSchemas) return schema;
    const counts = new Map<string, { count: number; sample: unknown }>();
    const root = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (this.isDedupeCandidate(obj)) {
        const key = this.hash(obj);
        const existing = counts.get(key);
        if (existing) existing.count++;
        else counts.set(key, { count: 1, sample: obj });
      }
      for (const v of Object.values(obj)) visit(v);
    };
    visit(root);

    const priorDefs = { ...((root.$defs as Record<string, unknown> | undefined) ?? {}) };
    delete root.$defs;
    const defs: Record<string, unknown> = { ...priorDefs };
    const refMap = new Map<string, string>();
    let nextId = Object.keys(defs).length;
    for (const [hash, info] of counts) {
      if (info.count >= 2) {
        const id = `mdShared${nextId++}`;
        defs[id] = JSON.parse(JSON.stringify(info.sample)) as unknown;
        refMap.set(hash, id);
      }
    }
    if (refMap.size === 0) return schema;

    const replace = (node: unknown): unknown => {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map(replace);
      const obj = node as Record<string, unknown>;
      if (this.isDedupeCandidate(obj)) {
        const id = refMap.get(this.hash(obj));
        if (id) return { $ref: `#/$defs/${id}` };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = replace(v);
      return out;
    };

    const dedupedRoot = replace(root) as Record<string, unknown>;
    dedupedRoot.$defs = defs;
    return dedupedRoot;
  }

  private isDedupeCandidate(obj: Record<string, unknown>): boolean {
    if ("$ref" in obj) return false;
    const type = obj.type;
    if (type !== "object" && type !== "array") return false;
    return (
      "properties" in obj ||
      "items" in obj ||
      "enum" in obj ||
      "oneOf" in obj ||
      "anyOf" in obj ||
      "allOf" in obj
    );
  }

  private hash(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha256").update(text).digest("hex").slice(0, 24);
  }
}
