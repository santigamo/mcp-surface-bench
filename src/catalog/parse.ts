import type { FieldRow, ToolDoc } from "./types.ts";

const HEADER = /^`([a-z0-9-]+)`, an? (read|write) tool\.(?: Also reaches: (.+)\.)?$/m;

/** Splits a markdown table row on unescaped pipes and unescapes the cells. */
function cells(line: string): string[] {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim().replaceAll("\\|", "|"));
}

/**
 * `string`, `string[]` or null, `enum`: `A`, `B`, `enum[]` or null: `A`, `B`.
 * The type keeps its documented wording; enum values are split out.
 */
function parseType(cell: string): Pick<FieldRow, "type" | "values"> {
  const m = /^`([^`]+)`( or null)?(?:: (.+))?$/.exec(cell);
  if (!m) throw new Error(`unreadable type cell: ${cell}`);
  const [, base, nullable, list] = m;
  const type = base + (nullable ?? "");
  if (!list) return { type };
  const values = [...list.matchAll(/`([^`]*)`/g)].map((v) => v[1]!);
  if (!values.length) throw new Error(`enum without values: ${cell}`);
  return { type, values };
}

function parseRow(line: string): FieldRow {
  const c = cells(line);
  if (c.length !== 4) throw new Error(`expected 4 cells, got ${c.length}: ${line}`);
  const path = /^`([^`]+)`$/.exec(c[0]!)?.[1];
  if (!path) throw new Error(`unreadable field cell: ${c[0]}`);
  return { path, ...parseType(c[1]!), flag: c[2]!, description: c[3]! };
}

type Section = { heading: string; level: number; lines: string[] };

function sections(markdown: string): Section[] {
  const out: Section[] = [];
  for (const line of markdown.split("\n")) {
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) out.push({ heading: h[2]!.trim(), level: h[1]!.length, lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

const rowsOf = (s: Section) => s.lines.filter((l) => l.startsWith("| `")).map(parseRow);

/** Reads one tool documentation page. Throws on anything it does not understand, so nothing is dropped silently. */
export function parseToolPage(markdown: string): ToolDoc {
  const head = HEADER.exec(markdown);
  if (!head) throw new Error("no tool header line");
  const all = sections(markdown);
  const title = all.find((s) => s.level === 1)?.heading;
  if (!title) throw new Error("no title");

  const at = (name: string) => all.findIndex((s) => s.level === 2 && s.heading === name);
  const [iIn, iOut, iAi] = [at("Inputs"), at("Output"), at("What the AI reads")];
  if (iIn < 0 || iOut < 0 || iAi < 0 || !(iIn < iOut && iOut < iAi)) throw new Error("unexpected page layout");

  const outSections = all.slice(iOut, iAi);
  const direct = rowsOf(outSections[0]!);
  const shaped = outSections.slice(1).map((s) => ({ label: s.heading, rows: rowsOf(s) }));
  if (direct.length && shaped.length) throw new Error("output has both a table and named shapes");
  const outputs = shaped.length ? shaped : [{ label: "Result", rows: direct }];
  if (outputs.some((o) => !o.rows.length)) throw new Error("empty output table");

  const description = all[iAi]!.lines.join("\n").trim();
  if (!description) throw new Error("empty description");

  return {
    name: head[1]!,
    title,
    kind: head[2] as "read" | "write",
    reaches: head[3]?.split(", ") ?? [],
    description,
    inputs: rowsOf(all[iIn]!),
    outputs,
  };
}

/** The inputs every tool shares, from the conventions page: `| field | Required | Description |`. */
export function parseCommonInputs(markdown: string): { name: string; required: boolean; description: string }[] {
  const s = sections(markdown).find((x) => x.heading === "Common inputs");
  if (!s) throw new Error("no Common inputs section");
  return s.lines
    .filter((l) => l.startsWith("| `"))
    .map((l) => {
      const c = l.split(/(?<!\\)\|/).slice(1, -1).map((x) => x.trim());
      if (c.length !== 3) throw new Error(`unexpected common input row: ${l}`);
      return { name: c[0]!.replaceAll("`", ""), required: c[1] === "Yes", description: c[2]! };
    });
}
