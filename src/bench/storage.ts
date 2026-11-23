// The layout of results/<label>/. A run is finished when its result.json exists; nothing else marks it.
//   meta.json            the benchmark: options, arms as resolved, client, commit, listings, the world's hash
//   world-before.json    the world every run started from, kept so a regrade does not depend on today's seed code
//   runs.jsonl           one RunResult per finished run (the report reads this)
//   regrades.jsonl       one RegradePass per `bun run regrade`
//   report.md            the last report
//   runs/<task>/<arm>/<rep>/
//     result.json        the RunResult, written last
//     events.jsonl, stderr.txt, command.json, the client's MCP config
//     trace.jsonl, world.json   what the server saw and the world it left
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FORMAT, type Meta, type RegradePass, type RunKey, type RunResult } from "./types.ts";

export const RESULTS = resolve(import.meta.dir, "../../results");

export const resultsDir = (label: string) => join(RESULTS, label);
export const runDir = (root: string, k: RunKey) => join(root, "runs", k.task, k.arm, String(k.rep));
export const isFinished = (root: string, k: RunKey) => existsSync(join(runDir(root, k), "result.json"));

/** An empty directory for the run: what an unfinished attempt left (a trace appended to, a world) must not carry over. */
export function freshRunDir(root: string, k: RunKey): string {
  const dir = runDir(root, k);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** runs.jsonl first, result.json last: a crash in between reruns the run, and the report keeps one line per run. */
export function saveFinished(root: string, r: RunResult): void {
  appendFileSync(join(root, "runs.jsonl"), JSON.stringify(r) + "\n");
  writeFileSync(join(runDir(root, r), "result.json"), JSON.stringify(r, null, 2));
}

const keyOf = (k: RunKey) => [k.task, k.arm, k.rep].join("\u0000");

/** One result per (task, arm, rep): the last line written wins. */
export function readRuns(root: string): RunResult[] {
  const path = join(root, "runs.jsonl");
  if (!existsSync(path)) return [];
  const byKey = new Map<string, RunResult>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as RunResult;
    byKey.set(keyOf(r), r);
  }
  return [...byKey.values()];
}

/**
 * Every run's result.json, then runs.jsonl replaced in one rename. A crash before the rename leaves runs.jsonl as it
 * was, and a regrade run again starts from it.
 */
export function rewriteRuns(root: string, runs: RunResult[]): void {
  for (const r of runs) writeFileSync(join(runDir(root, r), "result.json"), JSON.stringify(r, null, 2));
  const tmp = join(root, "runs.jsonl.tmp");
  writeFileSync(tmp, runs.map((r) => JSON.stringify(r) + "\n").join(""));
  renameSync(tmp, join(root, "runs.jsonl"));
}

/** Null when there is no benchmark here. Throws on one this runner did not write: its runs would be misread. */
export function readMeta(root: string): Meta | null {
  const path = join(root, "meta.json");
  if (!existsSync(path)) return null;
  const meta = JSON.parse(readFileSync(path, "utf8")) as Partial<Meta>;
  if (meta.format !== FORMAT) {
    throw new Error(
      `${root} was written by ${meta.format === undefined ? "the first version of the runner (one tool search for the whole benchmark, runs stored by surface)" : `layout version ${meta.format}`}; ` +
        `this runner reads layout version ${FORMAT} only. Leave it as it is and use a new --label.`,
    );
  }
  return meta as Meta;
}

export function writeMeta(root: string, meta: Meta, worldBefore: unknown): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "world-before.json"), JSON.stringify(worldBefore));
  writeFileSync(join(root, "meta.json"), JSON.stringify(meta, null, 2));
}

export const readWorldBefore = <W>(root: string): W => JSON.parse(readFileSync(join(root, "world-before.json"), "utf8")) as W;

export const readRegrades = (root: string): RegradePass[] =>
  existsSync(join(root, "regrades.jsonl")) ? readFileSync(join(root, "regrades.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RegradePass) : [];

export const appendRegrade = (root: string, pass: RegradePass) => appendFileSync(join(root, "regrades.jsonl"), JSON.stringify(pass) + "\n");
