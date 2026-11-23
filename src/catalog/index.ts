import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCommonInputs, parseToolPage } from "./parse.ts";
import { anyShape, schemaFromRows } from "./schema.ts";
import type { Catalog, JsonSchema, ToolSpec } from "./types.ts";

export type * from "./types.ts";
export const VENDOR_DIR = resolve(import.meta.dir, "../../vendor");

/**
 * The documentation gives the shared inputs a name, a required flag and a description, but no type.
 * These are the types their descriptions imply.
 */
const COMMON_TYPES: Record<string, JsonSchema> = {
  intent: { type: "string" },
  userSatisfactionEstimate: { type: "integer", minimum: 1, maximum: 5 },
};

function longestCommonPrefix(names: string[]): string {
  let p = names[0] ?? "";
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p.slice(0, p.lastIndexOf("-") + 1);
}

/** Builds the catalog from documentation already fetched into `dir`. Pure: same files, same catalog. */
export function buildCatalog(dir = VENDOR_DIR): Catalog {
  if (!existsSync(join(dir, "tools"))) throw new Error(`no documentation in ${dir}; run: bun run catalog -- --docs <url>`);
  const common = parseCommonInputs(readFileSync(join(dir, "pages/conventions.md"), "utf8"));
  const commonProps: Record<string, JsonSchema> = {};
  for (const c of common) {
    const type = COMMON_TYPES[c.name];
    if (!type) throw new Error(`shared input without a known type: ${c.name}`);
    commonProps[c.name] = { ...type, description: c.description };
  }
  const commonRequired = common.filter((c) => c.required).map((c) => c.name);

  const tools: ToolSpec[] = readdirSync(join(dir, "tools"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      let doc;
      try { doc = parseToolPage(readFileSync(join(dir, "tools", file), "utf8")); }
      catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
      const own = schemaFromRows(doc.inputs, "input");
      const clash = Object.keys(own.properties!).find((k) => k in commonProps);
      if (clash) throw new Error(`${file}: input ${clash} collides with a shared input`);
      return {
        ...doc,
        ownInputSchema: own,
        inputSchema: { ...own, properties: { ...commonProps, ...own.properties }, required: [...commonRequired, ...(own.required ?? [])] },
        outputSchema: anyShape(doc.outputs.map((o) => schemaFromRows(o.rows, "output"))),
      };
    });

  const source = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")).docs as string;
  return { source, prefix: longestCommonPrefix(tools.map((t) => t.name)), tools };
}

let cached: Catalog | undefined;
export const loadCatalog = (): Catalog => (cached ??= buildCatalog());

/** `acme-search-products` -> `search-products`. Suites refer to tools by this short name. */
export const shortName = (catalog: Catalog, name: string) => (name.startsWith(catalog.prefix) ? name.slice(catalog.prefix.length) : name);
