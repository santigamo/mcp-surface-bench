// Codex in exec mode, reading its --json events. Verified against codex-cli 0.167.0.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { baseEnv, LIMIT_TEXT, type Client, type ClientRun, type Command, type Reading } from "../client.ts";
import type { ToolSearch } from "../types.ts";

const BIN = Bun.which("codex") ?? "codex";

/**
 * A Codex home of the benchmark's own, logged in once with `CODEX_HOME=<dir> codex login`. The owner's ~/.codex
 * holds a global AGENTS.md and skills that reach the prompt from the home directory itself (`--ignore-user-config`
 * skips only config.toml); and Codex rewrites auth.json by renaming a new file over it, so a copied or linked
 * credential would drift from the real one on the first token refresh.
 */
export const CODEX_HOME = process.env.BENCH_CODEX_HOME ?? resolve(import.meta.dir, "../../../results/.codex-home");

/**
 * Built-in tools that config can switch off. What stays is set by the model catalog and no setting removes it: on
 * every model codex 0.167 lists (`tool_mode: code_mode_only`, `multi_agent_version: v2`) the model also gets
 * `exec`/`wait` (a V8 isolate with no file system or network), `request_user_input` and the `collaboration` tools.
 */
const FEATURES_OFF = ["shell_tool", "unified_exec", "multi_agent", "apps", "plugins", "memories", "hooks", "goals", "sleep_tool", "tool_suggest", "image_generation", "browser_use", "computer_use", "view_image", "in_app_browser"];

/**
 * Codex has no tool-search switch. On a model that supports search (all of them in 0.167), MCP tools are by default
 * deferred and reachable only from inside Codex's own `exec` code mode. `omit_tools_from` on the server takes them
 * out of both, so they are registered as plain functions the model calls directly.
 */
const EXPOSURE: Record<"on" | "off", string[]> = { off: ['omit_tools_from=["code_mode","deferred"]'], on: [] };

/** A JSON string is a valid TOML basic string. */
const q = (s: string) => JSON.stringify(s);

/** The `-c` overrides of a command, in order. */
const overrides = (argv: string[]) => argv.flatMap((a, i) => (a === "-c" && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));

type Raw = Record<string, any>;

const codex: Client = {
  name: "codex",

  version: () => Bun.spawnSync([BIN, "--version"]).stdout.toString().trim(),

  check(toolSearch) {
    const problems: string[] = [];
    if (toolSearch === "auto") problems.push("codex has no threshold mode for tool search: use --tool-search on (its default) or off");
    if (!existsSync(join(CODEX_HOME, "auth.json"))) problems.push(`codex is not logged in for the benchmark: run \`CODEX_HOME=${CODEX_HOME} codex login\` (or set BENCH_CODEX_HOME)`);
    return problems;
  },

  setup: (toolSearch) => [
    `CODEX_HOME=${CODEX_HOME} and --ignore-user-config: none of ~/.codex (AGENTS.md, skills, plugins, MCP servers, hooks)`,
    toolSearch === "off" ? "MCP tools registered directly (omit_tools_from code_mode and deferred)" : "MCP tools deferred inside Codex's code mode (its default)",
    `features off: ${FEATURES_OFF.join(", ")}; web_search disabled; skills.include_instructions=false`,
    "always present (model catalog): exec, wait, request_user_input, collaboration tools",
    "codex exec does not report the model it used: without --model, runs record \"codex default\"",
  ],

  command(run: ClientRun): Command {
    const { name, command, args, env } = run.server;
    const exposure = EXPOSURE[run.toolSearch === "off" ? "off" : "on"];
    const server = [
      `command=${q(command)}`,
      `args=[${args.map(q).join(",")}]`,
      `env={${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(",")}}`,
      "startup_timeout_sec=60",
      'default_tools_approval_mode="approve"', // MCP calls run without asking anyone
      ...exposure,
    ].map((kv) => `mcp_servers.${name}.${kv}`);
    const settings = ['approval_policy="never"', 'web_search="disabled"', "skills.include_instructions=false", ...FEATURES_OFF.map((f) => `features.${f}=false`), ...server];
    return {
      argv: [
        BIN, "exec", "--json",
        "--ephemeral", // no session files
        "--skip-git-repo-check", // the run directory is not a repository
        "--ignore-user-config", "--ignore-rules", // nothing from a config.toml or .rules files, even in the benchmark's home
        "-s", "read-only", // a second fence should any command tool survive
        "-C", run.cwd,
        ...(run.model ? ["-m", run.model] : []),
        ...settings.flatMap((s) => ["-c", s]),
        "--", run.prompt,
      ],
      env: baseEnv({ CODEX_HOME }),
      config: { file: join(run.dir, "codex-config.toml"), text: settings.join("\n") + "\n" },
    };
  },

  /** `codex debug prompt-input` renders the request's input, tool list included, with the same settings and no model call. */
  preview(run: ClientRun, cmd: Command): string[] {
    const argv = [BIN, "debug", "prompt-input", ...overrides(cmd.argv).flatMap((c) => ["-c", c]), ...(run.model ? ["-c", `model=${q(run.model)}`] : []), "--", run.prompt];
    const out = Bun.spawnSync(argv, { cwd: run.cwd, env: cmd.env });
    if (out.exitCode !== 0) throw new Error(`codex debug prompt-input failed: ${out.stderr.toString().slice(0, 300)}`);
    return toolNames(JSON.parse(out.stdout.toString()) as Raw[]);
  },

  read(events: unknown[], stderr: string): Reading {
    let answer = "", calls = 0, error: string | undefined, usage: Raw | undefined;
    for (const e of events as Raw[]) {
      if (e?.type === "item.completed" && e.item) {
        if (e.item.type === "agent_message") answer = e.item.text ?? "";
        else if (!["reasoning", "todo_list", "error"].includes(e.item.type)) calls++;
      } else if (e?.type === "turn.completed" && e.usage) usage = e.usage;
      else if (e?.type === "turn.failed") error = String(e.error?.message ?? "turn failed");
      else if (e?.type === "error") error = String(e.message ?? "error");
    }
    if (!usage && !error) error = `no turn.completed event${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`;
    // input_tokens counts every prompt token, cached ones included (OpenAI's convention), so the uncached part is the
    // rest. Output tokens include reasoning. Codex reports no cost.
    const input = usage?.input_tokens ?? 0, cached = usage?.cached_input_tokens ?? 0, written = usage?.cache_write_input_tokens ?? 0, output = usage?.output_tokens ?? 0;
    return {
      answer,
      usage: usage ? { input: Math.max(0, input - cached - written), cacheRead: cached, cacheCreation: written, output, contextProcessed: input + output } : null,
      // codex exec reports one turn per prompt, however many model requests it made.
      turns: null,
      modelToolCalls: calls,
      limitHit: LIMIT_TEXT.test(error ?? ""),
      ...(error ? { error } : {}),
    };
  },
};

/** Tool names from a rendered prompt input: `functions.exec`, `mcp__erp.distru_get_me`. */
export function toolNames(input: Raw[]): string[] {
  const walk = (tools: Raw[], prefix: string): string[] =>
    tools.flatMap((t) => (t.type === "namespace" ? walk(t.tools ?? [], `${prefix}${t.name}.`) : [`${prefix}${t.name ?? t.type}`]));
  return input.filter((i) => i.type === "additional_tools").flatMap((i) => walk(i.tools ?? [], ""));
}

export default codex;
