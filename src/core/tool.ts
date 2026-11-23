/** A failure the model should see and can react to, as the real server would report it. */
export class ToolError extends Error {}

export type Ctx<W> = {
  world: W;
  /** The instant the call is made. Fixed per run so results do not drift while a run is in flight. */
  now: Date;
};

export type Handler<W> = {
  /** Tool name without the vendor prefix: `search-products`. */
  name: string;
  /**
   * The tool's own top-level inputs this handler honours. A call that uses any other documented input is refused
   * with a clear message instead of being answered as if the input were not there.
   */
  supports: readonly string[];
  run(args: any, ctx: Ctx<W>): unknown;
};

export const defineTool = <W>(handler: Handler<W>): Handler<W> => handler;

/** One named requirement of a task. A run passes when every check passes. */
export type Check = { name: string; pass: boolean; detail?: string };

export type Task<W> = {
  id: string;
  /** The user's request, word for word. */
  prompt: string;
  /** Where the prompt comes from. */
  source: string;
  /** A read task must leave the world untouched; a write task must change exactly what it was asked to. */
  kind: "read" | "write";
  grade(run: { answer: string; before: W; after: W }): Check[];
};

export type Suite<W> = {
  name: string;
  /** Builds the world as of `today` (YYYY-MM-DD). Deterministic: same day, same world. Plain JSON data only. */
  createWorld(today: string): W;
  /** The instant "now" of a run on `today`. */
  clock(today: string): Date;
  handlers: Handler<W>[];
  tasks: Task<W>[];
};
