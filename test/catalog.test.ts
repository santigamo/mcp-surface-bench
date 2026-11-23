import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { loadCatalog, VENDOR_DIR } from "../src/catalog/index.ts";
import { parseToolPage } from "../src/catalog/parse.ts";
import { rowsFromSchema, schemaFromRows } from "../src/catalog/schema.ts";

const catalog = loadCatalog();
const strip = (rows: { path: string; type: string; values?: string[]; flag: string }[]) =>
  rows.map(({ path, type, values, flag }) => ({ path, type, flag, ...(values ? { values } : {}) }));

describe("catalog", () => {
  test("every tool in the documentation index is registered, once", () => {
    const index = readFileSync(join(VENDOR_DIR, "source.json"), "utf8");
    expect(catalog.tools.length).toBe(JSON.parse(index).tools);
    expect(new Set(catalog.tools.map((t) => t.name)).size).toBe(catalog.tools.length);
    expect(catalog.tools.every((t) => t.name.startsWith(catalog.prefix))).toBe(true);
  });

  test("tool names are valid MCP tool names", () => {
    for (const t of catalog.tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("the description is the documented model-facing text, verbatim", () => {
    for (const t of catalog.tools) {
      const page = readFileSync(join(VENDOR_DIR, "tools", `${t.name.slice(catalog.prefix.length)}.md`), "utf8");
      expect(page.endsWith(`## What the AI reads\n\n${t.description}\n`) || page.endsWith(`## What the AI reads\n\n${t.description}`)).toBe(true);
    }
  });

  test("input schemas round-trip to the documented rows: no field, type, enum value or required flag is lost", () => {
    for (const t of catalog.tools) expect(rowsFromSchema(t.ownInputSchema, "input")).toEqual(strip(t.inputs));
  });

  test("output schemas round-trip to the documented rows", () => {
    for (const t of catalog.tools) {
      const page = parseToolPage(readFileSync(join(VENDOR_DIR, "tools", `${t.name.slice(catalog.prefix.length)}.md`), "utf8"));
      for (const shape of page.outputs) expect(rowsFromSchema(schemaFromRows(shape.rows, "output"), "output")).toEqual(strip(shape.rows));
    }
  });

  test("every input description reaches the model", () => {
    for (const t of catalog.tools) {
      const described = t.inputs.filter((r) => r.description).length;
      const count = (s: any): number => (s?.description ? 1 : 0) + Object.values(s?.properties ?? {}).reduce((n: number, c) => n + count(c), 0) + (s?.items ? count(s.items) - (s.items.description ? 1 : 0) : 0);
      expect(count(t.ownInputSchema)).toBe(described);
    }
  });

  test("every tool takes the shared inputs, and they are required", () => {
    for (const t of catalog.tools) {
      expect(Object.keys(t.inputSchema.properties!).slice(0, 2)).toEqual(["intent", "userSatisfactionEstimate"]);
      expect(t.inputSchema.required).toContain("intent");
      expect(t.inputSchema.required).toContain("userSatisfactionEstimate");
    }
  });

  test("every schema compiles as JSON Schema", () => {
    const ajv = new Ajv({ strict: true, allowUnionTypes: true });
    for (const t of catalog.tools) {
      expect(() => ajv.compile(t.inputSchema)).not.toThrow();
      expect(() => ajv.compile(t.outputSchema)).not.toThrow();
    }
  });
});
