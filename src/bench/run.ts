// `bun run bench -- [options]`: runs every task on every surface through one agent CLI, grades each run, and prints
// the report. Run the same command again to resume: finished runs are skipped. Options: src/bench/options.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "../catalog/index.ts";
import { SURFACES } from "../surfaces/index.ts";
import { clientNames, loadClient } from "./client.ts";
import { execute } from "./execute.ts";
import { localDate, parseOptions } from "./options.ts";
import { plan } from "./plan.ts";
import { gitState, runtime } from "./provenance.ts";
import { renderReport, runLine } from "./render.ts";
import { listTools, serverSpec } from "./server.ts";
import { isFinished, readMeta, readRuns, resultsDir, saveFinished, writeMeta } from "./storage.ts";
import { adHoc, preflight, selectTasks, suite } from "./suite.ts";
import type { Listing, Meta } from "./types.ts";

const stop = (...lines: string[]): never => { console.error(lines.join("\n")); process.exit(2); };
const attempt = <T>(f: () => T): T => { try { return f(); } catch (e) { return stop((e as Error).message); } };

// 1. The options, and the benchmark they resume when results/<label>/ already exists.
const options = attempt(() => parseOptions(process.argv.slice(2), { surfaces: Object.keys(SURFACES), clients: clientNames() }));
const root = resultsDir(options.label);
const previous = readMeta(root);
const today = previous?.today ?? localDate();
if (localDate() !== today) stop(`${root} was started on ${today} and today is ${localDate()}: the client would tell the model a different date than the world was built for. Use a new --label.`);
const seed = options.seed ?? previous?.options.seed ?? Math.floor(Math.random() * 2 ** 31);

// 2. The client, and whether it can run here.
const client = await loadClient(options.client);
const unready = client.check(options.toolSearch);
if (unready.length) stop(`${client.name} cannot run:`, ...unready.map((p) => `  - ${p}`));

// 3. The tasks, and whether they can be graded today.
const catalog = loadCatalog();
const tasks = options.prompt ? [adHoc(options.prompt)] : attempt(() => selectTasks(options.tasks));
const ungradable = options.prompt ? [] : preflight(suite.createWorld(today));
if (ungradable.length) stop(`The tasks cannot be graded on ${today}:`, ...ungradable.map((p) => `  - ${p}`));

// 4. Every surface starts, and its tool listing is measured.
const listings: Record<string, Listing> = {};
for (const surface of options.surfaces) {
  const { names: _, ...listing } = await listTools(serverSpec(surface, today)).catch((e: Error) => stop(`the ${surface} surface did not start: ${e.message}`));
  listings[surface] = listing;
}

// 5. meta.json, or the proof that this is the benchmark it resumes.
const meta: Meta = {
  label: options.label,
  startedAt: new Date().toISOString(),
  today,
  options: { surfaces: options.surfaces, client: client.name, model: options.model, tasks: tasks.map((t) => t.id), n: options.n, timeoutSeconds: options.timeoutSeconds, seed, toolSearch: options.toolSearch, prompt: options.prompt },
  client: { name: client.name, version: client.version(), setup: client.setup(options.toolSearch) },
  git: gitState(),
  catalog: { source: catalog.source, tools: catalog.tools.length },
  listings,
  runtime: runtime(),
};
if (previous) {
  const changed = (["options", "client", "catalog", "listings"] as const).filter((k) => JSON.stringify(previous[k]) !== JSON.stringify(meta[k]));
  if (changed.length) stop(`${root} holds a benchmark run with different ${changed.join(", ")}; its results would not compare. Use a new --label.`);
  if (previous.git.commit !== meta.git.commit) console.warn(`note: ${root} was started at commit ${previous.git.commit.slice(0, 10)}; the code is now at ${meta.git.commit.slice(0, 10)}`);
} else writeMeta(root, meta);

// 6. The runs not finished yet, one at a time.
const planned = plan(tasks, options.surfaces, options.n, seed);
const todo = planned.filter((p) => !isFinished(root, p));
console.log(`${root}\n${planned.length} runs planned, ${planned.length - todo.length} already finished; ${client.name} ${meta.client.version}, tool search ${options.toolSearch}, today ${today}, seed ${seed}`);
const setting = { root, today, client, model: options.model, toolSearch: options.toolSearch, timeoutSeconds: options.timeoutSeconds };
for (const [i, p] of todo.entries()) {
  if (localDate() !== today) { console.error(`The date changed to ${localDate()}; stopped with ${todo.length - i} runs left. They cannot finish under this label.`); process.exitCode = 3; break; }
  const result = await execute(setting, p, options.prompt ? undefined : suite.tasks.find((t) => t.id === p.task));
  if (result.status === "limit") {
    console.error(`[${i + 1}/${todo.length}] ${p.task} ${p.surface} #${p.rep}: the client hit a usage or rate limit (${result.error ?? "no message"}). Stopped; ${todo.length - i} runs left. Run the same command to resume.`);
    process.exitCode = 3;
    break;
  }
  saveFinished(root, result);
  console.log(runLine(i + 1, todo.length, result));
}

// 7. The report, over every finished run of this label.
const report = renderReport(previous ?? meta, readRuns(root));
writeFileSync(join(root, "report.md"), report);
console.log(`\n${report}`);
