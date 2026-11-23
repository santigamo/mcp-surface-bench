import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../src/bench/options.ts";
import { plan, shuffle } from "../src/bench/plan.ts";
import { freshRunDir, isFinished, readRuns, runDir, saveFinished } from "../src/bench/storage.ts";
import type { RunResult } from "../src/bench/types.ts";

const tasks = [{ id: "t1", prompt: "one" }, { id: "t2", prompt: "two" }];
const surfaces = ["direct", "code", "third"];

test("plan: every (task, rep) block runs each surface once, tasks and reps in order", () => {
  const p = plan(tasks, surfaces, 2, 7);
  expect(p).toHaveLength(12);
  const blocks = [0, 1, 2, 3].map((b) => p.slice(b * 3, b * 3 + 3));
  expect(blocks.map((b) => `${b[0]!.task}#${b[0]!.rep}`)).toEqual(["t1#1", "t1#2", "t2#1", "t2#2"]);
  for (const b of blocks) {
    expect(b.map((r) => r.surface).sort()).toEqual([...surfaces].sort());
    expect(b.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(new Set(b.map((r) => `${r.task}#${r.rep}`)).size).toBe(1);
  }
  expect(p.find((r) => r.task === "t2")!.prompt).toBe("two");
});

test("plan: the seed fixes the order, and blocks do not all share one order", () => {
  expect(plan(tasks, surfaces, 3, 42)).toEqual(plan(tasks, surfaces, 3, 42));
  expect(plan(tasks, surfaces, 3, 42)).not.toEqual(plan(tasks, surfaces, 3, 43));
  const firsts = new Set<string>();
  for (let seed = 0; seed < 20; seed++) for (const r of plan(tasks, surfaces, 3, seed)) if (r.position === 0) firsts.add(r.surface);
  expect([...firsts].sort()).toEqual([...surfaces].sort());
  const orders = new Set(Array.from({ length: 6 }, (_, b) => plan(tasks, surfaces, 3, 5).slice(b * 3, b * 3 + 3).map((r) => r.surface).join()));
  expect(orders.size).toBeGreaterThan(1);
});

test("shuffle: a permutation, the same for the same seed", () => {
  const items = ["a", "b", "c", "d", "e"];
  expect(shuffle(items, 9).sort()).toEqual(items);
  expect(shuffle(items, 9)).toEqual(shuffle(items, 9));
  expect(items).toEqual(["a", "b", "c", "d", "e"]);
});

function fakeResult(task: string, surface: string, rep: number, status: RunResult["status"] = "pass"): RunResult {
  return {
    task, surface, rep, client: "claude", model: "m", toolSearch: "off", status, checks: [], answer: "", wallSeconds: 1, turns: 1, modelToolCalls: 1, usage: null, startTools: [],
    trace: { calls: 0, byOutcome: { ok: 0, tool_error: 0, invalid_arguments: 0, unknown_tool: 0, unimplemented: 0, unsupported_input: 0 }, tools: [], gaps: [] }, startedAt: "",
  };
}

test("resume: a run whose result.json exists is skipped, an unfinished one starts from an empty directory", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-resume-"));
  try {
    const p = plan(tasks, surfaces, 1, 1);
    for (const r of p.slice(0, 2)) { freshRunDir(root, r); saveFinished(root, fakeResult(r.task, r.surface, r.rep)); }
    // An attempt that died: files left behind, no result.json.
    mkdirSync(runDir(root, p[2]!), { recursive: true });
    writeFileSync(join(runDir(root, p[2]!), "trace.jsonl"), "{}\n");

    const todo = p.filter((r) => !isFinished(root, r));
    expect(todo).toEqual(p.slice(2));
    const dir = freshRunDir(root, todo[0]!);
    expect(readdirSync(dir)).toEqual([]);
    expect(readRuns(root)).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readRuns: a run written twice (a crash between runs.jsonl and result.json) counts once, the last line winning", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-dedupe-"));
  try {
    freshRunDir(root, { task: "t1", surface: "code", rep: 1 });
    saveFinished(root, fakeResult("t1", "code", 1, "fail"));
    saveFinished(root, fakeResult("t1", "code", 1, "pass"));
    expect(readRuns(root).map((r) => r.status)).toEqual(["pass"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const known = { surfaces: ["direct", "code"], clients: ["claude", "codex"] };

test("options: defaults, and values as given", () => {
  const o = parseOptions([], known, new Date(2026, 10, 23, 9, 5, 7));
  expect(o).toEqual({ surfaces: ["direct", "code"], client: "claude", model: null, tasks: "all", n: 1, label: "2026-11-23-090507", timeoutSeconds: 600, seed: null, toolSearch: "off", prompt: null });
  const g = parseOptions(["--surfaces", "code", "--client", "codex", "--model", "x", "--tasks", "a,b", "--n", "3", "--label", "l1", "--timeout", "60", "--seed", "0", "--tool-search", "on"], known);
  expect(g).toMatchObject({ surfaces: ["code"], client: "codex", model: "x", tasks: ["a", "b"], n: 3, label: "l1", timeoutSeconds: 60, seed: 0, toolSearch: "on" });
  expect(parseOptions(["--prompt", "  hi  "], known).prompt).toBe("hi");
});

test("options: refuses what it cannot honour", () => {
  expect(() => parseOptions(["--surfaces", "nope"], known)).toThrow("--surfaces");
  expect(() => parseOptions(["--n", "0"], known)).toThrow("--n");
  expect(() => parseOptions(["--n"], known)).toThrow("needs a value");
  expect(() => parseOptions(["--tool-search", "maybe"], known)).toThrow("--tool-search");
  expect(() => parseOptions(["--label", "../x"], known)).toThrow("--label");
  expect(() => parseOptions(["--prompt", "x", "--tasks", "a"], known)).toThrow("--prompt");
  expect(() => parseOptions(["--verbose", "1"], known)).toThrow("unknown argument");
});
