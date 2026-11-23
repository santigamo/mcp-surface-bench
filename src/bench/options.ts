// The command line of `bun run bench`. Pure: the same arguments always give the same options or the same error.
import { ARM_SYNTAX, parseArms } from "./arms.ts";
import type { Arm } from "./types.ts";

export type Options = {
  /** In the order given: the order of every table of the report. */
  arms: Arm[];
  client: string;
  model: string | null;
  /** Reasoning effort; null: the client's default (nothing is passed). The client checks the level. */
  effort: string | null;
  /** Task ids, or every task of the suite. */
  tasks: string[] | "all";
  n: number;
  label: string;
  timeoutSeconds: number;
  /** Null: drawn at random, or the one a resumed benchmark recorded. */
  seed: number | null;
  prompt: string | null;
};

export const USAGE = `bun run bench -- [options]
  --arms a,b,c           arms to compare, each ${ARM_SYNTAX} (default: every surface, no tool search)
                         e.g. direct,direct+search,code: all tools upfront, tools deferred by the client, code mode
  --surfaces a,b         the same as --arms with plain surfaces
  --client <name>        agent CLI (default: claude)
  --model <id>           model (default: the client's own)
  --effort <level>       reasoning effort, as the client names it (default: the client's own; nothing is passed)
  --tasks all|<id>,<id>  tasks to run (default: all)
  --n <reps>             repetitions per task and arm (default: 1)
  --label <name>         results/<label>/ (default: a timestamp); the same label resumes
  --timeout <seconds>    per run (default: 600)
  --seed <n>             order of the arms in each block (default: random, recorded)
  --prompt "<text>"      run one ungraded prompt on each arm instead of the tasks`;

const FLAGS = ["arms", "surfaces", "client", "model", "effort", "tasks", "n", "label", "timeout", "seed", "prompt"] as const;

export function parseOptions(argv: string[], known: { surfaces: string[]; clients: string[] }, now = new Date()): Options {
  const given = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!.replace(/^--/, "");
    if (name === "tool-search") throw new Error(`--tool-search is now set per arm: --arms direct+search (on), direct+search=auto, direct (off)\n\n${USAGE}`);
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

  if (given.has("arms") && given.has("surfaces")) throw new Error("--surfaces is the simple case of --arms; pass one or the other");
  const plain = given.get("surfaces");
  if (plain !== undefined && plain.includes("+")) throw new Error("--surfaces takes plain surfaces; an arm with options goes in --arms");
  const arms = parseArms(given.get("arms") ?? plain ?? known.surfaces.join(","), known.surfaces);

  const client = given.get("client") ?? "claude";
  if (!known.clients.includes(client)) throw new Error(`--client must be one of: ${known.clients.join(", ")}`);

  const label = given.get("label") ?? stamp(now);
  if (!/^[A-Za-z0-9._-]+$/.test(label) || label.startsWith(".")) throw new Error("--label may hold letters, digits, dots, dashes and underscores, and not start with a dot");

  const effort = given.get("effort")?.trim() || null;
  if (effort !== null && !/^[a-z]+$/.test(effort)) throw new Error("--effort takes a level such as medium");

  const tasks = given.get("tasks") ?? "all";
  if (given.has("prompt") && given.has("tasks")) throw new Error("--prompt replaces the tasks; pass one or the other");

  return {
    arms, client, label,
    model: given.get("model") ?? null,
    effort,
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
