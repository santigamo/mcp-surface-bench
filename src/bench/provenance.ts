// What ran: the code's commit and the runtime, for meta.json.
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");

export function gitState(): { commit: string; dirty: boolean } {
  const head = Bun.spawnSync(["git", "-C", REPO, "rev-parse", "HEAD"]);
  if (head.exitCode !== 0) return { commit: "unknown", dirty: false };
  const status = Bun.spawnSync(["git", "-C", REPO, "status", "--porcelain"]);
  return { commit: head.stdout.toString().trim(), dirty: status.stdout.toString().trim().length > 0 };
}

export const runtime = () => ({ bun: Bun.version, platform: `${process.platform}-${process.arch}` });
