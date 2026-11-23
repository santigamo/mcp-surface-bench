// Who is signed in, and the company's users.
import { closeness, inList, normalizeIds, page, ranked, sorted, type SortBy } from "../../../src/core/kit.ts";
import { defineTool } from "../../../src/core/tool.ts";
import { fullName, PREFIX, type World } from "../world.ts";
import { serial, userProfile } from "./shared.ts";

export const tools = [
  defineTool<World>({
    name: "get-me",
    supports: ["includePermissions"],
    run(args: { includePermissions?: boolean }, { world: w }) {
      const me = w.users.find((u) => u.id === w.me)!;
      return {
        user: { id: me.id, fullName: fullName(me), email: me.email, isAdmin: true, ...(args.includePermissions ? { permissions: [] } : {}) },
        myCompany: { id: w.company.id, name: w.company.name, legalBusinessName: w.company.legalName },
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
      const users = w.users.filter((u) => inList(ids, u.id));
      // Users carry no timestamps and none has changed since it was added, so the order they were added stands in for both.
      const ordered = args.search
        ? ranked(users, (u) => closeness(args.search!, [u.email], [fullName(u)]))
        : sorted(users, args.sortBy, { FULL_NAME: fullName, INSERTED_AT: (u) => serial(u.id), UPDATED_AT: (u) => serial(u.id) }, { field: "UPDATED_AT", direction: "DESC" });
      return page(ordered, args, (u) => ({ id: u.id, email: u.email, profile: userProfile(u) }));
    },
  }),
];
