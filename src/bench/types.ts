// The records a benchmark writes. `result.json` and each line of `runs.jsonl` are a `RunResult`; `meta.json` is a
// `Meta`; each line of `regrades.jsonl` is a `RegradePass`.
import type { Check } from "../core/tool.ts";
import type { Outcome } from "../core/runtime.ts";

export type ToolSearch = "on" | "off" | "auto";

/**
 * What one run is compared against the others on: a surface, and the client options that change what the model is
 * shown. `name` is how the command line spells it (`direct+search`) and how runs, tables and directories name it.
 */
export type Arm = { name: string; surface: string; toolSearch: ToolSearch };

/** The version of the layout of results/<label>/. A directory written by another version is not read. */
export const FORMAT = 2;

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

export type RunKey = { task: string; arm: string; rep: number };

/** Who gave a verdict: when, and the code's commit at the time (graders live in the repository). */
export type Grading = { at: string; commit: string; dirty: boolean };

/**
 * A verdict a regrade replaced: what it was (status, failed required checks), when and at which commit it had been
 * given, and when it was replaced. The grader that replaced it is the next entry's, or the run's `graded`.
 */
export type Replaced = Grading & { status: Status; failed: string[]; replacedAt: string };

/**
 * `reported`: the client said which model it ran. `requested`: it did not, and `--model` named one. `default`: it
 * did not and none was named; for Codex the default is fixed by the client version meta.json records.
 */
export type ModelSource = "reported" | "requested" | "default";

/** The same for the reasoning effort. Neither client reports it in its events today, so it is what was asked for. */
export type EffortSource = ModelSource;

export type RunResult = RunKey & {
  /** What the arm resolved to: its surface, its tool search, and that tool search in the client's own words. */
  surface: string;
  toolSearch: ToolSearch;
  armSetting: string;
  client: string;
  /** The model that ran, or what is known of it: see `modelSource`. */
  model: string;
  modelSource: ModelSource;
  /** The reasoning effort, or null for the client's default: see `effortSource`. */
  effort: string | null;
  effortSource: EffortSource;
  status: Status;
  /** Every check, informative ones (`required: false`) included. */
  checks: Check[];
  graded: Grading;
  /** Verdicts replaced by regrades, oldest first. Absent until one changes. */
  history?: Replaced[];
  answer: string;
  wallSeconds: number;
  /** Model requests, as the client counts them; null when it does not say. */
  turns: number | null;
  /** Tool calls the model made, as the client saw them: on `code`, each search or execute is one; tool searches count. */
  modelToolCalls: number;
  /**
   * The client's own tool searches (Claude Code's `ToolSearch`), in all and before the model's first call to the
   * server. Absent when the client's events do not show them.
   */
  toolSearches?: { total: number; beforeFirstCall: number };
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
  format: typeof FORMAT;
  label: string;
  startedAt: string;
  /** The machine's local date when the benchmark started: the date the client tells the model, and the world's day. */
  today: string;
  options: {
    /** Arm names, in the order the command line gave them: the order of every table. */
    arms: string[];
    client: string;
    /** Null: the client's default, whatever it reports in the runs. */
    model: string | null;
    /** Null: the client's default; nothing was passed. */
    effort: string | null;
    tasks: string[];
    n: number;
    timeoutSeconds: number;
    seed: number;
    prompt: string | null;
  };
  /** Each arm as it resolved, with its tool search in the client's words. */
  arms: (Arm & { setting: string })[];
  /** `setup`: how the client is set up for every arm. */
  client: { name: string; version: string; setup: string[] };
  git: { commit: string; dirty: boolean };
  catalog: { source: string; tools: number };
  /** By surface. */
  listings: Record<string, Listing>;
  /** The world every run started from, saved as world-before.json; its hash proves a resumed run starts from the same. */
  world: { sha256: string };
  runtime: { bun: string; platform: string };
};

/** One `bun run regrade`. */
export type RegradePass = Grading & {
  runs: number;
  /** Runs whose verdict (status, or the required checks that failed) changed. */
  changed: { task: string; arm: string; rep: number; from: Status; to: Status }[];
};
