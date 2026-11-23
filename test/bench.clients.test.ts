// The client adapters against event streams recorded from real smoke runs (test/fixtures/, identifiers removed):
// "Who am I signed in as, and what timezone is the company in?" on the code surface.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientNames, loadClient, type ClientRun } from "../src/bench/client.ts";
import claude from "../src/bench/clients/claude.ts";
import codex, { toolNames } from "../src/bench/clients/codex.ts";
import { serverSpec } from "../src/bench/server.ts";

const events = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const run = (toolSearch: ClientRun["toolSearch"]): ClientRun => ({ prompt: "Who am I?", dir: "/r/run", cwd: "/tmp/cwd", toolSearch, server: serverSpec("direct", "2026-11-23", "/r/run") });

test("clients are found by file name", async () => {
  expect(clientNames()).toEqual(["claude", "codex"]);
  expect((await loadClient("codex")).name).toBe("codex");
  expect(loadClient("nope")).rejects.toThrow("unknown client");
});

test("claude: answer, usage, turns, cost and the tools the model started with", () => {
  const r = claude.read(events("claude-code-get-me.jsonl"), "");
  expect(r.answer).toStartWith("You're signed in to Distru as **Maya Okafor**");
  expect(r.answer).toContain("America/Los_Angeles");
  expect(r.usage).toEqual({ input: 6, cacheRead: 7009, cacheCreation: 4127, output: 308, contextProcessed: 11450 });
  expect(r.turns).toBe(3);
  expect(r.modelToolCalls).toBe(2);
  expect(r.costUsd).toBeCloseTo(0.0406, 4);
  expect(r.firstContext).toBe(3280);
  expect(r.model).toBe("claude-opus-5-5");
  expect(r.startTools).toEqual(["mcp__erp__distru-execute", "mcp__erp__distru-search"]);
  expect(r.limitHit).toBe(false);
  expect(r.error).toBeUndefined();
});

test("claude: a run cut before its result keeps the usage seen so far, and says so", () => {
  const cut = events("claude-code-get-me.jsonl").filter((e) => e.type !== "result");
  const r = claude.read(cut, "killed");
  expect(r.usage!.cacheRead + r.usage!.cacheCreation + r.usage!.input).toBeGreaterThan(3280);
  expect(r.error).toBe("no result event: killed");
  expect(r.limitHit).toBe(false);
});

test("claude: a rejected rate limit or a limit message is a limit, an allowed one is not", () => {
  const base = events("claude-code-get-me.jsonl");
  expect(claude.read(base, "").limitHit).toBe(false); // the fixture holds an `allowed` rate_limit_event
  expect(claude.read([...base, { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }], "").limitHit).toBe(true);
  expect(claude.read([{ type: "result", is_error: true, result: "You've hit your limit · resets 3pm" }], "").limitHit).toBe(true);
});

test("claude: tool search is set by both its switches", () => {
  const off = claude.command(run("off")), on = claude.command(run("on"));
  const tools = (argv: string[]) => argv[argv.indexOf("--tools") + 1];
  expect([off.env.ENABLE_TOOL_SEARCH, tools(off.argv)]).toEqual(["false", ""]);
  expect([on.env.ENABLE_TOOL_SEARCH, tools(on.argv)]).toEqual(["true", "ToolSearch"]);
  expect(off.argv.slice(1, 3)).toEqual(["-p", "Who am I?"]);
  expect(off.argv).toContain("--strict-mcp-config");
  expect(JSON.parse(off.config.text).mcpServers.erp.env.BENCH_SURFACE).toBe("direct");
  expect(off.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
});

test("codex: answer, usage and calls; it reports no turns and no cost", () => {
  const r = codex.read(events("codex-code-get-me.jsonl"), "");
  expect(r.answer).toStartWith("You’re signed in to Distru as **Maya Okafor**");
  expect(r.usage).toEqual({ input: 44335 - 17792, cacheRead: 17792, cacheCreation: 0, output: 191, contextProcessed: 44335 + 191 });
  expect(r.modelToolCalls).toBe(3);
  expect(r.turns).toBeNull();
  expect(r.costUsd).toBeUndefined();
  expect(r.limitHit).toBe(false);
  expect(r.error).toBeUndefined();
});

test("codex: a failed turn with a limit message is a limit", () => {
  const r = codex.read([{ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }], "");
  expect(r).toMatchObject({ limitHit: true, usage: null, error: "You've hit your usage limit. Try again later." });
});

test("codex: off registers the server's tools directly; on leaves Codex's deferral; auto is refused", () => {
  const off = codex.command(run("off")).argv, on = codex.command(run("on")).argv;
  expect(off).toContain('mcp_servers.erp.omit_tools_from=["code_mode","deferred"]');
  expect(on.some((a) => a.includes("omit_tools_from"))).toBe(false);
  expect(off).toContain("features.shell_tool=false");
  expect(off.slice(-2)).toEqual(["--", "Who am I?"]);
  expect(codex.check("auto").some((p) => p.includes("no threshold mode"))).toBe(true);
});

test("codex: tool names from a rendered prompt input, namespaces included", () => {
  expect(toolNames([
    { type: "message", role: "user", content: [] },
    { type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }, { type: "namespace", name: "mcp__erp", tools: [{ type: "function", name: "distru_get_me" }] }] },
  ])).toEqual(["functions.exec", "mcp__erp.distru_get_me"]);
});
