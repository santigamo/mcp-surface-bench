import { appendFileSync, writeFileSync } from "node:fs";
import Ajv, { type ValidateFunction } from "ajv";
import { shortName, type Catalog, type ToolSpec } from "../catalog/index.ts";
import { ToolError, type Handler } from "./tool.ts";

export type Outcome =
  | "ok"
  /** The tool raised an error the real server would raise too. */
  | "tool_error"
  /** Arguments that do not match the tool's schema. */
  | "invalid_arguments"
  | "unknown_tool"
  /** A documented tool this world has no handler for. */
  | "unimplemented"
  /** A documented input this world's handler does not honour. */
  | "unsupported_input";

export type CallResult = { ok: true; value: unknown } | { ok: false; outcome: Exclude<Outcome, "ok">; error: string };

export type TraceRow = { at: string; surface: string; tool: string; args: unknown; outcome: Outcome; error?: string; ms: number; bytes: number };

type Options<W> = {
  catalog: Catalog;
  handlers: Handler<W>[];
  world: W;
  now: Date;
  surface: string;
  /** Appended with one JSON line per call. */
  tracePath?: string;
  /** Rewritten with the whole world after every write tool that succeeds. */
  statePath?: string;
  /** Refuse to return a result that does not match the tool's documented shape (used by the tests). */
  checkOutputs?: boolean;
};

/** The names of the inputs every tool shares; they are logged and otherwise ignored, as the documentation says. */
const SHARED = ["intent", "userSatisfactionEstimate", "account"];

/**
 * The one place a tool call is carried out. Every surface goes through it, so the surfaces differ only in what
 * they show the model, never in what a call does.
 */
export class Runtime<W> {
  private readonly specs = new Map<string, ToolSpec>();
  private readonly handlers = new Map<string, Handler<W>>();
  private readonly validators = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();
  private readonly ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });

  constructor(private readonly o: Options<W>) {
    for (const spec of o.catalog.tools) this.specs.set(shortName(o.catalog, spec.name), spec);
    for (const h of o.handlers) {
      const spec = this.specs.get(h.name);
      if (!spec) throw new Error(`handler for a tool that is not in the catalog: ${h.name}`);
      const unknown = h.supports.filter((k) => !(k in spec.ownInputSchema.properties!));
      if (unknown.length) throw new Error(`${h.name} claims to support undocumented inputs: ${unknown.join(", ")}`);
      if (this.handlers.has(h.name)) throw new Error(`two handlers for ${h.name}`);
      this.handlers.set(h.name, h);
    }
  }

  get world(): W { return this.o.world; }
  spec(short: string): ToolSpec | undefined { return this.specs.get(short); }
  implemented(short: string): boolean { return this.handlers.has(short); }

  /** Calls a tool by its short name. Never throws: every failure is a result the surface can show the model. */
  call(short: string, rawArgs: unknown): CallResult {
    const started = performance.now();
    const result = this.dispatch(short, rawArgs);
    const row: TraceRow = {
      at: new Date().toISOString(), surface: this.o.surface, tool: short, args: rawArgs,
      outcome: result.ok ? "ok" : result.outcome, ...(result.ok ? {} : { error: result.error }),
      ms: Math.round(performance.now() - started), bytes: result.ok ? JSON.stringify(result.value).length : result.error.length,
    };
    if (this.o.tracePath) appendFileSync(this.o.tracePath, JSON.stringify(row) + "\n");
    if (result.ok && this.specs.get(short)?.kind === "write" && this.o.statePath) writeFileSync(this.o.statePath, JSON.stringify(this.o.world));
    return result;
  }

  private dispatch(short: string, rawArgs: unknown): CallResult {
    const spec = this.specs.get(short);
    if (!spec) return { ok: false, outcome: "unknown_tool", error: `Unknown tool: ${short}` };
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return { ok: false, outcome: "invalid_arguments", error: "Arguments must be an object." };

    const args: Record<string, unknown> = { ...rawArgs };
    for (const k of SHARED) delete args[k];

    const v = this.validatorsFor(short, spec);
    if (!v.input(args)) {
      const problems = (v.input.errors ?? []).map((e) => {
        const where = e.instancePath.slice(1).replaceAll("/", ".") || "arguments";
        const extra = e.keyword === "additionalProperties" ? ` "${(e.params as { additionalProperty: string }).additionalProperty}"` : e.keyword === "enum" ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}` : "";
        return `${where} ${e.message}${extra}`;
      });
      return { ok: false, outcome: "invalid_arguments", error: `Invalid arguments for ${spec.name}: ${[...new Set(problems)].join("; ")}` };
    }

    const handler = this.handlers.get(short);
    if (!handler) return { ok: false, outcome: "unimplemented", error: `${spec.name} is not available in this benchmark world.` };
    const unsupported = Object.keys(args).filter((k) => !handler.supports.includes(k));
    if (unsupported.length) {
      return { ok: false, outcome: "unsupported_input", error: `This benchmark world does not implement ${unsupported.map((k) => `"${k}"`).join(", ")} on ${spec.name}. Inputs it implements: ${handler.supports.join(", ") || "none"}.` };
    }

    let value: unknown;
    try { value = handler.run(args, { world: this.o.world, now: this.o.now }); }
    catch (e) {
      if (e instanceof ToolError) return { ok: false, outcome: "tool_error", error: e.message };
      throw e;
    }
    if (this.o.checkOutputs && !v.output(value)) {
      throw new Error(`${short} returned a result that does not match its documented shape: ${this.ajv.errorsText(v.output.errors, { separator: "; " })}`);
    }
    return { ok: true, value };
  }

  private validatorsFor(short: string, spec: ToolSpec) {
    let v = this.validators.get(short);
    if (!v) this.validators.set(short, (v = { input: this.ajv.compile(spec.ownInputSchema), output: this.ajv.compile(spec.outputSchema) }));
    return v;
  }
}
