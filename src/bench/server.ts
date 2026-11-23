// How a surface is started, and what its tool listing weighs.
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Listing } from "./types.ts";

/** The MCP server's name in every client's configuration: tools reach the model as `mcp__erp__…` (or `mcp__erp.…`). */
export const SERVER_NAME = "erp";

const SERVE = resolve(import.meta.dir, "../surfaces/serve.ts");

export type ServerSpec = { name: string; command: string; args: string[]; env: Record<string, string> };

/**
 * `today` is the world's day and `timezone` the suite's: the server runs in it (TZ), like the client, so that code
 * the model runs on the code surface reads local dates where the company is. `runDir` undefined: the server keeps no
 * trace and no world, which is all a listing needs.
 */
export function serverSpec(surface: string, today: string, timezone: string, runDir?: string): ServerSpec {
  return {
    name: SERVER_NAME,
    // The runner runs under Bun, so this is the absolute path of the same Bun.
    command: process.execPath,
    args: [SERVE],
    env: { BENCH_SURFACE: surface, BENCH_TODAY: today, TZ: timezone, ...(runDir ? { BENCH_RUN_DIR: runDir } : {}) },
  };
}

/** Starts the server once over stdio, lists its tools and closes it. Throws when the surface does not start. */
export async function listTools(spec: ServerSpec): Promise<Listing & { names: string[] }> {
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...getDefaultEnvironment(), ...spec.env }, stderr: "pipe" });
  const client = new Client({ name: "bench-probe", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const bytes = Buffer.byteLength(JSON.stringify(listed.tools));
    return { tools: listed.tools.length, bytes, approxTokens: Math.round(bytes / 4), names: listed.tools.map((t) => t.name) };
  } finally {
    await client.close();
  }
}
