import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadCatalog } from "../src/catalog/index.ts";
import { Runtime } from "../src/core/runtime.ts";
import { SURFACES, type SurfaceName } from "../src/surfaces/index.ts";
import { erp } from "../suites/erp/index.ts";
import { TODAY } from "./helpers.ts";

async function connect(surface: SurfaceName) {
  const catalog = loadCatalog();
  const runtime = new Runtime({ catalog, handlers: erp.handlers, world: erp.createWorld(TODAY), now: erp.clock(TODAY), surface });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await SURFACES[surface](catalog, runtime).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const text = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { catalog, client, text };
}

test("direct: lists every tool and answers a call as JSON", async () => {
  const { catalog, client, text } = await connect("direct");
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(catalog.tools.map((t) => t.name).sort());
  const me = await text(`${catalog.prefix}get-me`, { intent: "check the setup", userSatisfactionEstimate: 5 });
  expect(JSON.parse(me.text).user.fullName).toBe("Maya Okafor");
  const bad = await text(`${catalog.prefix}search-users`, { limit: "ten" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("limit must be integer");
});

test("code: two tools, whatever the size of the catalog", async () => {
  const { catalog, client, text } = await connect("code");
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual([`${catalog.prefix}search`, `${catalog.prefix}execute`]);

  const found = await text(`${catalog.prefix}search`, { query: "users of the company" });
  expect(found.text).toContain("api.searchUsers (read)");
  const sig = await text(`${catalog.prefix}search`, { names: ["searchUsers"] });
  expect(sig.text).toContain("api.searchUsers(args: {");
  expect(sig.text).not.toContain(catalog.prefix); // tool mentions are rewritten to function names

  const run = await text(`${catalog.prefix}execute`, { intent: "count users", code: "const r = await api.searchUsers({ limit: 2 }); console.log('page', r.items.length); return { total: r.totalCount, first: r.items[0].profile.fullName };" });
  expect(run.text).toContain('"total": 5');
  expect(run.text).toContain("page 2");

  const thrown = await text(`${catalog.prefix}execute`, { intent: "x", code: "await api.searchUsers({ limit: 500 });" });
  expect(thrown.isError).toBe(true);
  expect(thrown.text).toContain("limit must be between 1 and 100");

  const sealed = await text(`${catalog.prefix}execute`, { intent: "x", code: "return typeof process + typeof require + typeof fetch + typeof Bun;" });
  expect(sealed.text).toContain("undefinedundefinedundefinedundefined");
});
