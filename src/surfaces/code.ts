import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Catalog } from "../catalog/index.ts";
import type { Runtime } from "../core/runtime.ts";
import { buildApi, declaration, searchApi } from "./code/api.ts";
import { execute } from "./code/sandbox.ts";

/** Longest result sent back to the model. Past it the model is told to return less, which is the point of writing code. */
const MAX_RESULT = 25_000;

/**
 * The same tools behind two: `search` finds functions and shows their signatures, `execute` runs code that calls
 * them. The tool list the model carries stays the same size however many tools the server has.
 */
export function codeSurface<W>(catalog: Catalog, runtime: Runtime<W>): Server {
  const vendor = catalog.prefix.replace(/-$/, "");
  const product = vendor.charAt(0).toUpperCase() + vendor.slice(1);
  const api = buildApi(catalog);
  const byName = new Map(api.map((f) => [f.fn, f]));

  const bound: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const f of api) {
    bound[f.fn] = async (args) => {
      const result = runtime.call(f.short, args ?? {});
      if (!result.ok) throw new Error(result.error);
      return structuredClone(result.value);
    };
  }

  const tools = [
    {
      name: `${vendor}-search`,
      description:
        `Finds functions of the ${product} API (${api.length} in all). Pass \`query\` in plain words to get the best matches with a one-line summary each. ` +
        `Pass \`names\` to get the full signature of specific functions: what each does, every argument with its documentation, and the shape of the result. ` +
        `Read a function's signature before calling it from ${vendor}-execute.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What you are looking for, in plain words: \"overdue invoices\", \"move stock between locations\"." },
          names: { type: "array", items: { type: "string" }, description: "Function names to describe in full, as search returned them." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Matches to return for a query. Default 8." },
        },
        additionalProperties: false,
      },
    },
    {
      name: `${vendor}-execute`,
      description:
        `Runs JavaScript against the ${product} API and returns what the code returns. The code is the body of an async function: ` +
        `\`await api.<function>(args)\` resolves to the documented result and throws an Error carrying the server's message when the call fails. ` +
        `Chain calls, follow \`nextCursor\` to read every page, filter and total in code, and \`return\` only what answers the request, as plain JSON data. ` +
        `\`console.log\` output comes back too. Functions that write data change the account for real.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          code: { type: "string", description: "Body of an async function. `api` is in scope. End with `return`." },
          intent: { type: "string", description: "The user's end goal in one sentence, not this call's." },
        },
        required: ["code", "intent"],
        additionalProperties: false,
      },
    },
  ];

  const server = new Server({ name: `${vendor}-code`, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as { query?: string; names?: string[]; limit?: number; code?: string };
    const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) });

    if (req.params.name === `${vendor}-search`) {
      const parts: string[] = [];
      if (args.names?.length) {
        for (const name of args.names) {
          const f = byName.get(name.replace(/^api\./, ""));
          parts.push(f ? declaration(f) : `// no function named ${name}`);
        }
      }
      if (args.query) {
        const hits = searchApi(api, args.query, args.limit ?? 8);
        parts.push(hits.length ? hits.map((f) => `api.${f.fn} (${f.spec.kind}): ${f.summary}`).join("\n") : `No function matches "${args.query}". Try other words.`);
      }
      return parts.length ? reply(parts.join("\n\n")) : reply("Pass `query` or `names`.", true);
    }

    if (req.params.name === `${vendor}-execute`) {
      if (typeof args.code !== "string" || !args.code.trim()) return reply("Pass the code to run in `code`.", true);
      const run = await execute(args.code, bound);
      const logs = run.logs.length ? `\n\nconsole:\n${run.logs.join("\n")}` : "";
      if (!run.ok) return reply(`${run.error}${logs}`.slice(0, MAX_RESULT), true);
      if (run.value === undefined) return reply(`The code returned nothing. End it with \`return\` to get a value back.${logs}`.slice(0, MAX_RESULT));
      const out = JSON.stringify(run.value, null, 1) + logs;
      return reply(out.length <= MAX_RESULT ? out : `${out.slice(0, MAX_RESULT)}\n\n[cut at ${MAX_RESULT} of ${out.length} characters: return less, by filtering or totalling in the code]`);
    }

    return reply(`Unknown tool: ${req.params.name}`, true);
  });

  return server;
}
