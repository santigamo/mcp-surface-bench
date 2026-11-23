// `bun run bench -- [options]`: runs every task on every arm through one agent CLI, grades each run, and prints
// the report. Run the same command again to resume: finished runs are skipped. Options: src/bench/options.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "../catalog/index.ts";
import { SURFACES } from "../surfaces/index.ts";
import { clientNames, loadClient } from "./client.ts";
import { execute } from "./execute.ts";
import { dayIn } from "../core/kit.ts";
import { machineDate, machineTimezone, parseOptions } from "./options.ts";
import { plan } from "./plan.ts";
import { gitState, runtime } from "./provenance.ts";
import { renderReport, runLine } from "./render.ts";
import { modelMismatch, reportedModels, resumeProblems } from "./resume.ts";
import { listTools, serverSpec } from "./server.ts";
import { isFinished, readMeta, readRegrades, readRuns, resultsDir, saveFinished, writeMeta } from "./storage.ts";
import { adHoc, preflight, selectTasks, suite, worldHash } from "./suite.ts";
import { FORMAT, type Listing, type Meta } from "./types.ts";

const stop = (...lines: string[]): never => { console.error(lines.join("\n")); process.exit(2); };
const attempt = <T>(f: () => T): T => { try { return f(); } catch (e) { return stop((e as Error).message); } };

// 1. The options, and the benchmark they resume when results/<label>/ already exists.
const options = attempt(() => parseOptions(process.argv.slice(2), { surfaces: Object.keys(SURFACES), clients: clientNames() }));
const root = resultsDir(options.label);
const previous = attempt(() => readMeta(root));
// The user is where the company is: the clients run in the suite's timezone, and the world is built for the date there.
const timezone = suite.timezone;
const dateThere = () => dayIn(timezone, new Date());
const today = previous?.today ?? dateThere();
if (dateThere() !== today) stop(`${root} was started on ${today} and today is ${dateThere()} (${timezone}): the client would tell the model a different date than the world was built for. Use a new --label.`);
const seed = options.seed ?? previous?.options.seed ?? Math.floor(Math.random() * 2 ** 31);

// 2. The client, and whether it can run every arm here.
const client = await loadClient(options.client);
const unready = [...new Set(options.arms.flatMap((a) => client.check({ toolSearch: a.toolSearch, model: options.model, effort: options.effort })))];
if (unready.length) stop(`${client.name} cannot run:`, ...unready.map((p) => `  - ${p}`));

// 3. The tasks, and whether they can be graded today.
const catalog = loadCatalog();
const tasks = options.prompt ? [adHoc(options.prompt)] : attempt(() => selectTasks(options.tasks));
const before = suite.createWorld(today);
const ungradable = options.prompt ? [] : preflight(before);
if (ungradable.length) stop(`The tasks cannot be graded on ${today}:`, ...ungradable.map((p) => `  - ${p}`));

// 4. Every surface the arms use starts, and its tool listing is measured.
const listings: Record<string, Listing> = {};
for (const surface of new Set(options.arms.map((a) => a.surface))) {
  const { names: _, ...listing } = await listTools(serverSpec(surface, today, timezone)).catch((e: Error) => stop(`the ${surface} surface did not start: ${e.message}`));
  listings[surface] = listing;
}

// 5. meta.json, or the proof that this is the benchmark it resumes.
const meta: Meta = {
  format: FORMAT,
  label: options.label,
  startedAt: new Date().toISOString(),
  today,
  timezone,
  machine: { timezone: machineTimezone(), date: machineDate() },
  options: { arms: options.arms.map((a) => a.name), client: client.name, model: options.model, effort: options.effort, tasks: tasks.map((t) => t.id), n: options.n, timeoutSeconds: options.timeoutSeconds, seed, prompt: options.prompt },
  arms: options.arms.map((a) => ({ ...a, setting: client.toolSearchSetting(a.toolSearch) })),
  client: { name: client.name, version: client.version(), setup: client.setup() },
  git: gitState(),
  catalog: { source: catalog.source, tools: catalog.tools.length },
  listings,
  world: { sha256: worldHash(before) },
  runtime: runtime(),
};
const finished = readRuns(root);
if (previous) {
  const problems = resumeProblems(previous, meta, finished);
  if (problems.length) stop(`${root} holds a benchmark these runs would not compare with:`, ...problems.map((p) => `  - ${p}`), "Use a new --label.");
  if (previous.git.commit !== meta.git.commit) console.warn(`note: ${root} was started at commit ${previous.git.commit.slice(0, 10)}; the code is now at ${meta.git.commit.slice(0, 10)}`);
} else writeMeta(root, meta, before);

// 6. The runs not finished yet, one at a time.
const planned = plan(tasks, options.arms, options.n, seed);
const todo = planned.filter((p) => !isFinished(root, p));
const models = reportedModels(finished);
console.log(`${root}\n${planned.length} runs planned, ${planned.length - todo.length} already finished; ${client.name} ${meta.client.version}, model ${options.model ?? "the client's default"}${models.length ? ` (ran ${models.join(", ")})` : ""}, effort ${options.effort ?? "the client's default"}, arms ${meta.options.arms.join(", ")}, today ${today} (${timezone}; the machine says ${machineDate()}, ${machineTimezone()}), seed ${seed}`);
const setting = { root, today, timezone, client, model: options.model, effort: options.effort, timeoutSeconds: options.timeoutSeconds, before, git: meta.git };
for (const [i, p] of todo.entries()) {
  if (dateThere() !== today) { console.error(`The date in ${timezone} changed to ${dateThere()}; stopped with ${todo.length - i} runs left. They cannot finish under this label.`); process.exitCode = 3; break; }
  const result = await execute(setting, p, options.prompt ? undefined : suite.tasks.find((t) => t.id === p.task));
  if (result.status === "limit") {
    console.error(`[${i + 1}/${todo.length}] ${p.task} ${p.arm} #${p.rep}: the client hit a usage or rate limit (${result.error ?? "no message"}). Stopped; ${todo.length - i} runs left. Run the same command to resume.`);
    process.exitCode = 3;
    break;
  }
  // Left unfinished, its directory kept for a look: it would mix models in the report.
  const mismatch = modelMismatch(models, result);
  if (mismatch) { console.error(`[${i + 1}/${todo.length}] ${p.task} ${p.arm} #${p.rep}: ${mismatch} Stopped; the run is not counted.`); process.exitCode = 3; break; }
  if (result.modelSource === "reported" && !models.includes(result.model)) models.push(result.model);
  saveFinished(root, result);
  console.log(runLine(i + 1, todo.length, result));
}

// 7. The report, over every finished run of this label.
const report = renderReport(previous ?? meta, readRuns(root), readRegrades(root));
writeFileSync(join(root, "report.md"), report);
console.log(`\n${report}`);
