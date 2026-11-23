import { expect, test } from "bun:test";
import { renderReport, runLine } from "../src/bench/render.ts";
import type { Meta, RunResult } from "../src/bench/types.ts";

const meta: Meta = {
  label: "fab", startedAt: "2026-11-23T09:00:00.000Z", today: "2026-11-23",
  options: { surfaces: ["direct", "code"], client: "claude", model: null, tasks: ["t1", "t2"], n: 2, timeoutSeconds: 600, seed: 5, toolSearch: "off", prompt: null },
  client: { name: "claude", version: "2.1.330 (Claude Code)", setup: [] },
  git: { commit: "abcdef1234567890", dirty: false },
  catalog: { source: "https://docs.example", tools: 114 },
  listings: { direct: { tools: 114, bytes: 380542, approxTokens: 95136 }, code: { tools: 2, bytes: 1675, approxTokens: 419 } },
  runtime: { bun: "1.3.14", platform: "darwin-arm64" },
};

function r(task: string, surface: string, rep: number, o: Partial<RunResult> & { calls?: number; context?: number }): RunResult {
  const calls = o.calls ?? 2;
  return {
    task, surface, rep, client: "claude", model: "claude-opus-5-5", toolSearch: "off", status: "pass", checks: [{ name: "right answer", pass: true }],
    answer: "ok", wallSeconds: 20, turns: 3, modelToolCalls: calls, costUsd: 0.05,
    usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 300, contextProcessed: o.context ?? 12_000 },
    firstContext: surface === "direct" ? 155_000 : 3_300,
    startTools: surface === "direct" ? Array.from({ length: 114 }, (_, i) => `mcp__erp__t${i}`) : ["mcp__erp__distru-search", "mcp__erp__distru-execute"],
    trace: { calls, byOutcome: { ok: calls, tool_error: 0, invalid_arguments: 0, unknown_tool: 0, unimplemented: 0, unsupported_input: 0 }, tools: [], gaps: [] },
    startedAt: "", ...o,
  };
}

const runs: RunResult[] = [
  r("t1", "direct", 1, { calls: 1, context: 310_000 }),
  r("t1", "direct", 2, { calls: 3, context: 330_000 }),
  r("t1", "code", 1, { calls: 2 }),
  r("t1", "code", 2, { calls: 4 }),
  r("t2", "direct", 1, { calls: 5, context: 400_000 }),
  r("t2", "code", 1, {
    status: "fail", calls: 3,
    checks: [{ name: "right answer", pass: false, detail: "expected 42, answer said 41" }, { name: "world untouched", pass: true }],
    trace: {
      calls: 3, byOutcome: { ok: 2, tool_error: 0, invalid_arguments: 0, unknown_tool: 0, unimplemented: 0, unsupported_input: 1 }, tools: ["search-orders", "search-orders", "get-me"],
      gaps: [{ tool: "search-orders", outcome: "unsupported_input", input: "customFieldFilters" }],
    },
  }),
  r("t2", "direct", 2, { status: "timeout", usage: null, costUsd: undefined, checks: [{ name: "right answer", pass: false }], error: "no result event" }),
];

test("report: summary per surface with the runs behind each figure", () => {
  const md = renderReport(meta, runs);
  expect(md).toContain("**claude · claude-opus-5-5 · tool search off**");
  const row = (surface: string) => md.split("\n").find((l) => l.startsWith(`| ${surface} | `) && l.includes("tools,"))!;
  // direct: 4 runs, 3 passed (the timeout counts as graded), median of 1,3,5,2 calls = 2.5, usage from the 3 runs that have it.
  expect(row("direct")).toContain("| direct | 4 | 3/4 | 2.5 [4] | 2.8 [4] |");
  expect(row("direct")).toContain("| 330k [3] |");
  expect(row("direct")).toContain("| 114 tools, 381k bytes (≈95k tokens at 4 bytes each) |");
  expect(row("code")).toContain("| code | 3 | 2/3 | 3 [3] | 3.0 [3] |");
  expect(row("code")).toContain("$0.050 [3]");
});

test("report: passes by task, failures with their checks, and the mock's gaps", () => {
  const md = renderReport(meta, runs);
  expect(md).toContain("| Task | direct | code |");
  expect(md).toContain("| t1 | 2/2 | 2/2 |");
  expect(md).toContain("| t2 | 1/2 | 0/1 |");
  expect(md).toContain("- **t2 / code #1**: fail\n  - right answer: expected 42, answer said 41");
  expect(md).not.toContain("world untouched");
  expect(md).toContain("- **t2 / direct #2**: timeout. no result event");
  expect(md).toContain("| search-orders | customFieldFilters | unsupported_input | 1 | t2 / code #1: fail |");
  expect(md).toContain("| direct | 114 [4] | 114 [4] | 155k [4] | none |");
});

test("report: several clients or models get a column each, and an empty benchmark still renders", () => {
  const md = renderReport(meta, [...runs, r("t1", "code", 1, { model: "other-model" })]);
  expect(md).toContain("| code (claude · other-model · tool search off) | 1 |");
  expect(renderReport(meta, [])).toContain("Every call reached a tool and inputs the mock implements.");
});

test("runLine: one line per finished run", () => {
  expect(runLine(2, 7, runs[5]!)).toBe('[2/7] t2 / code #1: fail · 20 s · server calls 3 · model calls 3 · context 12k, output 300 · $0.050 · answer: "ok"');
});
