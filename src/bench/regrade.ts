// `bun run regrade -- --label <name>`: grades every stored run of a benchmark again with the graders as they are now,
// from what each run left on disk, without running a model. Prints the runs whose verdict changed and why, rewrites
// their results (the old verdict kept in each one's history) and the report.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitState } from "./provenance.ts";
import { regradeDir } from "./regrading.ts";
import { renderReport } from "./render.ts";
import { readMeta, readRegrades, readRuns, resultsDir } from "./storage.ts";
import { suite, worldHash } from "./suite.ts";

const stop = (...lines: string[]): never => { console.error(lines.join("\n")); process.exit(2); };
const attempt = <T>(f: () => T): T => { try { return f(); } catch (e) { return stop((e as Error).message); } };

const [flag, label, ...rest] = process.argv.slice(2);
if (flag !== "--label" || !label || !/^[A-Za-z0-9._-]+$/.test(label) || label.startsWith(".") || rest.length) stop("usage: bun run regrade -- --label <name>");
const root = resultsDir(label!);
const meta = attempt(() => readMeta(root)) ?? stop(`no benchmark in ${root}`);
if (meta.options.prompt) stop(`${root} ran an ad-hoc prompt: there is nothing to grade`);

if (worldHash(suite.createWorld(meta.today)) !== meta.world.sha256) {
  console.warn("note: the suite now builds a different world for this day; the runs are graded against the one they started from (world-before.json).");
}
const { pass, changes, skipped } = regradeDir(root, suite.tasks, { at: new Date().toISOString(), ...gitState() });

console.log(`${root}: ${pass.runs} runs regraded at commit ${pass.commit.slice(0, 10)}${pass.dirty ? " (uncommitted changes)" : ""}; ${changes.length} verdicts changed, ${changes.filter((c) => c.from !== c.run.status).length} of them in status.`);
for (const c of changes) {
  console.log(`- ${c.run.task} / ${c.run.arm} #${c.run.rep}: ${c.from} -> ${c.run.status}`);
  for (const why of c.why) console.log(`    ${why}`);
}
for (const s of skipped) console.log(`- skipped ${s}`);

writeFileSync(join(root, "report.md"), renderReport(meta, readRuns(root), readRegrades(root)));
console.log(`report: ${join(root, "report.md")}`);
