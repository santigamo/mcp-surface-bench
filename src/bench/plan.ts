// The order of the runs: every (task, rep) block runs each arm once, in an order of its own drawn from the seed.
import type { Arm, RunKey } from "./types.ts";

export type Planned = RunKey & Omit<Arm, "name"> & { prompt: string; /** 0-based place of the arm within its block. */ position: number };

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Fisher-Yates driven by `seed`: the same items and seed always give the same order. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const next = mulberry32(seed), a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

export function plan(tasks: readonly { id: string; prompt: string }[], arms: readonly Arm[], n: number, seed: number): Planned[] {
  const out: Planned[] = [];
  let block = 0;
  for (const task of tasks) {
    for (let rep = 1; rep <= n; rep++, block++) {
      // Each block's order comes from the seed and the block's number, so one block's order does not depend on another's.
      shuffle(arms, (seed ^ Math.imul(block + 1, 0x9e3779b1)) >>> 0).forEach(({ name, ...arm }, position) => out.push({ task: task.id, prompt: task.prompt, arm: name, ...arm, rep, position }));
    }
  }
  return out;
}
