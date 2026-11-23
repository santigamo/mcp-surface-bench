import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { shortName, type Catalog } from "../catalog/index.ts";
import type { Runtime } from "../core/runtime.ts";

/** The surface the vendor ships: every tool registered by name, description and input schema. */
export function directSurface<W>(catalog: Catalog, runtime: Runtime<W>): Server {
  const server = new Server({ name: `${catalog.prefix.replace(/-$/, "")}-direct`, version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: "object" } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = runtime.call(shortName(catalog, req.params.name), req.params.arguments ?? {});
    return result.ok
      ? { content: [{ type: "text", text: JSON.stringify(result.value) }] }
      : { content: [{ type: "text", text: result.error }], isError: true };
  });

  return server;
}
