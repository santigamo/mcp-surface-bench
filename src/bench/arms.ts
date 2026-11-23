// The arms of a benchmark: `<surface>[+<modifier>...]`, where a modifier sets one client option for that arm and an
// option no modifier sets keeps its default. Pure.
//   direct               every tool upfront (tool search off)
//   direct+search        the client defers the tool definitions behind its own search (tool search on)
//   direct+search=auto   the client decides by the size of the definitions (tool search auto)
import type { Arm, ToolSearch } from "./types.ts";

/** Each modifier, and what it sets. A new client option is a new entry here and a field on `Arm`. */
const MODIFIERS: Record<string, { toolSearch: ToolSearch }> = {
  search: { toolSearch: "on" },
  "search=auto": { toolSearch: "auto" },
};

export const ARM_SYNTAX = `<surface>[+search|+search=auto]`;

export function parseArm(text: string, surfaces: readonly string[]): Arm {
  const [surface = "", ...mods] = text.split("+");
  if (!surfaces.includes(surface)) throw new Error(`arm "${text}": "${surface}" is not a surface; known: ${surfaces.join(", ")}`);
  const arm: Arm = { name: text, surface, toolSearch: "off" };
  const seen = new Set<string>();
  for (const mod of mods) {
    const set = MODIFIERS[mod];
    if (!set) throw new Error(`arm "${text}": unknown modifier "+${mod}"; known: ${Object.keys(MODIFIERS).map((m) => `+${m}`).join(", ")}`);
    const option = Object.keys(set)[0]!;
    if (seen.has(option)) throw new Error(`arm "${text}" sets ${option === "toolSearch" ? "tool search" : option} twice`);
    seen.add(option);
    Object.assign(arm, set);
  }
  return arm;
}

/** A comma-separated list of arms, each once. Two spellings of the same arm are refused as well. */
export function parseArms(list: string, surfaces: readonly string[]): Arm[] {
  const names = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error(`--arms needs at least one arm: ${ARM_SYNTAX}, comma-separated`);
  const arms = names.map((n) => parseArm(n, surfaces));
  const byMeaning = new Map<string, string>();
  for (const a of arms) {
    const key = `${a.surface}\u0000${a.toolSearch}`;
    const other = byMeaning.get(key);
    if (other !== undefined) throw new Error(other === a.name ? `--arms names "${a.name}" twice` : `"${other}" and "${a.name}" are the same arm`);
    byMeaning.set(key, a.name);
  }
  return arms;
}
