import { expect, test } from "bun:test";
import { bench } from "./helpers.ts";

test("get-me returns the signed-in user and the company setup", () => {
  const { call } = bench();
  const me = call("get-me");
  expect(me.user.fullName).toBe("Maya Okafor");
  expect(me.timezone).toBe("America/Los_Angeles");
  expect(me.user.permissions).toBeUndefined();
  expect(call("get-me", { includePermissions: true }).user.permissions).toEqual([]);
});

test("search-users pages, filters and sorts", () => {
  const { call, error } = bench();
  expect(call("search-users").totalCount).toBe(5);
  expect(call("search-users", { search: "reyes" }).items.map((u: any) => u.profile.fullName)).toEqual(["Daniel Reyes"]);
  expect(call("search-users", { ids: ["usr_3", "4"] }).items.map((u: any) => u.id).sort()).toEqual(["usr_3", "usr_4"]);
  const first = call("search-users", { limit: 2 });
  expect(first.hasMore).toBe(true);
  expect(call("search-users", { limit: 2, cursor: first.nextCursor }).items).toHaveLength(2);
  expect(error("search-users", { ids: ["com_3"] })).toContain("tool_error");
  expect(error("search-users", { ownerAssignableEntityType: "ORDER" })).toContain("unsupported_input");
  expect(error("search-users", { nope: 1 })).toContain("invalid_arguments");
});

test("search-users ranks substring matches first, then names within a typo", () => {
  const { call } = bench();
  const names = (search: string) => call("search-users", { search }).items.map((u: any) => u.profile.fullName);
  expect(names("maya okafr")).toEqual(["Maya Okafor"]);
  expect(names("tidewatercannabis")).toHaveLength(5);
  expect(names("priya@")).toEqual(["Priya Nair"]);
  // Without search, the default order is the documented UPDATED_AT DESC: the latest user added first.
  expect(call("search-users").items[0].profile.fullName).toBe("Lena Hartmann");
});
