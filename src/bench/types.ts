// The records a benchmark writes. `result.json` and each line of `runs.jsonl` are a `RunResult`; `meta.json` is a `Meta`.
import type { Check } from "../core/tool.ts";
import type { Outcome } from "../core/runtime.ts";

export type ToolSearch = "on" | "off" | "auto";

/**
 * `ungraded` is an ad-hoc `--prompt` run that finished. `limit` never reaches `runs.jsonl`: the run is left
 * unfinished so a resumed benchmark tries it again.
 */
export type Status = "pass" | "fail" | "timeout" | "error" | "limit" | "ungraded";

/** Tokens as the client reports them. `contextProcessed` is the sum of the four. */
export type Usage = { input: number; cacheRead: number; cacheCreation: number; output: number; contextProcessed: number };

/** A call the mock could not serve, as the trace recorded it. `input` is `null` when the whole tool is missing. */
export type Gap = { tool: string; outcome: "unimplemented" | "unsupported_input"; input: string | null };

export type TraceSummary = {
  /** Calls that reached the runtime, whatever the surface: on `code`, every `api.*` call inside an execute. */
  calls: number;
  byOutcome: Record<Outcome, number>;
  /** Tool short names in call order. */
  tools: string[];
  gaps: Gap[];
};

export type Listing = {
  tools: number;
  /** `JSON.stringify` of the `tools/list` result, in bytes. */
  bytes: number;
  /** bytes / 4. A rough guide only: the real count depends on the model's tokenizer and on how the client wraps tools. */
  approxTokens: number;
};

export type RunKey = { task: string; surface: string; rep: number };

export type RunResult = RunKey & {
  client: string;
  /** The model the client reported, or the one asked for when it reports none. */
  model: string;
  toolSearch: ToolSearch;
  status: Status;
  checks: Check[];
  answer: string;
  wallSeconds: number;
  /** Model requests, as the client counts them; null when it does not say. */
  turns: number | null;
  /** Tool calls the model made, as the client saw them: on `code`, each search or execute is one. */
  modelToolCalls: number;
  /** Null when the client reported no usage (a run killed before its final event). */
  usage: Usage | null;
  /** Only when the client reports one. On a subscription it is the client's estimate, not a charge. */
  costUsd?: number;
  /** Prompt tokens of the first model request: system prompt, tool definitions and the task. */
  firstContext?: number;
  /** The tools the model was given at the start, as the client reported them: proof of what it could use. */
  startTools: string[];
  trace: TraceSummary;
  error?: string;
  startedAt: string;
};

export type Meta = {
  label: string;
  startedAt: string;
  /** The machine's local date when the benchmark started: the date the client tells the model, and the world's day. */
  today: string;
  options: {
    surfaces: string[];
    client: string;
    /** Null: the client's default, whatever it reports in the runs. */
    model: string | null;
    tasks: string[];
    n: number;
    timeoutSeconds: number;
    seed: number;
    toolSearch: ToolSearch;
    prompt: string | null;
  };
  client: { name: string; version: string; setup: string[] };
  git: { commit: string; dirty: boolean };
  catalog: { source: string; tools: number };
  listings: Record<string, Listing>;
  runtime: { bun: string; platform: string };
};
