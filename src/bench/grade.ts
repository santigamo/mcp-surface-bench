// From what a run left behind to a verdict.
import { existsSync, readFileSync } from "node:fs";
import type { Check, Suite, Task } from "../core/tool.ts";
import type { Status } from "./types.ts";

/** The world after the run: what the server last saved, or the untouched world when nothing was written. */
export const worldAfter = <W>(suite: Suite<W>, today: string, worldPath: string): W =>
  existsSync(worldPath) ? (JSON.parse(readFileSync(worldPath, "utf8")) as W) : suite.createWorld(today);

/** Never throws: a grader that fails is a failed check the report shows. */
export function runChecks<W>(task: Task<W>, run: { answer: string; before: W; after: W }): Check[] {
  try {
    const checks = task.grade(run);
    return checks.length ? checks : [{ name: "grader", pass: false, detail: "the task returned no checks" }];
  } catch (e) {
    return [{ name: "grader", pass: false, detail: `the grader threw: ${(e as Error).message}` }];
  }
}

/**
 * A limit hit wins over everything: the run says nothing about the surface. A timeout is a timeout even when the
 * checks happen to pass. A client error fails the run only when the checks fail too; otherwise it stays recorded.
 */
export function statusOf(o: { limitHit: boolean; timedOut: boolean; error?: string; checks: Check[] | null }): Status {
  if (o.limitHit) return "limit";
  if (o.timedOut) return "timeout";
  if (o.checks === null) return o.error ? "error" : "ungraded";
  if (o.checks.every((c) => c.pass)) return "pass";
  return o.error ? "error" : "fail";
}
