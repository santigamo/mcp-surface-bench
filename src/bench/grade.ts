// From what a run left behind to a verdict, the first time and on a regrade.
import { existsSync, readFileSync } from "node:fs";
import type { Check, Task } from "../core/tool.ts";
import type { Grading, RunResult, Status, TraceSummary } from "./types.ts";

/** The world after the run: what the server last saved, or the world it started from when nothing was written. */
export const worldAfter = <W>(before: W, worldPath: string): W =>
  existsSync(worldPath) ? (JSON.parse(readFileSync(worldPath, "utf8")) as W) : before;

/** A check decides the run unless it says `required: false`. */
export const isRequired = (c: Check) => c.required !== false;

/** Never throws: a grader that fails is a failed check the report shows. */
export function runChecks<W>(task: Task<W>, run: { answer: string; before: W; after: W }): Check[] {
  try {
    const checks = task.grade(run);
    if (!checks.length) return [{ name: "grader", pass: false, detail: "the task returned no checks" }];
    // Only informative checks would pass every run whatever it did.
    if (!checks.some(isRequired)) return [...checks, { name: "grader", pass: false, detail: "the task returned no required check" }];
    return checks;
  } catch (e) {
    return [{ name: "grader", pass: false, detail: `the grader threw: ${(e as Error).message}` }];
  }
}

/**
 * A limit hit wins over everything: the run says nothing about the surface. A timeout is a timeout even when the
 * checks happen to pass. A client error fails the run only when the checks fail too; otherwise it stays recorded.
 * Informative checks never decide.
 */
export function statusOf(o: { limitHit: boolean; timedOut: boolean; error?: string; checks: Check[] | null }): Status {
  if (o.limitHit) return "limit";
  if (o.timedOut) return "timeout";
  if (o.checks === null) return o.error ? "error" : "ungraded";
  if (o.checks.filter(isRequired).every((c) => c.pass)) return "pass";
  return o.error ? "error" : "fail";
}

/** What a verdict is: the status and the required checks that failed. An informative check is not part of it. */
export const failedChecks = (checks: Check[]) => checks.filter((c) => isRequired(c) && !c.pass).map((c) => c.name);

/**
 * The stored run graded again with `checks`. The status is worked out as the first time: the run's timeout and
 * client error are what it recorded (a limit never reaches the disk). When the verdict changes, the old one goes to
 * the run's history; when it does not, the run keeps its grading and history and only its checks are refreshed.
 */
export function regrade(r: RunResult, checks: Check[], by: Grading, trace?: TraceSummary): { result: RunResult; changed: boolean } {
  const status = statusOf({ limitHit: false, timedOut: r.status === "timeout", ...(r.error ? { error: r.error } : {}), checks });
  const before = { status: r.status, failed: failedChecks(r.checks) };
  const after = { status, failed: failedChecks(checks) };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const result: RunResult = { ...r, checks, status, ...(trace ? { trace } : {}) };
  if (changed) {
    result.graded = by;
    result.history = [...(r.history ?? []), { ...r.graded, ...before, replacedAt: by.at }];
  }
  return { result, changed };
}

/** Why a run's verdict changed: the checks that flipped, appeared or went. */
export function checkChanges(before: Check[], after: Check[]): string[] {
  const tag = (c: Check) => (isRequired(c) ? "" : " (informative)");
  const was = new Map(before.map((c) => [c.name, c])), now = new Map(after.map((c) => [c.name, c]));
  const lines: string[] = [];
  for (const c of after) {
    const old = was.get(c.name);
    if (!old) lines.push(`new check${tag(c)}: ${c.name}, ${c.pass ? "passes" : `fails${c.detail ? `: ${c.detail}` : ""}`}`);
    else if (old.pass !== c.pass) lines.push(`${c.pass ? "now passes" : "now fails"}${tag(c)}: ${c.name}${!c.pass && c.detail ? `: ${c.detail}` : ""}`);
    else if (isRequired(old) !== isRequired(c)) lines.push(`${isRequired(c) ? "now required" : "now informative"}: ${c.name}`);
  }
  for (const c of before) if (!now.has(c.name)) lines.push(`check gone${tag(c)}: ${c.name}`);
  return lines;
}
