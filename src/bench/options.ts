// The command line of `bun run bench`. Pure: the same arguments always give the same options or the same error.
import type { ToolSearch } from "./types.ts";

export type Options = {
  surfaces: string[];
  client: string;
  model: string | null;
  /** Task ids, or every task of the suite. */
  tasks: string[] | "all";
  n: number;
  label: string;
  timeoutSeconds: number;
  /** Null: drawn at random, or the one a resumed benchmark recorded. */
  seed: number | null;
  toolSearch: ToolSearch;
  prompt: string | null;
};

export const USAGE = `bun run bench -- [options]
  --surfaces a,b         surfaces to compare (default: all)
  --client <name>        agent CLI (default: claude)
  --model <id>           model (default: the client's own)
  --tasks all|<id>,<id>  tasks to run (default: all)
  --n <reps>             repetitions per task and surface (default: 1)
  --label <name>         results/<label>/ (default: a timestamp); the same label resumes
  --timeout <seconds>    per run (default: 600)
  --seed <n>             order of the surfaces in each block (default: random, recorded)
  --tool-search on|off|auto  whether the client defers MCP tool definitions behind its own search (default: off)
  --prompt "<text>"      run one ungraded prompt on each surface instead of the tasks`;

const FLAGS = ["surfaces", "client", "model", "tasks", "n", "label", "timeout", "seed", "tool-search", "prompt"] as const;

export function parseOptions(argv: string[], known: { surfaces: string[]; clients: string[] }, now = new Date()): Options {
  const given = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!.replace(/^--/, "");
    if (!argv[i]!.startsWith("--") || !(FLAGS as readonly string[]).includes(name)) throw new Error(`unknown argument ${argv[i]}\n\n${USAGE}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    given.set(name, value);
  }

  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const int = (name: string, min: number) => {
    const v = given.get(name);
    if (v === undefined) return undefined;
    if (!/^-?\d+$/.test(v) || Number(v) < min) throw new Error(`--${name} must be an integer of at least ${min}`);
    return Number(v);
  };

  const surfaces = given.has("surfaces") ? list(given.get("surfaces")!) : known.surfaces;
  const unknown = surfaces.filter((s) => !known.surfaces.includes(s));
  if (unknown.length || !surfaces.length) throw new Error(`--surfaces must name some of: ${known.surfaces.join(", ")}`);
  if (new Set(surfaces).size !== surfaces.length) throw new Error("--surfaces names a surface twice");

  const client = given.get("client") ?? "claude";
  if (!known.clients.includes(client)) throw new Error(`--client must be one of: ${known.clients.join(", ")}`);

  const toolSearch = (given.get("tool-search") ?? "off") as ToolSearch;
  if (!["on", "off", "auto"].includes(toolSearch)) throw new Error("--tool-search must be on, off or auto");

  const label = given.get("label") ?? stamp(now);
  if (!/^[A-Za-z0-9._-]+$/.test(label) || label.startsWith(".")) throw new Error("--label may hold letters, digits, dots, dashes and underscores, and not start with a dot");

  const tasks = given.get("tasks") ?? "all";
  if (given.has("prompt") && given.has("tasks")) throw new Error("--prompt replaces the tasks; pass one or the other");

  return {
    surfaces, client, toolSearch, label,
    model: given.get("model") ?? null,
    tasks: tasks === "all" ? "all" : list(tasks),
    n: int("n", 1) ?? 1,
    timeoutSeconds: int("timeout", 1) ?? 600,
    seed: int("seed", 0) ?? null,
    prompt: given.get("prompt")?.trim() || null,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time, sortable: 2026-11-23-101500. */
export const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
/** The machine's local date: YYYY-MM-DD. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
