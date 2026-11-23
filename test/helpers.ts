import { loadCatalog } from "../src/catalog/index.ts";
import { Runtime } from "../src/core/runtime.ts";
import { erp } from "../suites/erp/index.ts";
import type { World } from "../suites/erp/world.ts";

export const TODAY = "2026-11-23";

/**
 * A fresh world and a runtime that refuses any result that does not match the tool's documented shape.
 * `call` returns the result of a call that must succeed; `error` returns the message of one that must fail.
 */
export function bench(today = TODAY) {
  const world: World = erp.createWorld(today);
  const runtime = new Runtime({ catalog: loadCatalog(), handlers: erp.handlers, world, now: erp.clock(today), surface: "test", checkOutputs: true });
  return {
    world,
    runtime,
    call<T = any>(tool: string, args: Record<string, unknown> = {}): T {
      const r = runtime.call(tool, args);
      if (!r.ok) throw new Error(`${tool} failed (${r.outcome}): ${r.error}`);
      return r.value as T;
    },
    error(tool: string, args: Record<string, unknown> = {}): string {
      const r = runtime.call(tool, args);
      if (r.ok) throw new Error(`${tool} was expected to fail`);
      return `${r.outcome}: ${r.error}`;
    },
  };
}
