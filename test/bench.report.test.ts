import { expect, test } from "bun:test";
import { modelLines, renderReport, runLine } from "../src/bench/render.ts";
import type { RunResult } from "../src/bench/types.ts";
import { ARMS, fakeMeta, fakeRun as r } from "./fixtures/fabricate.ts";

// The command line gave code first: every table follows that order, not the alphabet or the order runs finished in.
const meta = fakeMeta({ arms: [ARMS[2]!, ARMS[0]!, ARMS[1]!] });

const runs: RunResult[] = [
  r("t1", "direct", 1, { calls: 1, context: 310_000 }),
  r("t1", "direct", 2, { calls: 3, context: 330_000 }),
  r("t1", "code", 1, { calls: 2 }),
  r("t1", "code", 2, { calls: 4 }),
  r("t2", "direct", 1, { calls: 5, context: 400_000 }),
  r("t2", "code", 1, {
    status: "fail", calls: 3,
    checks: [{ name: "right answer", pass: false, detail: "expected 42, answer said 41" }, { name: "world untouched", pass: true }, { name: "ranked by revenue", pass: false, required: false }],
    trace: {
      calls: 3, byOutcome: { ok: 2, tool_error: 0, invalid_arguments: 0, unknown_tool: 0, unimplemented: 0, unsupported_input: 1 }, tools: ["search-orders", "search-orders", "get-me"],
      gaps: [{ tool: "search-orders", outcome: "unsupported_input", input: "customFieldFilters" }],
    },
  }),
  r("t2", "direct", 2, { status: "timeout", usage: null, costUsd: undefined, checks: [{ name: "right answer", pass: false }], error: "no result event" }),
  r("t1", "direct+search", 1, { calls: 2, context: 40_000, toolSearches: { total: 3, beforeFirstCall: 2 }, checks: [{ name: "right answer", pass: true }, { name: "ranked by revenue", pass: true, required: false }] }),
  r("t1", "direct+search", 2, { status: "fail", calls: 2, context: 50_000, toolSearches: { total: 1, beforeFirstCall: 1 }, checks: [{ name: "right answer", pass: false }] }),
  r("t2", "direct+search", 1, { calls: 4, context: 60_000, toolSearches: { total: 2, beforeFirstCall: 1 }, checks: [{ name: "right answer", pass: true }, { name: "ranked by revenue", pass: true, required: false }] }),
];
const md = renderReport(meta, runs);
const line = (start: string, has = "") => md.split("\n").find((l) => l.startsWith(start) && l.includes(has));

test("report: one row per arm in the order of the command line, with the runs behind each figure", () => {
  expect(md).toContain("| Arm | Surface | Tool search | Client setting |\n| --- | --- | --- | --- |\n| code | code | off |");
  const rows = md.split("\n").filter((l) => l.includes("tools,") && l.includes("bytes"));
  expect(rows.map((l) => l.split(" | ")[0])).toEqual(["| code", "| direct", "| direct+search"]);
  // direct: 4 runs, 3 passed (the timeout counts as graded), median of 1,3,5,2 calls = 2.5, usage from the 3 runs that have it.
  expect(line("| direct | ", "tools,")).toContain("| direct | 4 | 3/4 | 2.5 [4] | 2.8 [4] |");
  expect(line("| direct | ", "tools,")).toContain("| 330k [3] |");
  expect(line("| direct | ", "tools,")).toContain("| 114 tools, 381k bytes (≈95k tokens at 4 bytes each) |");
  expect(line("| code | ", "tools,")).toContain("| code | 3 | 2/3 | 3 [3] | 3.0 [3] |");
  expect(md).toContain("| Task | code | direct | direct+search |");
  expect(md).toContain("| t1 | 2/2 | 2/2 | 1/2 |");
  expect(md).toContain("| t2 | 0/1 | 1/2 | 1/1 |");
});

test("report: cost only for an arm where every run reported one, with a word on cache warmth", () => {
  expect(line("| code | ", "tools,")).toContain("$0.050 [3]");
  expect(line("| direct | ", "tools,")).toContain("| 20 s [4] | – |"); // the timeout reported no cost
  expect(md).toContain("It depends on cache warmth");
  expect(md).toContain("depends on the order its runs happened to fall in");
});

test("report: what each arm showed the model at the start, read from the runs", () => {
  expect(md).toContain("- **direct**: 114 tools at start, 114 of them the server's; the first request held 155k tokens, room for the definitions of the server's tools (≈95k): they were all sent upfront.");
  expect(md).toContain("- **direct+search**: 115 tools at start, 114 of them the server's, and the client's ToolSearch; the first request held 5.3k tokens, far less than the definitions of the server's tools (≈95k): the client deferred them.");
  expect(md).toContain("- **code**: 2 tools at start, 2 of them the server's;");
  expect(md).toContain("| direct | 114 [4] | 114 [4] | 155k [4] | none |");
  expect(md).toContain("| direct+search | 115 [3] | 114 [3] | 5.3k [3] | ToolSearch |");

  // A client that reports no first request (Codex) and a deferral that leaves no server tool at start.
  const codex = r("t1", "direct+search", 1, { client: "codex", startTools: ["functions.exec", "functions.wait"], firstContext: undefined });
  expect(renderReport(meta, [codex])).toContain("- **direct+search**: 2 tools at start, none of them the server's; the client does not report its first request's size, so whether tool definitions were in it is not in the data.");
  expect(renderReport(meta, [])).toContain("- **direct**: the client reported no tools at start.");
});

