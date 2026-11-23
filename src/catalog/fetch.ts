// Downloads a vendor's MCP documentation into vendor/ (never committed) and builds the tool catalog from it.
//   bun run catalog -- --docs https://docs.example.com
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCatalog } from "./index.ts";

const VENDOR = resolve(import.meta.dir, "../../vendor");
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const docs = (arg("docs") ?? process.env.BENCH_DOCS)?.replace(/\/$/, "");
if (!docs) throw new Error("pass --docs <documentation base URL> or set BENCH_DOCS");

async function get(path: string): Promise<string> {
  const res = await fetch(`${docs}${path}`, { headers: { "user-agent": "mcp-surface-bench" } });
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.text();
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}

const index = await get("/llms.txt");
const toolPaths = [...new Set([...index.matchAll(/\/mcp\/tools\/[a-z0-9-]+\.md/g)].map((m) => m[0]))].sort();
const sections = [...new Set([...(await get("/mcp.md")).matchAll(/\]\(\/mcp\/([a-z-]+)\)/g)].map((m) => m[1]!))];

mkdirSync(join(VENDOR, "tools"), { recursive: true });
mkdirSync(join(VENDOR, "pages"), { recursive: true });
await pool(toolPaths, 4, async (p) => writeFileSync(join(VENDOR, "tools", p.split("/").pop()!), await get(p)));
await pool(sections, 4, async (s) => writeFileSync(join(VENDOR, "pages", `${s}.md`), await get(`/mcp/${s}.md`)));
writeFileSync(join(VENDOR, "source.json"), JSON.stringify({ docs, fetchedAt: new Date().toISOString(), tools: toolPaths.length }, null, 2));

const catalog = buildCatalog(VENDOR);
console.log(`${catalog.tools.length} tools (${catalog.tools.filter((t) => t.kind === "read").length} read, ${catalog.tools.filter((t) => t.kind === "write").length} write), prefix "${catalog.prefix}", from ${docs}`);
