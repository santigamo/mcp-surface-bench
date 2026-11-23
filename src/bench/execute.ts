// One run, start to verdict: set up the directory, start the client, collect what it and the server left, grade it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../core/tool.ts";
import type { World } from "../../suites/erp/world.ts";
import type { Client, ClientRun } from "./client.ts";
import { runChecks, statusOf, worldAfter } from "./grade.ts";
import type { Planned } from "./plan.ts";
import { runProcess } from "./process.ts";
import { serverSpec } from "./server.ts";
import { freshRunDir } from "./storage.ts";
import { suite } from "./suite.ts";
import { readTrace, summarizeTrace } from "./trace.ts";
import type { RunResult, ToolSearch } from "./types.ts";

export type Setting = { root: string; today: string; client: Client; model: string | null; toolSearch: ToolSearch; timeoutSeconds: number };

/** `task` undefined: an ad-hoc prompt, run and measured but not graded. */
export async function execute(s: Setting, p: Planned, task: Task<World> | undefined): Promise<RunResult> {
  const dir = freshRunDir(s.root, p);
  const cwd = mkdtempSync(join(tmpdir(), "mcp-bench-"));
  const run: ClientRun = { prompt: p.prompt, dir, cwd, ...(s.model ? { model: s.model } : {}), toolSearch: s.toolSearch, server: serverSpec(p.surface, s.today, dir) };
  const command = s.client.command(run);
  writeFileSync(command.config.file, command.config.text);
  writeFileSync(join(dir, "command.json"), JSON.stringify({ argv: command.argv, env: Object.keys(command.env).sort() }, null, 2));
  const previewed = s.client.preview?.(run, command);

  const startedAt = new Date().toISOString();
  const done = await runProcess({ argv: command.argv, env: command.env, cwd, timeoutSeconds: s.timeoutSeconds, stdoutPath: join(dir, "events.jsonl"), stderrPath: join(dir, "stderr.txt") });
  rmSync(cwd, { recursive: true, force: true });

  const reading = s.client.read(done.events, done.stderr);
  const checks = task ? runChecks(task, { answer: reading.answer, before: suite.createWorld(s.today), after: worldAfter(suite, s.today, join(dir, "world.json")) }) : null;
  const error = reading.error ?? (done.exitCode !== 0 && !done.timedOut ? `the client exited with ${done.exitCode}` : undefined);

  return {
    task: p.task, surface: p.surface, rep: p.rep,
    client: s.client.name,
    model: reading.model ?? s.model ?? `${s.client.name} default`,
    toolSearch: s.toolSearch,
    status: statusOf({ limitHit: reading.limitHit, timedOut: done.timedOut, ...(error ? { error } : {}), checks }),
    checks: checks ?? [],
    answer: reading.answer,
    wallSeconds: Math.round(done.wallSeconds * 10) / 10,
    turns: reading.turns,
    modelToolCalls: reading.modelToolCalls,
    usage: reading.usage,
    ...(reading.costUsd !== undefined ? { costUsd: reading.costUsd } : {}),
    ...(reading.firstContext !== undefined ? { firstContext: reading.firstContext } : {}),
    startTools: previewed ?? reading.startTools ?? [],
    trace: summarizeTrace(readTrace(join(dir, "trace.jsonl"))),
    ...(error ? { error } : {}),
    startedAt,
  };
}
