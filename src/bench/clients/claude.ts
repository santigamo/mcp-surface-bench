// Claude Code in print mode, reading its stream-json events. Verified against Claude Code 2.1.330.
import { join } from "node:path";
import { baseEnv, LIMIT_TEXT, type Client, type ClientRun, type Command, type Reading } from "../client.ts";
import type { ToolSearch, Usage } from "../types.ts";

const BIN = Bun.which("claude") ?? "claude";

/**
 * Tool search defers MCP tool definitions behind a `ToolSearch` tool. Two switches decide it, and both are set so
 * neither is left to a default: ENABLE_TOOL_SEARCH (unset means on), and whether `ToolSearch` is among the built-in
 * tools, since leaving it out of `--tools` loads every MCP tool upfront whatever the variable says.
 */
const TOOL_SEARCH: Record<ToolSearch, { env: string; tools: string }> = {
  off: { env: "false", tools: "" },
  on: { env: "true", tools: "ToolSearch" },
  // Defers only once the MCP tool definitions reach 10% of the context window.
  auto: { env: "auto", tools: "ToolSearch" },
};

type Raw = Record<string, any>;

const claude: Client = {
  name: "claude",

  version: () => Bun.spawnSync([BIN, "--version"]).stdout.toString().trim(),

  check() {
    const status = Bun.spawnSync([BIN, "auth", "status"]);
    if (status.exitCode !== 0) return [`claude is not installed or not logged in (\`${BIN} auth status\` exited ${status.exitCode}); run \`claude auth login\``];
    try { if (!JSON.parse(status.stdout.toString()).loggedIn) return ["claude is not logged in; run `claude auth login`"]; } catch {}
    return [];
  },

  setup: (toolSearch) => [
    `ENABLE_TOOL_SEARCH=${TOOL_SEARCH[toolSearch].env}, --tools "${TOOL_SEARCH[toolSearch].tools}"`,
    "--setting-sources \"\" and --strict-mcp-config: no user, project or local settings, plugins or other MCP servers",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, CLAUDE_CODE_DISABLE_AUTO_MEMORY=1: no CLAUDE.md or memory files",
    "--disable-slash-commands: no skills or commands; --no-chrome; --no-session-persistence",
  ],

  command(run: ClientRun): Command {
    const file = join(run.dir, "mcp.json");
    const { name, command, args, env } = run.server;
    const ts = TOOL_SEARCH[run.toolSearch];
    return {
      argv: [
        // The prompt goes right after -p: --tools and --mcp-config take several values and would swallow a later one.
        BIN, "-p", run.prompt,
        "--output-format", "stream-json", "--verbose", // stream-json in print mode requires --verbose
        ...(run.model ? ["--model", run.model] : []),
        "--strict-mcp-config", "--mcp-config", file, // only this server: none from ~/.claude.json, plugins or claude.ai connectors
        "--setting-sources", "", // no settings files, so no hooks, plugins, permission rules or env blocks from the owner's machine
        "--disable-slash-commands", // no skills
        "--no-chrome",
        "--tools", ts.tools, // built-in tools: none, or only ToolSearch
        "--allowedTools", `mcp__${name}`, // every tool of the server, without a permission prompt
        "--permission-mode", "bypassPermissions", // headless: nothing may wait for a person
        "--no-session-persistence",
      ],
      env: baseEnv({
        ENABLE_TOOL_SEARCH: ts.env,
        // Print mode already waits for servers before the first turn; this makes it explicit.
        MCP_CONNECTION_NONBLOCKING: "0",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        DISABLE_AUTOUPDATER: "1",
      }),
      config: { file, text: JSON.stringify({ mcpServers: { [name]: { type: "stdio", command, args, env } } }, null, 2) },
    };
  },

  read(events: unknown[], stderr: string): Reading {
    let init: Raw | undefined, result: Raw | undefined, lastText = "", firstContext: number | undefined, rejected = false;
    // Claude Code emits one assistant event per content block, each repeating the message's usage.
    const perMessage = new Map<string, Usage>();
    const toolUses = new Set<string>();
    for (const e of events as Raw[]) {
      if (e?.type === "system" && e.subtype === "init") init = e;
      else if (e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") rejected = true;
      else if (e?.type === "assistant" && e.message) {
        const m = e.message;
        if (m.usage) {
          const u = toUsage(m.usage);
          if (firstContext === undefined) firstContext = u.input + u.cacheRead + u.cacheCreation;
          const prev = perMessage.get(m.id ?? `#${perMessage.size}`);
          perMessage.set(m.id ?? `#${perMessage.size}`, prev ? maxUsage(prev, u) : u);
        }
        for (const c of m.content ?? []) {
          if (c.type === "tool_use") toolUses.add(c.id);
          if (c.type === "text" && c.text) lastText = c.text;
        }
      } else if (e?.type === "result") result = e;
    }

    // Without a result event (a killed run) the usage is what the assistant events carried: output tokens there are
    // counted when each message starts, so the total is a floor.
    const usage = result?.usage ? toUsage(result.usage) : perMessage.size ? sumUsage([...perMessage.values()]) : null;
    const error = result ? (result.is_error ? String(result.result ?? result.subtype) : undefined) : `no result event${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`;
    return {
      answer: typeof result?.result === "string" && !result.is_error ? result.result : lastText,
      usage,
      turns: typeof result?.num_turns === "number" ? result.num_turns : perMessage.size || null,
      modelToolCalls: toolUses.size,
      ...(typeof result?.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
      ...(firstContext !== undefined ? { firstContext } : {}),
      ...(typeof init?.model === "string" ? { model: init.model } : {}),
      ...(Array.isArray(init?.tools) ? { startTools: init.tools as string[] } : {}),
      limitHit: rejected || LIMIT_TEXT.test(error ?? ""),
      ...(error ? { error } : {}),
    };
  },
};

function toUsage(u: Raw): Usage {
  const input = u.input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0, cacheCreation = u.cache_creation_input_tokens ?? 0, output = u.output_tokens ?? 0;
  return { input, cacheRead, cacheCreation, output, contextProcessed: input + cacheRead + cacheCreation + output };
}
const maxUsage = (a: Usage, b: Usage): Usage => toUsage({ input_tokens: Math.max(a.input, b.input), cache_read_input_tokens: Math.max(a.cacheRead, b.cacheRead), cache_creation_input_tokens: Math.max(a.cacheCreation, b.cacheCreation), output_tokens: Math.max(a.output, b.output) });
const sumUsage = (us: Usage[]): Usage => toUsage({ input_tokens: sum(us, "input"), cache_read_input_tokens: sum(us, "cacheRead"), cache_creation_input_tokens: sum(us, "cacheCreation"), output_tokens: sum(us, "output") });
const sum = (us: Usage[], k: keyof Usage) => us.reduce((s, u) => s + u[k], 0);

export default claude;
