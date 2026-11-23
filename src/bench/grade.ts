// From what a run left behind to a verdict, the first time and on a regrade.
import { existsSync, readFileSync } from "node:fs";
import type { Check, Task } from "../core/tool.ts";
import { askedInstead } from "./asked.ts";
import type { Grading, RunResult, Status, TraceSummary } from "./types.ts";

/** The world after the run: what the server last saved, or the world it started from when nothing was written. */
export const worldAfter = <W>(before: W, worldPath: string): W =>
  existsSync(worldPath) ? (JSON.parse(readFileSync(worldPath, "utf8")) as W) : before;

/**
 * Whether a run changed the world: any difference, as JSON, between the world it started from and the one it left
 * (the order of keys aside, and a key holding undefined read as absent, as the saved world.json reads it).
 */
export const worldChanged = (before: unknown, after: unknown) => !sameJson(before, after);

function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
  const ka = keys(a), kb = keys(b);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

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
 * checks happen to pass. A run whose required checks pass is a pass, whatever it asked or offered. A client error
 * fails the run only when the checks fail too; otherwise it stays recorded. A run that failed its checks having asked
 * the user something instead of acting (`question`, from `askedInstead`) asked; any other is a fail. Informative checks
 * never decide.
 */
export function statusOf(o: { limitHit: boolean; timedOut: boolean; error?: string; checks: Check[] | null; question?: string | null }): Status {
  if (o.limitHit) return "limit";
  if (o.timedOut) return "timeout";
  if (o.checks === null) return o.error ? "error" : "ungraded";
  if (o.checks.filter(isRequired).every((c) => c.pass)) return "pass";
  if (o.error) return "error";
  return o.question ? "asked" : "fail";
}

/**
 * The verdict of a graded run, from its checks and what it left: its status, and the question it put when it asked
 * instead of acting.
 */
export function verdictOf(o: { timedOut: boolean; limitHit?: boolean; error?: string; checks: Check[]; answer: string; worldChanged: boolean }): { status: Status; question?: string } {
  const question = askedInstead({ answer: o.answer, checks: o.checks, worldChanged: o.worldChanged });
  const status = statusOf({ limitHit: o.limitHit ?? false, timedOut: o.timedOut, ...(o.error ? { error: o.error } : {}), checks: o.checks, question });
  return { status, ...(status === "asked" && question ? { question } : {}) };
}

/** What a verdict is: the status and the required checks that failed. An informative check is not part of it. */
export const failedChecks = (checks: Check[]) => checks.filter((c) => isRequired(c) && !c.pass).map((c) => c.name);

/**
 * The stored run graded again with `checks`, given whether it changed the world. The status is worked out as the first
 * time: the run's timeout and client error are what it recorded (a limit never reaches the disk). When the verdict
 * changes, the old one goes to the run's history; when it does not, the run keeps its grading and history and only its
 * checks (and the question it asked) are refreshed.
 */
export function regrade(r: RunResult, checks: Check[], by: Grading, o: { worldChanged: boolean; trace?: TraceSummary }): { result: RunResult; changed: boolean } {
  const { status, question } = verdictOf({ timedOut: r.status === "timeout", ...(r.error ? { error: r.error } : {}), checks, answer: r.answer, worldChanged: o.worldChanged });
  const before = { status: r.status, failed: failedChecks(r.checks) };
  const after = { status, failed: failedChecks(checks) };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const { question: _, ...rest } = r;
  const result: RunResult = { ...rest, checks, status, ...(question ? { question } : {}), ...(o.trace ? { trace: o.trace } : {}) };
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
