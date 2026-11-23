// `bun run report -- --label <name>`: the report of a benchmark, printed and written to results/<label>/report.md.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "./render.ts";
import { readMeta, readRuns, resultsDir } from "./storage.ts";

const [flag, label, ...rest] = process.argv.slice(2);
if (flag !== "--label" || !label || !/^[A-Za-z0-9._-]+$/.test(label) || rest.length) { console.error("usage: bun run report -- --label <name>"); process.exit(2); }
const root = resultsDir(label);
const meta = readMeta(root);
if (!meta) { console.error(`no benchmark in ${root}`); process.exit(2); }
const report = renderReport(meta, readRuns(root));
writeFileSync(join(root, "report.md"), report);
console.log(report);
