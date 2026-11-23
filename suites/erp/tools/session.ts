// Who is signed in, and the company's users.
import { matches, normalizeIds, page, sorted, type SortBy } from "../../../src/core/kit.ts";
import { defineTool } from "../../../src/core/tool.ts";
import { fullName, PREFIX, type World } from "../world.ts";
import { userProfile } from "./shared.ts";

export const tools = [
  defineTool<World>({
    name: "get-me",
    supports: ["includePermissions"],
    run(args: { includePermissions?: boolean }, { world: w }) {
      const me = w.users.find((u) => u.id === w.me)!;
      return {
        user: { id: me.id, fullName: fullName(me), email: me.email, isAdmin: true, ...(args.includePermissions ? { permissions: [] } : {}) },
        myCompany: { id: w.company.id, name: w.company.name, legalBusinessName: `${w.company.name.replace(/ Co\.$/, "")} Company, Inc.` },
        timezone: w.timezone,
        usState: w.company.state,
        complianceType: w.company.complianceSystem,
        // The modules the benchmark company uses; the documentation lists more.
        activeModules: ["CORE", "CULTIVATION"],
        settings: { inventory: { allowNegativeAvailableQuantity: false, binTrackingEnabled: false }, sales: { salesOrderAutofulfill: false } },
      };
    },
  }),

  defineTool<World>({
    name: "search-users",
    supports: ["limit", "cursor", "ids", "search", "sortBy"],
    run(args: { limit?: number; cursor?: string; ids?: string[]; search?: string; sortBy?: SortBy }, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.user);
      let users = w.users.filter((u) => (!ids || ids.includes(u.id)) && matches(args.search, fullName(u), u.email));
      // With `search` the documentation ranks by closeness; a substring match in stored order is the closest this world gets.
      if (!args.search) users = sorted(users, args.sortBy, { FULL_NAME: fullName, INSERTED_AT: (u) => +u.id.split("_")[1]!, UPDATED_AT: (u) => +u.id.split("_")[1]! }, { field: "FULL_NAME", direction: "ASC" });
      return page(users, args, (u) => ({ id: u.id, email: u.email, profile: userProfile(u) }));
    },
  }),
];
