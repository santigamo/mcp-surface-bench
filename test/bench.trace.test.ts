import { expect, test } from "bun:test";
import { loadCatalog, shortName } from "../src/catalog/index.ts";
import { Runtime } from "../src/core/runtime.ts";
import { summarizeTrace } from "../src/bench/trace.ts";

test("summary: calls by outcome, tools in order, and the gaps of the mock", () => {
  const s = summarizeTrace([
    { tool: "get-me", outcome: "ok" },
    { tool: "search-orders", outcome: "unsupported_input", error: 'This benchmark world does not implement "customFieldFilters", "leaflinkId" on distru-search-orders. Inputs it implements: limit, cursor.' },
    { tool: "sync-quickbooks", outcome: "unimplemented", error: "distru-sync-quickbooks is not available in this benchmark world." },
    { tool: "search-orders", outcome: "invalid_arguments", error: "Invalid arguments" },
    { tool: "get-me", outcome: "ok" },
  ]);
  expect(s.calls).toBe(5);
  expect(s.byOutcome).toEqual({ ok: 2, tool_error: 0, invalid_arguments: 1, unknown_tool: 0, unimplemented: 1, unsupported_input: 1 });
  expect(s.tools).toEqual(["get-me", "search-orders", "sync-quickbooks", "search-orders", "get-me"]);
  expect(s.gaps).toEqual([
    { tool: "search-orders", outcome: "unsupported_input", input: "customFieldFilters" },
    { tool: "search-orders", outcome: "unsupported_input", input: "leaflinkId" },
    { tool: "sync-quickbooks", outcome: "unimplemented", input: null },
  ]);
  expect(summarizeTrace([]).calls).toBe(0);
});

test("summary: reads the inputs from the runtime's own refusal message", () => {
  // A handler that honours none of its tool's inputs, called with a valid string for one of them: the refusal is
  // whatever the runtime writes, and the summary must name that input.
  const catalog = loadCatalog();
  const spec = catalog.tools.find((t) => !t.ownInputSchema.required?.length && Object.values(t.ownInputSchema.properties ?? {}).some((p) => p.type === "string" && !p.enum))!;
  const tool = shortName(catalog, spec.name);
  const input = Object.entries(spec.ownInputSchema.properties!).find(([, p]) => p.type === "string" && !p.enum)![0];
  const runtime = new Runtime({ catalog, handlers: [{ name: tool, supports: [], run: () => ({}) }], world: {}, now: new Date(), surface: "test" });
  const r = runtime.call(tool, { [input]: "x" });
  expect(r.ok ? "ok" : r.outcome).toBe("unsupported_input");
  if (r.ok) return;
  expect(summarizeTrace([{ tool, outcome: r.outcome, error: r.error }]).gaps).toEqual([{ tool, outcome: "unsupported_input", input }]);
});
