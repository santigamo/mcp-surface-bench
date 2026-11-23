// The report, as Markdown, from meta.json, the finished runs and the regrades. Pure.
import { isRequired } from "./grade.ts";
import { SERVER_NAME } from "./server.ts";
import { count, figure, mean, median, oneDecimal, seconds, share, tokens, usd } from "./stats.ts";
import type { Listing, Meta, RegradePass, RunResult } from "./types.ts";

const GRADED = new Set(["pass", "fail", "timeout", "error"]);
const FAILED = new Set(["fail", "timeout", "error"]);

/** One per arm, in the order the command line gave them; an arm found only in the runs comes after. */
type Column = { arm: string; runs: RunResult[] };

const runName = (r: RunResult) => `${r.task} / ${r.arm} #${r.rep}`;
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const table = (head: string[], rows: string[][]) => [head, head.map(() => "---"), ...rows].map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mine = (t: string) => t.startsWith(`mcp__${SERVER_NAME}`);
/** The client's own tool for finding deferred tools. */
const SEARCH_TOOLS = new Set(["ToolSearch"]);
const passes = (runs: RunResult[]) => {
  const graded = runs.filter((r) => GRADED.has(r.status));
  return { passed: graded.filter((r) => r.status === "pass").length, graded: graded.length };
};
const ratio = ({ passed, graded }: { passed: number; graded: number }) => (graded ? `${passed}/${graded}` : "–");

