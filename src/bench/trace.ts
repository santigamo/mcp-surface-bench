// What the server saw: the runtime's trace.jsonl, summarised.
import { existsSync, readFileSync } from "node:fs";
import type { Outcome, TraceRow } from "../core/runtime.ts";
import type { Gap, TraceSummary } from "./types.ts";

export const OUTCOMES: readonly Outcome[] = ["ok", "tool_error", "invalid_arguments", "unknown_tool", "unimplemented", "unsupported_input"];

export const readTrace = (path: string): TraceRow[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as TraceRow) : [];

export function summarizeTrace(rows: Pick<TraceRow, "tool" | "outcome" | "error">[]): TraceSummary {
  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const gaps: Gap[] = [];
  for (const r of rows) {
    byOutcome[r.outcome]++;
    if (r.outcome === "unimplemented") gaps.push({ tool: r.tool, outcome: r.outcome, input: null });
    if (r.outcome === "unsupported_input") for (const input of unsupportedInputs(r.error)) gaps.push({ tool: r.tool, outcome: r.outcome, input });
  }
  return { calls: rows.length, byOutcome, tools: rows.map((r) => r.tool), gaps };
}

/** The inputs named in the runtime's refusal: `…does not implement "a", "b" on distru-x. Inputs it implements: …`. */
function unsupportedInputs(error = ""): string[] {
  const named = /does not implement (.*?) on /.exec(error)?.[1];
  const inputs = named ? [...named.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [];
  return inputs.length ? inputs : ["(unreadable)"];
}
