// Fabricated benchmark records for the runner's tests: a meta.json and runs, with only what a test changes given.
import type { Meta, RunResult } from "../../src/bench/types.ts";

export const ARMS: Meta["arms"] = [
  { name: "direct", surface: "direct", toolSearch: "off", setting: 'ENABLE_TOOL_SEARCH=false, --tools ""' },
  { name: "direct+search", surface: "direct", toolSearch: "on", setting: 'ENABLE_TOOL_SEARCH=true, --tools "ToolSearch"' },
  { name: "code", surface: "code", toolSearch: "off", setting: 'ENABLE_TOOL_SEARCH=false, --tools ""' },
];

export function fakeMeta(o: Partial<Meta> & { arms?: Meta["arms"] } = {}): Meta {
  const arms = o.arms ?? ARMS;
  return {
    format: 2, label: "fab", startedAt: "2026-11-23T09:00:00.000Z", today: "2026-11-23", timezone: "America/Los_Angeles", machine: { timezone: "America/Los_Angeles", date: "2026-11-23" },
    options: { arms: arms.map((a) => a.name), client: "claude", model: null, effort: null, tasks: ["t1", "t2"], n: 2, timeoutSeconds: 600, seed: 5, prompt: null },
    client: { name: "claude", version: "2.1.330 (Claude Code)", setup: [] },
    git: { commit: "abcdef1234567890", dirty: false },
    catalog: { source: "https://docs.example", tools: 114 },
    listings: { direct: { tools: 114, bytes: 380542, approxTokens: 95136 }, code: { tools: 2, bytes: 1675, approxTokens: 419 } },
    world: { sha256: "w0" },
    runtime: { bun: "1.3.14", platform: "darwin-arm64" },
    ...o,
    arms,
  };
}

const START: Record<string, { tools: string[]; first: number }> = {
  direct: { tools: Array.from({ length: 114 }, (_, i) => `mcp__erp__t${i}`), first: 155_000 },
  "direct+search": { tools: ["ToolSearch", ...Array.from({ length: 114 }, (_, i) => `mcp__erp__t${i}`)], first: 5_300 },
  code: { tools: ["mcp__erp__distru-search", "mcp__erp__distru-execute"], first: 3_300 },
};

/** A passing claude run of `arm`. `calls` sets both server and model tool calls; `context` the context processed. */
export function fakeRun(task: string, arm: string, rep: number, o: Partial<RunResult> & { calls?: number; context?: number } = {}): RunResult {
  const { calls: c, context, ...rest } = o;
  const calls = c ?? 2;
  const resolved = ARMS.find((a) => a.name === arm) ?? { surface: arm, toolSearch: "off" as const, setting: "" };
  const start = START[arm] ?? { tools: [], first: 1_000 };
  const total = context ?? 12_000;
  return {
    task, arm, rep, surface: resolved.surface, toolSearch: resolved.toolSearch, armSetting: resolved.setting,
    client: "claude", model: "claude-opus-5-5", modelSource: "reported", effort: null, effortSource: "default",
    status: "pass", checks: [{ name: "right answer", pass: true }],
    graded: { at: "2026-11-23T09:30:00.000Z", commit: "abcdef1234567890", dirty: false },
    answer: "ok", wallSeconds: 20, turns: 3, modelToolCalls: calls, costUsd: 0.05,
    // Most of what a run processes is cache read, as on the real runs.
    usage: { input: 10, cacheCreation: Math.round(total * 0.2), cacheRead: total - 10 - 300 - Math.round(total * 0.2), output: 300, contextProcessed: total },
    firstContext: start.first,
    startTools: start.tools,
    ...(resolved.toolSearch !== "off" ? { toolSearches: { total: 1, beforeFirstCall: 1 } } : {}),
    trace: { calls, byOutcome: { ok: calls, tool_error: 0, invalid_arguments: 0, unknown_tool: 0, unimplemented: 0, unsupported_input: 0 }, tools: [], gaps: [] },
    startedAt: "",
    ...rest,
  };
}
