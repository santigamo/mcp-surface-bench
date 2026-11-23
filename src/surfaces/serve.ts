// Starts one surface of one suite as an MCP server over stdio. The benchmark runner spawns it once per run.
//   BENCH_SURFACE=direct|code  BENCH_TODAY=YYYY-MM-DD  BENCH_RUN_DIR=<dir for trace.jsonl and world.json>
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCatalog } from "../catalog/index.ts";
import { Runtime } from "../core/runtime.ts";
import { erp } from "../../suites/erp/index.ts";
import { SURFACES, type SurfaceName } from "./index.ts";

const surface = process.env.BENCH_SURFACE as SurfaceName;
const today = process.env.BENCH_TODAY;
const runDir = process.env.BENCH_RUN_DIR;
if (!(surface in SURFACES)) throw new Error(`BENCH_SURFACE must be one of: ${Object.keys(SURFACES).join(", ")}`);
if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("BENCH_TODAY must be YYYY-MM-DD");

const catalog = loadCatalog();
const runtime = new Runtime({
  catalog, handlers: erp.handlers, world: erp.createWorld(today), now: erp.clock(today), surface,
  ...(runDir ? { tracePath: join(runDir, "trace.jsonl"), statePath: join(runDir, "world.json") } : {}),
});
await SURFACES[surface](catalog, runtime).connect(new StdioServerTransport());
