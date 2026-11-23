import type { FieldRow, JsonSchema } from "./types.ts";

export type Mode = "input" | "output";

const SCALARS = new Set(["string", "boolean", "integer", "number"]);

/** The schema of one documented type, before nullability and requiredness are applied. */
function baseSchema(type: string, values?: string[]): JsonSchema {
  if (SCALARS.has(type)) return { type };
  switch (type) {
    case "enum":
      if (!values) throw new Error("enum without values");
      return { type: "string", enum: values };
    case "object":
      return { type: "object", properties: {}, additionalProperties: false };
    case "string or number":
      return { type: ["string", "number"] };
    case "string or string[]":
      return { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
    case "(object or object)[]":
      return { type: "array", items: { anyOf: [] } };
    case "any":
      return {};
  }
  if (type.endsWith("[]")) return { type: "array", items: baseSchema(type.slice(0, -2), values) };
  throw new Error(`unknown documented type: ${type}`);
}

function nullable(s: JsonSchema): JsonSchema {
  if (s.anyOf) return { ...s, anyOf: [...s.anyOf, { type: "null" }] };
  if (s.type === undefined) return s; // `any` already admits null
  const types = Array.isArray(s.type) ? s.type : [s.type];
  return { ...s, type: [...types, "null"], ...(s.enum ? { enum: [...s.enum, null as unknown as string] } : {}) };
}

/** The object schema that a field's children attach to: the field itself, or its array items. */
function container(node: JsonSchema): JsonSchema {
  const target = node.items ?? node;
  if (target.anyOf && node.items) return target.anyOf.at(-1)!; // union of item shapes: the variant being filled
  if (!target.properties) throw new Error("children documented under a field that is not an object");
  return target;
}

const segments = (path: string) => path.split(".").map((s) => s.replace(/\[\]$/, ""));

/**
 * Builds a JSON Schema from documented rows. Objects are closed (`additionalProperties: false`):
 * the documentation lists every field, so an argument it does not list is treated as a mistake.
 */
export function schemaFromRows(rows: FieldRow[], mode: Mode): JsonSchema {
  const root: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
  const unions = new Map<string, { node: JsonSchema; first?: string }>();

  for (const row of rows) {
    const segs = segments(row.path);
    const key = segs.pop()!;
    const parentPath = row.path.slice(0, row.path.lastIndexOf("."));

    let parent = root;
    for (const seg of segs) {
      const next = parent.properties?.[seg];
      if (!next) throw new Error(`field documented before its parent: ${row.path}`);
      parent = container(next);
    }

    // A union array documents each item shape as a run of rows; a repeat of its first child opens the next shape.
    const union = unions.get(parentPath);
    if (union) {
      const shapes = union.node.items!.anyOf!;
      if (union.first === undefined) union.first = row.path;
      if (row.path === union.first) shapes.push({ type: "object", properties: {}, additionalProperties: false });
      parent = shapes.at(-1)!;
    }

    let node = baseSchema(row.type.replace(/ or null$/, ""), row.values);
    if (row.type === "(object or object)[]") unions.set(row.path + "[]", { node });
    if (row.description && mode === "input") node.description = row.description;

    const isNullable = mode === "input" ? row.type.endsWith(" or null") : row.flag === "Can be null" || row.flag === "Null or absent";
    if (isNullable) node = nullable(node);
    if (row.type === "(object or object)[]") unions.get(row.path + "[]")!.node = node;

    const isRequired = mode === "input" ? row.flag === "Yes" : row.flag === "Always" || row.flag === "Can be null";
    if (parent.properties![key]) throw new Error(`field documented twice: ${row.path}`);
    parent.properties![key] = node;
    if (isRequired) (parent.required ??= []).push(key);
  }
  return root;
}

/** The inverse of `schemaFromRows`, used to prove the conversion loses nothing. */
export function rowsFromSchema(schema: JsonSchema, mode: Mode, prefix = ""): Omit<FieldRow, "description">[] {
  const out: Omit<FieldRow, "description">[] = [];
  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    const path = prefix + key;
    const required = schema.required?.includes(key) ?? false;
    const { node, isNull } = stripNull(raw);
    const { type, values, children } = describe(node);

    const flag =
      mode === "input"
        ? required ? "Yes" : "No"
        : required ? (isNull ? "Can be null" : "Always") : isNull ? "Null or absent" : "Can be absent";
    out.push({ path, type: mode === "input" && isNull ? `${type} or null` : type, ...(values ? { values } : {}), flag });
    for (const child of children) out.push(...rowsFromSchema(child, mode, path + (node.type === "array" ? "[]." : ".")));
  }
  return out;
}

function stripNull(s: JsonSchema): { node: JsonSchema; isNull: boolean } {
  if (s.anyOf?.some((a) => a.type === "null")) return { node: { ...s, anyOf: s.anyOf.filter((a) => a.type !== "null") }, isNull: true };
  if (Array.isArray(s.type) && s.type.includes("null")) {
    const rest = s.type.filter((t) => t !== "null");
    const node: JsonSchema = { ...s, type: rest.length === 1 ? rest[0]! : rest };
    if (s.enum) node.enum = s.enum.filter((v) => v !== null);
    return { node, isNull: true };
  }
  return { node: s, isNull: false };
}

function describe(s: JsonSchema): { type: string; values?: string[]; children: JsonSchema[] } {
  if (s.anyOf) return { type: "string or string[]", children: [] };
  if (s.type === undefined) return { type: "any", children: [] };
  if (Array.isArray(s.type)) return { type: s.type.join(" or "), children: [] };
  if (s.enum) return { type: "enum", values: s.enum, children: [] };
  if (s.type === "array") {
    const items = s.items!;
    if (items.anyOf) return { type: "(object or object)[]", children: items.anyOf };
    const inner = describe(items);
    return { type: `${inner.type}[]`, ...(inner.values ? { values: inner.values } : {}), children: inner.children };
  }
  if (s.type === "object") return { type: "object", children: [s] };
  return { type: s.type, children: [] };
}

/** One of several documented result shapes. */
export const anyShape = (shapes: JsonSchema[]): JsonSchema => (shapes.length === 1 ? shapes[0]! : { anyOf: shapes });
