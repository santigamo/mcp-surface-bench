// Runs one client process: stdout is written to disk as it arrives and parsed as JSON lines, the clock is enforced.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export type Finished = { events: unknown[]; stderr: string; wallSeconds: number; timedOut: boolean; exitCode: number | null };

export async function runProcess(o: { argv: string[]; env: Record<string, string>; cwd: string; timeoutSeconds: number; stdoutPath: string; stderrPath: string }): Promise<Finished> {
  const [bin, ...args] = o.argv;
  const started = performance.now();
  // Its own process group, so a timeout kills the client and the MCP server it started together.
  const child = spawn(bin!, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const out = createWriteStream(o.stdoutPath), err = createWriteStream(o.stderrPath);
  const events: unknown[] = [];
  let pending = "", stderr = "", timedOut = false;

  child.stdout.on("data", (chunk: Buffer) => {
    out.write(chunk);
    pending += chunk.toString("utf8");
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.startsWith("{")) try { events.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { err.write(chunk); stderr += chunk.toString("utf8"); });

  const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch {} };
  const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 5000).unref(); }, o.timeoutSeconds * 1000);

  const exitCode = await new Promise<number | null>((done) => {
    child.on("error", (e) => { stderr += String(e); done(null); });
    child.on("close", (code) => done(code));
  });
  clearTimeout(timer);
  // The client is gone; anything it left running in its group goes too.
  killGroup("SIGKILL");
  if (pending.trim().startsWith("{")) try { events.push(JSON.parse(pending)); } catch {}
  await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
  return { events, stderr, wallSeconds: (performance.now() - started) / 1000, timedOut, exitCode };
}
