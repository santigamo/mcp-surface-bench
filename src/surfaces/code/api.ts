// The catalog as a programming interface: one function per tool, with TypeScript signatures and a search over them.
import { shortName, type Catalog, type JsonSchema, type ToolSpec } from "../../catalog/index.ts";

export type ApiFunction = { fn: string; short: string; spec: ToolSpec; summary: string };

/** `search-sales-orders` -> `searchSalesOrders`. */
export const functionName = (short: string) => short.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const firstSentence = (text: string) => {
  const end = text.search(/\.(\s|$)/);
  return (end < 0 ? text : text.slice(0, end + 1)).slice(0, 240);
};

/**
 * Builds the function list. A description that points at another tool by its registered name
 * (`acme-search-products`) is rewritten to point at the function that tool became (`api.searchProducts`).
 */
export function buildApi(catalog: Catalog): ApiFunction[] {
  const known = new Set(catalog.tools.map((t) => t.name));
  const mention = new RegExp(`${catalog.prefix}[a-z0-9]+(?:-[a-z0-9]+)*`, "g");
  const renamed = (text: string) => text.replace(mention, (name) => (known.has(name) ? `api.${functionName(shortName(catalog, name))}` : name));
  const rewrite = (s: JsonSchema): JsonSchema => ({
    ...s,
    ...(s.description ? { description: renamed(s.description) } : {}),
    ...(s.properties ? { properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, rewrite(v)])) } : {}),
    ...(s.items ? { items: rewrite(s.items) } : {}),
    ...(s.anyOf ? { anyOf: s.anyOf.map(rewrite) } : {}),
  });
  return catalog.tools.map((t) => {
    const short = shortName(catalog, t.name);
    const spec = { ...t, description: renamed(t.description), ownInputSchema: rewrite(t.ownInputSchema) };
    return { fn: functionName(short), short, spec, summary: firstSentence(spec.description) };
  });
}

// ---------- TypeScript rendering ----------

const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

/** A JSON Schema as a TypeScript type. `docs` adds each field's description as a comment, one field per line. */
export function tsType(s: JsonSchema, docs: boolean, depth = 0): string {
  if (s.anyOf) return s.anyOf.map((a) => tsType(a, docs, depth)).join(" | ");
  if (s.enum) return s.enum.map((v) => (v === null ? "null" : JSON.stringify(v))).join(" | ");
  if (Array.isArray(s.type)) return s.type.map((t) => tsType({ ...s, type: t }, docs, depth)).join(" | ");
  switch (s.type) {
    case undefined: return "unknown";
    case "integer": return "number";
    case "string": case "number": case "boolean": case "null": return s.type;
    case "array": {
      const inner = tsType(s.items ?? {}, docs, depth);
      return /[ |]/.test(inner) && !inner.startsWith("{") ? `(${inner})[]` : `${inner}[]`;
    }
    case "object": {
      const props = Object.entries(s.properties ?? {});
      if (!props.length) return "{}";
      const field = ([k, v]: [string, JsonSchema]) => `${key(k)}${s.required?.includes(k) ? "" : "?"}: ${tsType(v, docs, depth + 1)}`;
      if (!docs) return `{ ${props.map(field).join("; ")} }`;
      const pad = "  ".repeat(depth + 1);
      return `{\n${props.map(([k, v]) => `${v.description ? `${pad}/** ${v.description} */\n` : ""}${pad}${field([k, v])};`).join("\n")}\n${"  ".repeat(depth)}}`;
    }
  }
  throw new Error(`cannot render schema type ${String(s.type)}`);
}

/** The full declaration of one function: what it does, its arguments with their documentation, and its result. */
export function declaration(f: ApiFunction): string {
  const args = tsType(f.spec.ownInputSchema, true);
  return `/**\n * ${f.spec.description}\n */\n${f.spec.kind === "write" ? "// writes data\n" : ""}api.${f.fn}(args: ${args}): Promise<${tsType(f.spec.outputSchema, false)}>`;
}

// ---------- search ----------

const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

/** Ranks functions for a plain-words query: matches in the name count more than matches in the description. */
export function searchApi(api: ApiFunction[], query: string, limit: number): ApiFunction[] {
  const docs = api.map((f) => ({ f, name: new Set(words(f.short)), text: new Set(words(f.spec.description)) }));
  const idf = (w: string) => Math.log(1 + docs.length / (1 + docs.filter((d) => d.name.has(w) || d.text.has(w)).length));
  return docs
    .map((d) => ({ f: d.f, score: [...new Set(words(query))].reduce((n, w) => n + idf(w) * ((d.name.has(w) ? 3 : 0) + (d.text.has(w) ? 1 : 0)), 0) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || a.f.fn.localeCompare(b.f.fn))
    .slice(0, limit)
    .map((d) => d.f);
}
