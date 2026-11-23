import vm from "node:vm";

export type Execution = { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[] };

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Runs model-written code as the body of an async function with `api` in scope.
 *
 * The context holds nothing but `api` and `console`: no network, no file system, no process. That is enough for
 * a benchmark that runs on the author's machine. It is not a security boundary: a production server needs real
 * isolation (V8 isolates or a separate process) and per-call authorization, which `node:vm` does not give.
 */
export async function execute(code: string, api: Record<string, (args: unknown) => Promise<unknown>>, timeoutMs = 30_000): Promise<Execution> {
  const logs: string[] = [];
  const log = (...parts: unknown[]) => { if (logs.length < 200) logs.push(parts.map(text).join(" ")); };
  const context = vm.createContext({ api, console: { log, info: log, warn: log, error: log } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "execute.js" });
    const value = await Promise.race([
      script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
    return { ok: true, value, logs };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, logs };
  } finally {
    clearTimeout(timer);
  }
}
