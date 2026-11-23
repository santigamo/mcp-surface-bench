// Whether a benchmark may resume a label, and whether a run may join it. Pure: runs that do not compare must not
// share a report, so each problem here stops the runner.
import type { Meta, RunResult } from "./types.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const modelName = (m: string | null) => m ?? "the client's default";

/** Models the label's runs reported running. More than one means the label already mixes models. */
export const reportedModels = (runs: RunResult[]) => [...new Set(runs.filter((r) => r.modelSource === "reported").map((r) => r.model))].sort();

/** Why the benchmark `next` cannot resume `previous`, whose finished runs are `runs`: empty when it can. */
export function resumeProblems(previous: Meta, next: Meta, runs: RunResult[]): string[] {
  const problems: string[] = [];
  const was = previous.options.arms, now = next.options.arms;
  if (!same(was, now)) {
    problems.push(same([...was].sort(), [...now].sort())
      ? `the same arms in another order: the order sets the run order and the report's; pass --arms ${was.join(",")}`
      : `different arms: this label has ${was.join(",")}; given ${now.join(",")}`);
  } else if (!same(previous.arms, next.arms)) problems.push("the same arms resolve to different client settings");

  const ran = reportedModels(runs);
  if (ran.length > 1) problems.push(`its runs already ran several models (${ran.join(", ")})`);
  if (previous.options.model !== next.options.model) {
    problems.push(`a different model: this label asked for ${modelName(previous.options.model)}${ran.length ? `, which ran ${ran.join(", ")}` : ""}; given ${modelName(next.options.model)}`);
  }

  if (previous.options.effort !== next.options.effort) {
    problems.push(`a different effort: this label asked for ${modelName(previous.options.effort)}; given ${modelName(next.options.effort)}`);
  }

  if (previous.timezone !== next.timezone) {
    problems.push(previous.timezone
      ? `a different timezone: this label's clients ran in ${previous.timezone}; the suite is now in ${next.timezone}`
      : "it was started before the runner set the clients' timezone: its clients were told the machine's date (and Codex its timezone), not the company's");
  }

  const { arms: _a, model: _m, effort: _e, ...restWas } = previous.options;
  const { arms: _b, model: _n, effort: _f, ...restNow } = next.options;
  const options = (Object.keys(restWas) as (keyof typeof restWas)[]).filter((k) => !same(restWas[k], restNow[k]));
  if (options.length) problems.push(`different ${options.join(", ")}`);
  for (const k of ["client", "catalog", "listings", "world"] as const) {
    if (!same(previous[k], next[k])) problems.push(k === "world" ? "a different starting world (the suite's seed changed)" : `a different ${k}`);
  }
  return problems;
}

/**
 * Why a finished run cannot join the label: the client ran another model than the label's runs did. Runs that did
 * not report a model are not compared (a run killed before the client said).
 */
export function modelMismatch(established: string[], r: RunResult): string | null {
  if (r.modelSource !== "reported" || !established.length || established.includes(r.model)) return null;
  return `the client ran ${r.model}, but this label's runs ran ${established.join(", ")}; runs of different models do not compare. Use a new --label, with --model to pin the model.`;
}
