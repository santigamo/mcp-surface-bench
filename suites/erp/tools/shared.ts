// Pieces several tool files need: how a user is rendered, lookups by id, and how a write is logged.
import { isoIn } from "../../../src/core/kit.ts";
import { ToolError, type Ctx } from "../../../src/core/tool.ts";
import { PREFIX, fullName, newId, type Action, type Id, type User, type World } from "../world.ts";

export type C = Ctx<World>;

/** A user as most tools embed one: `{ id, profile: { fullName } }`. */
export const userRef = (w: World, id: Id | null) => {
  const u = id ? w.users.find((x) => x.id === id) : undefined;
  return u ? { id: u.id, profile: { fullName: fullName(u) } } : null;
};

export const userProfile = (u: User) => ({ fullName: fullName(u), firstName: u.firstName, lastName: u.lastName, initials: `${u.firstName[0]}${u.lastName[0]}` });

/** `{ id, name }` of a record in a collection, or null. */
export const named = <T extends { id: Id; name: string }>(items: T[], id: Id | null) => {
  const x = id ? items.find((i) => i.id === id) : undefined;
  return x ? { id: x.id, name: x.name } : null;
};

/** Finds a record or raises the error a wrong id gets. `what` names the record for the message: "product". */
export function find<T extends { id: Id }>(items: T[], id: Id, what: string): T {
  const x = items.find((i) => i.id === id);
  if (!x) throw new ToolError(`No ${what} found with id ${id}.`);
  return x;
}

/** The instant of the call as the tools print instants: ISO 8601 with the company's UTC offset. */
export const stamp = (c: C) => isoIn(c.world.timezone, c.now);

/** Logs what a write tool changed, as the signed-in user acting through MCP. Every write tool calls it once. */
export function recordAction(c: C, records: Action["records"]): void {
  const me = c.world.users.find((u) => u.id === c.world.me)!;
  c.world.actions.push({ id: newId(c.world, PREFIX.action), changedAt: stamp(c), actorId: me.id, actorName: fullName(me), source: "MCP", sourceDetail: null, records });
}
