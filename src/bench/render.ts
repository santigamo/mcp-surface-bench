// The report, as Markdown, from meta.json and the finished runs. Pure.
import { SERVER_NAME } from "./server.ts";
import { count, figure, mean, median, oneDecimal, seconds, tokens, usd } from "./stats.ts";
import type { Meta, RunResult } from "./types.ts";

const GRADED = new Set(["pass", "fail", "timeout", "error"]);
const FAILED = new Set(["fail", "timeout", "error"]);

type Column = { group: string; surface: string; runs: RunResult[] };

const groupOf = (r: RunResult) => `${r.client} · ${r.model} · tool search ${r.toolSearch}`;
const runName = (r: RunResult) => `${r.task} / ${r.surface} #${r.rep}`;
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const table = (head: string[], rows: string[][]) => [head, head.map(() => "---"), ...rows].map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");

export function renderReport(meta: Meta, runs: RunResult[]): string {
  const columns = columnsOf(meta, runs);
  const several = new Set(columns.map((c) => c.group)).size > 1;
  const name = (c: Column) => (several ? `${c.surface} (${c.group})` : c.surface);
  const out: string[] = [];

  out.push(`# ${meta.label}`, "");
  out.push(
    `${runs.length} finished runs on ${meta.today}. Client ${meta.client.name} ${meta.client.version}, model ${meta.options.model ?? "the client's default"}, tool search ${meta.options.toolSearch}, ` +
      `${meta.options.n} rep(s), seed ${meta.options.seed}. Commit ${meta.git.commit.slice(0, 10)}${meta.git.dirty ? " (uncommitted changes)" : ""}. ` +
      `Catalog: ${meta.catalog.tools} tools from ${meta.catalog.source}.`,
    "",
    "Each figure is followed by the number of runs behind it in brackets. With a handful of runs a median moves with a single run: read differences between surfaces as indications, not measurements.",
    "",
  );
  if (!several && columns[0]) out.push(`**${columns[0].group}**`, "");

  out.push("## Summary", "");
  out.push(table(
    ["Surface", "Runs", "Passed", "Server calls, median", "Server calls, mean", "Model tool calls, median", "Context processed, median", "Output tokens, median", "Wall time, median", "Cost, median", "Tool listing"],
    columns.map((c) => {
      const graded = c.runs.filter((r) => GRADED.has(r.status));
      const used = c.runs.filter((r) => r.usage);
      const listing = meta.listings[c.surface];
      return [
        name(c),
        String(c.runs.length),
        graded.length ? `${graded.filter((r) => r.status === "pass").length}/${graded.length}` : "–",
        figure(c.runs.map((r) => r.trace.calls), median, count),
        figure(c.runs.map((r) => r.trace.calls), mean, oneDecimal),
        figure(c.runs.map((r) => r.modelToolCalls), median, count),
        figure(used.map((r) => r.usage!.contextProcessed), median, tokens),
        figure(used.map((r) => r.usage!.output), median, tokens),
        figure(c.runs.map((r) => r.wallSeconds), median, seconds),
        figure(c.runs.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd])), median, usd),
        listing ? `${listing.tools} tools, ${tokens(listing.bytes)} bytes (≈${tokens(listing.approxTokens)} tokens at 4 bytes each)` : "–",
      ];
    }),
  ));
  out.push(
    "",
    "Server calls are the calls the mock answered, from its trace: on `code` each `api.*` call inside an execute counts. Model tool calls are the calls the model itself made. " +
      "Context processed is input + cache read + cache creation + output tokens, summed over the run's requests. The listing size is approximate; the model sees the tools as the client wraps them.",
    "",
  );

  out.push("## What the model started with", "");
  out.push(table(
    ["Surface", "Tools at start, median", "Server tools at start, median", "First request's context, median", "Tools from outside the server"],
    columns.map((c) => {
      const mine = (t: string) => t.startsWith(`mcp__${SERVER_NAME}`);
      const others = [...new Set(c.runs.flatMap((r) => r.startTools.filter((t) => !mine(t))))].sort();
      return [
        name(c),
        figure(c.runs.filter((r) => r.startTools.length).map((r) => r.startTools.length), median, count),
        figure(c.runs.filter((r) => r.startTools.length).map((r) => r.startTools.filter(mine).length), median, count),
        figure(c.runs.flatMap((r) => (r.firstContext === undefined ? [] : [r.firstContext])), median, tokens),
        others.length ? others.join(", ") : "none",
      ];
    }),
  ));
  out.push("");

  const tasks = [...new Set(runs.filter((r) => GRADED.has(r.status)).map((r) => r.task))].sort();
  if (tasks.length) {
    out.push("## Passes by task", "");
    out.push(table(["Task", ...columns.map(name)], tasks.map((t) => [t, ...columns.map((c) => {
      const graded = c.runs.filter((r) => r.task === t && GRADED.has(r.status));
      return graded.length ? `${graded.filter((r) => r.status === "pass").length}/${graded.length}` : "–";
    })])));
    out.push("");
  }

  const failed = runs.filter((r) => FAILED.has(r.status)).sort((a, b) => runName(a).localeCompare(runName(b)));
  out.push("## Failed runs", "");
  if (!failed.length) out.push("None.");
  for (const r of failed) {
    out.push(`- **${runName(r)}**${several ? ` (${groupOf(r)})` : ""}: ${r.status}${r.error ? `. ${r.error.slice(0, 300)}` : ""}`);
    for (const c of r.checks.filter((c) => !c.pass)) out.push(`  - ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  out.push("");

  out.push("## What the mock could not serve", "");
  const gaps = new Map<string, { tool: string; input: string; outcome: string; calls: number; runs: Set<string> }>();
  for (const r of runs) for (const g of r.trace.gaps) {
    const key = `${g.tool}\u0000${g.input ?? ""}\u0000${g.outcome}`;
    const entry = gaps.get(key) ?? { tool: g.tool, input: g.input ?? "(the whole tool)", outcome: g.outcome, calls: 0, runs: new Set<string>() };
    entry.calls++;
    entry.runs.add(`${runName(r)}${several ? ` (${groupOf(r)})` : ""}: ${r.status}`);
    gaps.set(key, entry);
  }
  if (!gaps.size) out.push("Every call reached a tool and inputs the mock implements.");
  else {
    out.push("Calls that a real server would have answered and the mock refused. A run that hit one may have failed, or taken longer, because of the mock rather than the surface.", "");
    out.push(table(["Tool", "Input", "Outcome", "Calls", "Runs"], [...gaps.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).map((g) => [g.tool, g.input, g.outcome, String(g.calls), [...g.runs].sort().join("; ")])));
  }
  out.push("");
  return out.join("\n");
}

/** The line printed when a run finishes. */
export function runLine(i: number, of: number, r: RunResult): string {
  const parts = [
    `[${i}/${of}] ${runName(r)}: ${r.status}`,
    seconds(r.wallSeconds),
    `server calls ${r.trace.calls}`,
    `model calls ${r.modelToolCalls}`,
    r.usage ? `context ${tokens(r.usage.contextProcessed)}, output ${tokens(r.usage.output)}` : "no usage",
    ...(r.costUsd !== undefined ? [usd(r.costUsd)] : []),
    ...(r.error ? [`error: ${r.error.slice(0, 120)}`] : []),
    `answer: ${JSON.stringify(r.answer.slice(0, 80))}`,
  ];
  return parts.join(" · ");
}

/** One column per (client, model, tool search) and surface, in the order the options list the surfaces. */
function columnsOf(meta: Meta, runs: RunResult[]): Column[] {
  const groups = [...new Set(runs.map(groupOf))].sort();
  const surfaces = [...meta.options.surfaces, ...new Set(runs.map((r) => r.surface).filter((s) => !meta.options.surfaces.includes(s)))];
  return groups.flatMap((group) => surfaces.map((surface) => ({ group, surface, runs: runs.filter((r) => groupOf(r) === group && r.surface === surface) })).filter((c) => c.runs.length));
}
