// The suite under test, its tasks, and the ad-hoc prompt that stands in for them.
import { createHash } from "node:crypto";
import type { Task } from "../core/tool.ts";
import { erp } from "../../suites/erp/index.ts";
import * as taskModule from "../../suites/erp/tasks.ts";
import type { World } from "../../suites/erp/world.ts";

export const suite = erp;

/**
 * Problems that make the tasks ungradable on this world's day, from the suite's own `preflight` when it exports one.
 * Read through the namespace so this compiles and runs whether or not tasks.ts has it yet.
 */
export function preflight(world: World): string[] {
  const check = (taskModule as { preflight?: (w: World) => string[] }).preflight;
  return typeof check === "function" ? check(world) : [];
}

export function selectTasks(wanted: string[] | "all"): Task<World>[] {
  if (wanted === "all") {
    if (!suite.tasks.length) throw new Error(`the ${suite.name} suite has no tasks yet; use --prompt "<text>" for an ad-hoc run`);
    return suite.tasks;
  }
  const missing = wanted.filter((id) => !suite.tasks.some((t) => t.id === id));
  if (missing.length) throw new Error(`unknown task ${missing.join(", ")}; known: ${suite.tasks.map((t) => t.id).join(", ") || "none"}`);
  return wanted.map((id) => suite.tasks.find((t) => t.id === id)!);
}

/** An ungraded task. Its id comes from the text, so a different prompt under the same label is a different run. */
export const adHoc = (prompt: string) => ({ id: `prompt-${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`, prompt });

/** The world's fingerprint: two benchmarks, or a benchmark and its resumption, start from the same world when these match. */
export const worldHash = (world: unknown) => createHash("sha256").update(JSON.stringify(world)).digest("hex");
