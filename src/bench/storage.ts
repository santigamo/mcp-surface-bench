// The layout of results/<label>/. A run is finished when its result.json exists; nothing else marks it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Meta, RunKey, RunResult } from "./types.ts";

export const RESULTS = resolve(import.meta.dir, "../../results");

export const resultsDir = (label: string) => join(RESULTS, label);
export const runDir = (root: string, k: RunKey) => join(root, "runs", k.task, k.surface, String(k.rep));
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

/** One result per (task, surface, rep, client, model, tool search): the last line written wins. */
export function readRuns(root: string): RunResult[] {
  const path = join(root, "runs.jsonl");
  if (!existsSync(path)) return [];
  const byKey = new Map<string, RunResult>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as RunResult;
    byKey.set([r.task, r.surface, r.rep, r.client, r.model, r.toolSearch].join("\u0000"), r);
  }
  return [...byKey.values()];
}

export const readMeta = (root: string): Meta | null => (existsSync(join(root, "meta.json")) ? (JSON.parse(readFileSync(join(root, "meta.json"), "utf8")) as Meta) : null);

export function writeMeta(root: string, meta: Meta): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "meta.json"), JSON.stringify(meta, null, 2));
}