test("report: context processed split into uncached input, cache creation and cache read, the sum kept", () => {
  // fakeRun: 10 uncached, 20% creation, 300 output, the rest cache read. direct's runs: 310k, 330k, 400k.
  expect(md).toContain("| direct | 10 [3] | 66k [3] | 264k [3] | 300 [3] | 330k [3] | 80% |");
  expect(md).toContain("| Arm | Uncached input, median | Cache creation, median | Cache read, median | Output, median | Context processed, median |");
  expect(md).toContain("Cache read is context already cached and read again by every later request of the run");
});

test("report: tool searches of the arms that search, next to the server calls", () => {
  expect(md).toContain("## The client's tool search");
  expect(md).toContain("| direct+search | 3/3 | 2 [3] | 1 [3] | 2 [3] | 2 [3] |");
  expect(md).not.toContain("| direct | 4/4 |");
  const unseen = r("t1", "direct+search", 1, { client: "codex", toolSearches: undefined });
  expect(renderReport(meta, [unseen])).toContain("| direct+search | 0/1 | – | – | 2 [1] | 2 [1] |");
  expect(renderReport(fakeMeta({ arms: [ARMS[0]!, ARMS[2]!] }), runs.filter((x) => x.toolSearch === "off"))).not.toContain("## The client's tool search");
});

test("report: paired comparison by pass share on the tasks both arms finished, labelled as a description", () => {
  expect(md).toContain("A description of these runs, not a significance test: with 2 reps per task, a single run can decide a task.");
  expect(md).toContain("| Arm A | Arm B | Tasks both finished | Won by A | Won by B | Tied |");
  // code t1 2/2 t2 0/1; direct t1 2/2 t2 1/2; direct+search t1 1/2 t2 1/1.
  expect(md).toContain("| code | direct | 2 | 0 | 1 (t2) | 1 |");
  expect(md).toContain("| code | direct+search | 2 | 1 (t1) | 1 (t2) | 0 |");
  expect(md).toContain("| direct | direct+search | 2 | 1 (t1) | 1 (t2) | 0 |");
  // A task one arm never finished is not compared.
  const partial = renderReport(meta, runs.filter((x) => !(x.arm === "code" && x.task === "t2")));
  expect(partial).toContain("| code | direct | 1 | 0 | 0 | 1 |");
});

test("report: failures list required checks only; informative checks have their own table", () => {
  expect(md).toContain("- **t2 / code #1**: fail\n  - right answer: expected 42, answer said 41\n");
  expect(md).not.toContain("  - ranked by revenue");
  expect(md).not.toContain("world untouched");
  expect(md).toContain("- **t2 / direct #2**: timeout. no result event");
  expect(md).toContain("| Task | Check | code | direct | direct+search |");
  expect(md).toContain("| t1 | ranked by revenue | – | – | 1/1 |");
  expect(md).toContain("| t2 | ranked by revenue | 0/1 | – | 1/1 |");
  expect(renderReport(meta, runs.slice(0, 2))).toContain("No task run here reports one.");
  expect(md).toContain("| search-orders | customFieldFilters | unsupported_input | 1 | t2 / code #1: fail |");
});

test("report: the model that ran, per client, and how the runner knows", () => {
  expect(md).toContain("- Client claude 2.1.330 (Claude Code): **claude-opus-5-5** in 10 runs (as the client reported); asked for the client's default. Effort the client's default in 10 runs (nothing passed; the client does not report it); asked for the client's default.");
  const medium = fakeMeta();
  medium.options = { ...medium.options, model: "claude-opus-5-5", effort: "medium" };
  expect(modelLines(medium, [r("t1", "code", 1, { effort: "medium", effortSource: "requested" })])).toEqual([
    "Client claude 2.1.330 (Claude Code): **claude-opus-5-5** in 1 run (as the client reported); asked for claude-opus-5-5. Effort **medium** in 1 run (as requested; the client does not report it); asked for medium.",
  ]);
  const codexMeta = fakeMeta({ client: { name: "codex", version: "codex-cli 0.167.0", setup: [] } });
  expect(modelLines(codexMeta, [r("t1", "code", 1, { client: "codex", model: "codex default", modelSource: "default" })])).toEqual([
    "Client codex codex-cli 0.167.0: **codex default** in 1 run (the client's default, which it does not report); asked for the client's default. Effort the client's default in 1 run (nothing passed; the client does not report it); asked for the client's default.",
  ]);
  const mixed = modelLines(meta, [r("t1", "code", 1), r("t1", "code", 2, { model: "claude-sonnet-5" }), r("t2", "code", 1, { model: "claude default", modelSource: "default" })]);
  expect(mixed[0]).toContain("**claude-opus-5-5** in 1 run (as the client reported), **claude-sonnet-5** in 1 run (as the client reported), **claude default** in 1 run (the client's default, which it does not report)");
  expect(mixed[0]).toEndWith("These runs mixed models: they do not compare.");
  expect(modelLines(meta, [])).toEqual(["Client claude 2.1.330 (Claude Code): no run finished yet; asked for the client's default."]);
});

test("report: never regraded says nothing about it; an empty benchmark still renders", () => {
  expect(md).not.toContain("Regraded");
  const empty = renderReport(meta, []);
  expect(empty).toContain("Every call reached a tool and inputs the mock implements.");
  expect(empty).toContain("| code | 0 | – |");
});

test("runLine: one line per finished run, with the arm and its tool searches", () => {
  expect(runLine(2, 7, runs[5]!)).toBe('[2/7] t2 / code #1: fail · 20 s · server calls 3 · model calls 3 · context 12k, output 300 · $0.050 · answer: "ok"');
  expect(runLine(1, 7, runs[7]!)).toBe('[1/7] t1 / direct+search #1: pass · 20 s · server calls 2 · model calls 2 · tool searches 3 · context 40k, output 300 · $0.050 · answer: "ok"');
});