export function renderReport(meta: Meta, runs: RunResult[], regrades: RegradePass[] = []): string {
  const columns = columnsOf(meta, runs);
  const out: string[] = [];

  out.push(`# ${meta.label}`, "");
  out.push(
    `${plural(runs.length, "finished run")} on ${meta.today}: ${meta.options.n} rep(s) of each task on each arm, the arms in a random order in each (task, rep) block, seed ${meta.options.seed}. ` +
      `Commit ${meta.git.commit.slice(0, 10)}${meta.git.dirty ? " (uncommitted changes)" : ""}. Catalog: ${meta.catalog.tools} tools from ${meta.catalog.source}.`,
    "",
    ...modelLines(meta, runs).map((l) => `- ${l}`),
    "",
  );
  const regraded = regradeLine(regrades);
  if (regraded) out.push(regraded, "");
  out.push("Each figure is followed by the number of runs behind it in brackets. With a handful of runs a median moves with a single run: read differences between arms as indications, not measurements.", "");

  out.push("## Arms", "");
  out.push(table(["Arm", "Surface", "Tool search", "Client setting"], columns.map((c) => {
    const resolved = meta.arms.find((a) => a.name === c.arm) ?? c.runs[0];
    const setting = meta.arms.find((a) => a.name === c.arm)?.setting ?? c.runs[0]?.armSetting ?? "–";
    return [c.arm, resolved?.surface ?? "–", resolved?.toolSearch ?? "–", setting];
  })));
  out.push("");

  out.push("## Summary", "");
  out.push(table(
    ["Arm", "Runs", "Passed", "Server calls, median", "Server calls, mean", "Model tool calls, median", "Context processed, median", "Output tokens, median", "Wall time, median", "Cost, median", "Tool listing"],
    columns.map((c) => {
      const used = c.runs.filter((r) => r.usage);
      const listing = listingOf(meta, c);
      const costs = c.runs.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd]));
      return [
        c.arm,
        String(c.runs.length),
        ratio(passes(c.runs)),
        figure(c.runs.map((r) => r.trace.calls), median, count),
        figure(c.runs.map((r) => r.trace.calls), mean, oneDecimal),
        figure(c.runs.map((r) => r.modelToolCalls), median, count),
        figure(used.map((r) => r.usage!.contextProcessed), median, tokens),
        figure(used.map((r) => r.usage!.output), median, tokens),
        figure(c.runs.map((r) => r.wallSeconds), median, seconds),
        costs.length === c.runs.length ? figure(costs, median, usd) : "–",
        listing ? `${listing.tools} tools, ${tokens(listing.bytes)} bytes (≈${tokens(listing.approxTokens)} tokens at 4 bytes each)` : "–",
      ];
    }),
  ));
  out.push(
    "",
    "Server calls are the calls the mock answered, from its trace: on `code` each `api.*` call inside an execute counts. Model tool calls are the calls the model itself made, the client's tool searches included. " +
      "Context processed is input + cache read + cache creation + output tokens, summed over the run's requests; its parts are in their own section below. The listing size is approximate; the model sees the tools as the client wraps them.",
    "",
    "Cost is the client's estimate (on a subscription, not a charge), shown only for an arm where every run reported one. It depends on cache warmth: a run that follows another of the same arm within the cache's lifetime reads the prompt prefix that run wrote instead of writing it again, " +
      "so an arm's cost depends on the order its runs happened to fall in, not only on the arm. Compare context processed, which does not.",
    "",
  );

  out.push("## What the model started with", "");
  for (const c of columns) out.push(`- **${c.arm}**: ${shownAtStart(c, listingOf(meta, c))}.`);
  out.push("");
  out.push(table(
    ["Arm", "Tools at start, median", "Server tools at start, median", "First request's context, median", "Tools from outside the server"],
    columns.map((c) => {
      const others = [...new Set(c.runs.flatMap((r) => r.startTools.filter((t) => !mine(t))))].sort();
      return [
        c.arm,
        figure(c.runs.filter((r) => r.startTools.length).map((r) => r.startTools.length), median, count),
        figure(c.runs.filter((r) => r.startTools.length).map((r) => r.startTools.filter(mine).length), median, count),
        figure(c.runs.flatMap((r) => (r.firstContext === undefined ? [] : [r.firstContext])), median, tokens),
        others.length ? others.join(", ") : "none",
      ];
    }),
  ));
  out.push("", "From the runs, not from the options: the tools the client said the model had, and the prompt tokens of its first request. Tool definitions the first request does not hold were deferred by the client.", "");

  out.push("## Context processed, by kind", "");
  out.push(table(
    ["Arm", "Uncached input, median", "Cache creation, median", "Cache read, median", "Output, median", "Context processed, median", "Cache read, share of the arm's total"],
    columns.map((c) => {
      const used = c.runs.flatMap((r) => (r.usage ? [r.usage] : []));
      const total = used.reduce((s, u) => s + u.contextProcessed, 0);
      return [
        c.arm,
        figure(used.map((u) => u.input), median, tokens),
        figure(used.map((u) => u.cacheCreation), median, tokens),
        figure(used.map((u) => u.cacheRead), median, tokens),
        figure(used.map((u) => u.output), median, tokens),
        figure(used.map((u) => u.contextProcessed), median, tokens),
        total ? share(used.reduce((s, u) => s + u.cacheRead, 0) / total) : "–",
      ];
    }),
  ));
  out.push(
    "",
    "Cache creation is context written to the cache: sent once, on the request that first holds it. Cache read is context already cached and read again by every later request of the run, so it grows with the number of turns times the size of what the model was given. " +
      "Uncached input is the rest. The split between creation and read depends on cache warmth (an earlier run may have written the prefix); their sum does not. Medians of the parts need not add up to the median of the whole. " +
      "Codex reports cached input but not cache writes.",
    "",
  );

  const searching = columns.filter((c) => c.runs.some((r) => r.toolSearch !== "off"));
  if (searching.length) {
    out.push("## The client's tool search", "");
    out.push(table(
      ["Arm", "Runs that show it", "Tool searches, median", "Searches before the first server call, median", "Server calls, median", "Model tool calls, median"],
      searching.map((c) => {
        const shown = c.runs.filter((r) => r.toolSearches);
        return [
          c.arm,
          `${shown.length}/${c.runs.length}`,
          figure(shown.map((r) => r.toolSearches!.total), median, count),
          figure(shown.map((r) => r.toolSearches!.beforeFirstCall), median, count),
          figure(c.runs.map((r) => r.trace.calls), median, count),
          figure(c.runs.map((r) => r.modelToolCalls), median, count),
        ];
      }),
    ));
    out.push("", "Tool searches are the model's calls to the client's own search for deferred tools, from the client's events; a client whose events do not show them has none counted. They are among the model tool calls and never reach the server.", "");
  }

  const tasks = [...new Set(runs.filter((r) => GRADED.has(r.status)).map((r) => r.task))].sort();
  if (tasks.length) {
    out.push("## Passes by task", "");
    out.push(table(["Task", ...columns.map((c) => c.arm)], tasks.map((t) => [t, ...columns.map((c) => ratio(passes(c.runs.filter((r) => r.task === t))))])));
    out.push("");
  }

  if (columns.length > 1 && tasks.length) {
    out.push("## Paired comparison", "");
    out.push(
      `A description of these runs, not a significance test: with ${plural(meta.options.n, "rep")} per task, a single run can decide a task. ` +
        "For each pair of arms, over the tasks both finished (with a graded run on each), the arm that passed a larger share of its runs wins the task.",
      "",
    );
    out.push(table(["Arm A", "Arm B", "Tasks both finished", "Won by A", "Won by B", "Tied"], pairs(columns).map(([a, b]) => {
      const won = { a: [] as string[], b: [] as string[] };
      let both = 0, tied = 0;
      for (const t of tasks) {
        const pa = passes(a.runs.filter((r) => r.task === t)), pb = passes(b.runs.filter((r) => r.task === t));
        if (!pa.graded || !pb.graded) continue;
        both++;
        const d = pa.passed / pa.graded - pb.passed / pb.graded;
        if (d > 0) won.a.push(t); else if (d < 0) won.b.push(t); else tied++;
      }
      const wins = (ts: string[]) => (ts.length ? `${ts.length} (${ts.join(", ")})` : "0");
      return [a.arm, b.arm, String(both), wins(won.a), wins(won.b), String(tied)];
    })));
    out.push("");
  }

  const failed = runs.filter((r) => FAILED.has(r.status)).sort((a, b) => runName(a).localeCompare(runName(b)));
  out.push("## Failed runs", "");
  if (!failed.length) out.push("None.");
  for (const r of failed) {
    const was = r.history?.at(-1)?.status;
    out.push(`- **${runName(r)}**: ${r.status}${was && was !== r.status ? ` (regraded; was ${was})` : ""}${r.error ? `. ${r.error.slice(0, 300)}` : ""}`);
    for (const c of r.checks.filter((c) => isRequired(c) && !c.pass)) out.push(`  - ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  out.push("");

  out.push("## Informative checks", "");
  const informative = informativeRows(columns);
  if (!informative.length) out.push("No task run here reports one.");
  else {
    out.push("Checks a task reports without letting them decide the run (`required: false`): how often each passed, over the graded runs that carry it. They are not among the failures above.", "");
    out.push(table(["Task", "Check", ...columns.map((c) => c.arm)], informative));
  }
  out.push("");

  out.push("## What the mock could not serve", "");
  const gaps = new Map<string, { tool: string; input: string; outcome: string; calls: number; runs: Set<string> }>();
  for (const r of runs) for (const g of r.trace.gaps) {
    const key = `${g.tool}\u0000${g.input ?? ""}\u0000${g.outcome}`;
    const entry = gaps.get(key) ?? { tool: g.tool, input: g.input ?? "(the whole tool)", outcome: g.outcome, calls: 0, runs: new Set<string>() };
    entry.calls++;
    entry.runs.add(`${runName(r)}: ${r.status}`);
    gaps.set(key, entry);
  }
  if (!gaps.size) out.push("Every call reached a tool and inputs the mock implements.");
  else {
    out.push("Calls that a real server would have answered and the mock refused. A run that hit one may have failed, or taken longer, because of the mock rather than the arm.", "");
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
    ...(r.toolSearch !== "off" && r.toolSearches ? [`tool searches ${r.toolSearches.total}`] : []),
    r.usage ? `context ${tokens(r.usage.contextProcessed)}, output ${tokens(r.usage.output)}` : "no usage",
    ...(r.costUsd !== undefined ? [usd(r.costUsd)] : []),
    ...(r.error ? [`error: ${r.error.slice(0, 120)}`] : []),
    `answer: ${JSON.stringify(r.answer.slice(0, 80))}`,
  ];
  return parts.join(" · ");
}

/** Per client: the model(s) its runs ran, and how the runner knows. */
export function modelLines(meta: Meta, runs: RunResult[]): string[] {
  const clients = [...new Set([meta.client.name, ...runs.map((r) => r.client)])];
  return clients.map((name) => {
    const mine = runs.filter((r) => r.client === name);
    const version = name === meta.client.name ? ` ${meta.client.version}` : "";
    const asked = name === meta.client.name ? `; asked for ${meta.options.model ?? "the client's default"}` : "";
    if (!mine.length) return `Client ${name}${version}: no run finished yet${asked}.`;
    const how = { reported: "as the client reported", requested: "as requested; the client does not report it", default: "the client's default, which it does not report" } as const;
    const byModel = new Map<string, RunResult[]>();
    for (const r of mine) byModel.set(`${r.model}\u0000${r.modelSource}`, [...(byModel.get(`${r.model}\u0000${r.modelSource}`) ?? []), r]);
    const parts = [...byModel.values()].map((rs) => `**${rs[0]!.model}** in ${plural(rs.length, "run")} (${how[rs[0]!.modelSource]})`);
    const several = new Set(mine.filter((r) => r.modelSource === "reported").map((r) => r.model)).size > 1;
    const byEffort = new Map<string, RunResult[]>();
    for (const r of mine) byEffort.set(`${r.effort}\u0000${r.effortSource}`, [...(byEffort.get(`${r.effort}\u0000${r.effortSource}`) ?? []), r]);
    const efforts = [...byEffort.values()].map((rs) => `${rs[0]!.effort === null ? "the client's default" : `**${rs[0]!.effort}**`} in ${plural(rs.length, "run")} (${effortHow[rs[0]!.effortSource]})`);
    const askedEffort = name === meta.client.name ? `; asked for ${meta.options.effort ?? "the client's default"}` : "";
    return `Client ${name}${version}: ${parts.join(", ")}${asked}. Effort ${efforts.join(", ")}${askedEffort}.${several ? " These runs mixed models: they do not compare." : ""}`;
  });
}

const effortHow = { reported: "as the client reported", requested: "as requested; the client does not report it", default: "nothing passed; the client does not report it" } as const;

/** What the model was shown at the start, read from the runs. */
export function shownAtStart(c: Column, listing: Listing | undefined): string {
  const started = c.runs.filter((r) => r.startTools.length);
  const first = median(c.runs.flatMap((r) => (r.firstContext === undefined ? [] : [r.firstContext])));
  if (!started.length) return "the client reported no tools at start";
  const tools = median(started.map((r) => r.startTools.length))!;
  const server = median(started.map((r) => r.startTools.filter(mine).length))!;
  const search = [...new Set(started.flatMap((r) => r.startTools.filter((t) => SEARCH_TOOLS.has(t))))];
  const named = `${count(tools)} tools at start, ${server ? `${count(server)} of them the server's` : "none of them the server's"}${search.length ? `, and the client's ${search.join(", ")}` : ""}`;
  if (first === null) return `${named}; the client does not report its first request's size, so whether tool definitions were in it is not in the data`;
  const firstText = `the first request held ${tokens(first)} tokens`;
  if (!server || !listing) return `${named}; ${firstText}`;
  // The listing is bytes / 4, a rough measure: half of it is a wide margin either way.
  return first >= listing.approxTokens / 2
    ? `${named}; ${firstText}, room for the definitions of the server's tools (≈${tokens(listing.approxTokens)}): they were all sent upfront`
    : `${named}; ${firstText}, far less than the definitions of the server's tools (≈${tokens(listing.approxTokens)}): the client deferred them`;
}

/** The last regrade, and how many verdicts all of them changed. Null when the runs were never regraded. */
export function regradeLine(regrades: RegradePass[]): string | null {
  const last = regrades.at(-1);
  if (!last) return null;
  const all = new Set(regrades.flatMap((p) => p.changed.map((c) => `${c.task}\u0000${c.arm}\u0000${c.rep}`))).size;
  const flips = last.changed.filter((c) => c.from !== c.to).length;
  return (
    `**Regraded** ${plural(regrades.length, "time")}, last on ${last.at.slice(0, 16).replace("T", " ")} UTC at commit ${last.commit.slice(0, 10)}${last.dirty ? " (uncommitted changes)" : ""}: ` +
    `${last.changed.length} of ${plural(last.runs, "verdict")} changed (${plural(flips, "status", "statuses")})${regrades.length > 1 ? `; ${plural(all, "run")} changed over all regrades` : ""}. ` +
    "Each run that changed keeps its earlier verdicts in its result.json."
  );
}

function informativeRows(columns: Column[]): string[][] {
  const keys = new Map<string, { task: string; check: string }>();
  for (const c of columns) for (const r of c.runs) if (GRADED.has(r.status)) for (const k of r.checks) if (!isRequired(k)) keys.set(`${r.task}\u0000${k.name}`, { task: r.task, check: k.name });
  return [...keys.values()].sort((a, b) => a.task.localeCompare(b.task) || a.check.localeCompare(b.check)).map(({ task, check }) => [task, check, ...columns.map((c) => {
    const carried = c.runs.filter((r) => r.task === task && GRADED.has(r.status)).flatMap((r) => r.checks.filter((k) => k.name === check && !isRequired(k)));
    return carried.length ? `${carried.filter((k) => k.pass).length}/${carried.length}` : "–";
  })]);
}

const pairs = <T>(xs: T[]): [T, T][] => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as [T, T]));

const listingOf = (meta: Meta, c: Column): Listing | undefined => {
  const surface = meta.arms.find((a) => a.name === c.arm)?.surface ?? c.runs[0]?.surface;
  return surface === undefined ? undefined : meta.listings[surface];
};

function columnsOf(meta: Meta, runs: RunResult[]): Column[] {
  const arms = [...meta.options.arms, ...new Set(runs.map((r) => r.arm).filter((a) => !meta.options.arms.includes(a)))];
  return arms.map((arm) => ({ arm, runs: runs.filter((r) => r.arm === arm) })).filter((c) => c.runs.length || meta.options.arms.includes(c.arm));
}
