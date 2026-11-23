// Every stored run of a benchmark graded again from what it left on disk: its answer, the world it saved, its trace.
// No model runs. The runs are rewritten with their new verdicts, each changed one keeping the old in its history.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../core/tool.ts";
import { checkChanges, regrade, runChecks, worldAfter, worldChanged } from "./grade.ts";
import { appendRegrade, readRuns, readWorldBefore, rewriteRuns, runDir } from "./storage.ts";
import { readTrace, summarizeTrace } from "./trace.ts";
import type { Grading, RegradePass, RunResult, Status } from "./types.ts";

export type Regraded = {
  pass: RegradePass;
  /** Each run whose verdict changed, with why. */
  changes: { run: RunResult; from: Status; why: string[] }[];
  /** Runs left as they were, and why. */
  skipped: string[];
};

/** `tasks`: the suite's tasks now, graders as fixed. The world each run started from is the one saved with the benchmark. */
export function regradeDir<W>(root: string, tasks: readonly Task<W>[], by: Grading): Regraded {
  const before = readWorldBefore<W>(root);
  const runs = readRuns(root);
  const changes: Regraded["changes"] = [];
  const skipped: string[] = [];
  const results = runs.map((r) => {
    const name = `${r.task} / ${r.arm} #${r.rep}`;
    if (r.status === "ungraded") return r;
    const task = tasks.find((t) => t.id === r.task);
    if (!task) { skipped.push(`${name}: the suite has no task ${r.task} any more`); return r; }
    const dir = runDir(root, r);
    // Each run gets its own copy, as each run had its own server: a grader cannot leak into the next run's world.
    const start = structuredClone(before);
    const after = worldAfter(structuredClone(before), join(dir, "world.json"));
    const changedWorld = worldChanged(before, after); // before grading: a grader must not decide it
    const checks = runChecks(task, { answer: r.answer, before: start, after });
    const trace = existsSync(join(dir, "trace.jsonl")) ? summarizeTrace(readTrace(join(dir, "trace.jsonl"))) : undefined;
    const { result, changed } = regrade(r, checks, by, { worldChanged: changedWorld, ...(trace ? { trace } : {}) });
    if (changed) changes.push({ run: result, from: r.status, why: [...checkChanges(r.checks, checks), ...askChanges(r, result)] });
    return result;
  });
  rewriteRuns(root, results);
  const pass: RegradePass = { ...by, runs: results.filter((r) => r.status !== "ungraded").length, changed: changes.map((c) => ({ task: c.run.task, arm: c.run.arm, rep: c.run.rep, from: c.from, to: c.run.status })) };
  appendRegrade(root, pass);
  return { pass, changes, skipped };
}

/** Why a run's outcome changed to or from asked, when its checks alone do not say. */
function askChanges(was: RunResult, now: RunResult): string[] {
  if (now.status === "asked" && was.status !== "asked") return [`asked the user, having changed nothing: "${now.question}"`];
  if (was.status === "asked" && now.status !== "asked") return ["no longer counted as asked"];
  return [];
}
