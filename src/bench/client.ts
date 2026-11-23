// What the runner needs from an agent CLI. Each client is one file in ./clients/ whose default export is a `Client`;
// the runner loads it by name, so adding a client means adding that file and nothing else.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerSpec } from "./server.ts";
import type { ToolSearch, Usage } from "./types.ts";

export type ClientRun = {
  prompt: string;
  /** The run's directory under results/, where the client's configuration goes. */
  dir: string;
  /**
   * The client's working directory: empty, and outside any git repository, since clients describe the working
   * directory and its repository to the model.
   */
  cwd: string;
  /** Undefined: the client's default. */
  model?: string;
  /** Reasoning effort. Undefined: the client's default, and nothing is passed. */
  effort?: string;
  toolSearch: ToolSearch;
  /**
   * The user's timezone, which is the suite's: the client runs with TZ set to it, so the date it tells the model (and,
   * for Codex, the timezone) are the company's, not the machine's.
   */
  timezone: string;
  /** The one MCP server the model may use. */
  server: ServerSpec;
};

export type Command = {
  argv: string[];
  /** The whole environment of the process: nothing else from the runner's environment reaches it. */
  env: Record<string, string>;
  /** The MCP configuration, written into the run directory before the client starts. */
  config: { file: string; text: string };
};

export type Reading = {
  answer: string;
  usage: Usage | null;
  turns: number | null;
  modelToolCalls: number;
  costUsd?: number;
  firstContext?: number;
  /** The model the client says it used. */
  model?: string;
  /** The reasoning effort the client says it used. */
  effort?: string;
  /** Tools the model started with, when the event stream says. */
  startTools?: string[];
  /** The client's own tool searches, when the event stream shows them. */
  toolSearches?: { total: number; beforeFirstCall: number };
  limitHit: boolean;
  error?: string;
};

export type Client = {
  name: string;
  version(): string;
  /**
   * Problems that stop a benchmark before it starts (not logged in, a setting this client cannot honour, an effort
   * level it does not accept). Asked once per arm.
   */
  check(o: { toolSearch: ToolSearch; model: string | null; effort: string | null }): string[];
  /** How this client is set up for every arm, in words, for meta.json. */
  setup(): string[];
  /** What an arm's tool search becomes in this client, in words: what the arm resolved to. */
  toolSearchSetting(toolSearch: ToolSearch): string;
  command(run: ClientRun): Command;
  /**
   * The tools the model will be given, read without calling a model. For clients whose event stream does not say.
   * Takes the same command, so what it shows is what the run gets.
   */
  preview?(run: ClientRun, command: Command): string[];
  read(events: unknown[], stderr: string): Reading;
};

const DIR = join(import.meta.dir, "clients");

export const clientNames = (): string[] => readdirSync(DIR).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)).sort();

export async function loadClient(name: string): Promise<Client> {
  if (!clientNames().includes(name)) throw new Error(`unknown client "${name}"; known: ${clientNames().join(", ")}`);
  return ((await import(join(DIR, `${name}.ts`))) as { default: Client }).default;
}

/** Provider messages that mean a usage or rate limit stopped the run, not the task. */
export const LIMIT_TEXT = /usage limit|rate.?limit|hit your limit|out of extra usage|\d+-?\s?hour limit|(weekly|daily|monthly|session) limit|limit (reached|exceeded)|limit resets|credit balance is too low|quota/i;

/**
 * The environment a client may see from the runner's: identity, locale, proxies and certificates. Session tokens,
 * other agents' variables and switches such as CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS stay out, and so does the
 * runner's TZ: a client's TZ is the run's timezone, which each client sets.
 */
const PASS = /^(HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|__CF_USER_TEXT_ENCODING|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS)$/;
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

export function baseEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && PASS.test(k)) env[k] = v;
  return { ...env, PATH: SYSTEM_PATH, NO_COLOR: "1", ...extra };
}
