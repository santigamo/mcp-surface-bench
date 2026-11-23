import { expect, test } from "bun:test";
import { addDays } from "../src/core/kit.ts";
import { lastMonth } from "../suites/erp/seed.ts";
import { bench, TODAY } from "./helpers.ts";

const names = (r: { items: { name: string }[] }) => r.items.map((x) => x.name);
const tally = (items: { plantGroup: { name: string } }[]) => {
  const n: Record<string, number> = {};
  for (const p of items) n[p.plantGroup.name] = (n[p.plantGroup.name] ?? 0) + 1;
  return n;
};

test("search-plants answers which plants are in veg, with group, label and strain, across pages", () => {
  const { call } = bench();
  expect(call("search-plants").totalCount).toBe(35);
  const first = call("search-plants", { statuses: ["VEGETATIVE"] });
  expect(first.totalCount).toBe(12);
  expect(first.items).toHaveLength(10);
  expect(first.hasMore).toBe(true);
  const rest = call("search-plants", { statuses: ["VEGETATIVE"], cursor: first.nextCursor });
  expect(rest.items).toHaveLength(2);
  expect(rest.hasMore).toBe(false);
  const all = [...first.items, ...rest.items];
  expect(new Set(all.map((p: any) => p.id)).size).toBe(12);
  expect(tally(all)).toEqual({ "Gelato Run 14": 7, "Sour Diesel Run 9": 5 });
  for (const p of all) {
    expect(p.status).toBe("VEGETATIVE");
    expect(p.metrcLabel).toMatch(/^1A40603000/);
    expect(p.metrcStrainName).toBe(p.plantGroup.name.replace(/ Run \d+$/, ""));
    expect(p.location.name).toBe("Veg Room");
  }
  expect(call("search-plants", { statuses: ["FLOWERING", "IMMATURE"] }).totalCount).toBe(15);
});

test("search-plants filters by group, strain, license, location, flowering date, mother, label and id", () => {
  const { call, world } = bench();
  const gelato = world.plantGroups.find((g) => g.name === "Gelato Run 14")!;
  expect(call("search-plants", { plantGroupId: gelato.id }).totalCount).toBe(7);
  expect(call("search-plants", { plantGroupId: gelato.id.split("_")[1] }).totalCount).toBe(7);
  expect(call("search-plants", { metrcStrainNames: ["Sour Diesel", "OG Kush"] }).totalCount).toBe(11);
  expect(call("search-plants", { metrcStrainNames: ["sour diesel"] }).totalCount).toBe(0);
  expect(call("search-plants", { licenseId: "lic_2" }).totalCount).toBe(35);
  expect(call("search-plants", { licenseId: "lic_1" }).totalCount).toBe(0);
  const flowerRoom = world.locations.find((l) => l.name === "Flower Room A")!;
  expect(call("search-plants", { locationIds: [flowerRoom.id] }).totalCount).toBe(17);
  // Wedding Cake flowered 27 days ago, Blue Dream 85 days ago.
  expect(call("search-plants", { floweredAfter: addDays(TODAY, -30) }).totalCount).toBe(9);
  expect(call("search-plants", { floweredBefore: addDays(TODAY, -30), floweredAfter: "2026-01-01" }).totalCount).toBe(8);
  expect(call("search-plants", { isMother: true }).totalCount).toBe(0);
  expect(call("search-plants", { isMother: false }).totalCount).toBe(35);
  const label = world.plants[3]!.metrcLabel;
  expect(call("search-plants", { search: label.slice(-6).toLowerCase() }).items.map((p: any) => p.metrcLabel)).toEqual([label]);
  expect(call("search-plants", { ids: ["plt_1", "2"] }).items.map((p: any) => p.id).sort()).toEqual(["plt_1", "plt_2"]);
});

test("search-plants sorts most recently changed first by default, and by any documented field", () => {
  const { call } = bench();
  // The immature OG Kush plants were planted 8 days ago; nothing changed stage since.
  expect(call("search-plants", { limit: 6 }).items.every((p: any) => p.plantGroup.name === "OG Kush Run 3")).toBe(true);
  const byLabel = call("search-plants", { sortBy: { field: "LABEL", direction: "ASC" }, limit: 100 }).items.map((p: any) => p.metrcLabel);
  expect(byLabel).toEqual([...byLabel].sort());
  expect(call("search-plants", { sortBy: { field: "PLANTED_AT", direction: "ASC" } }).items[0].plantGroup.name).toBe("Blue Dream Run 31");
  expect(call("search-plants", { sortBy: { field: "INSERTED_AT", direction: "DESC" } }).items[0].id).toBe("plt_35");
});

test("search-plants refuses what it cannot answer", () => {
  const { error } = bench();
  expect(error("search-plants", { limit: 500 })).toContain("tool_error");
  expect(error("search-plants", { ids: ["prd_1"] })).toContain("tool_error");
  expect(error("search-plants", { floweredAfter: "last week" })).toContain("tool_error");
  expect(error("search-plants", { cursor: "nope" })).toContain("tool_error");
  expect(error("search-plants", { teardownId: "1" })).toContain("unsupported_input");
  expect(error("search-plants", { statuses: ["GROWING"] })).toContain("invalid_arguments");
});

test("get-plant returns one plant with its group, and null for an unknown id", () => {
  const { call, error, world } = bench();
  const p = world.plants.find((x) => x.status === "VEGETATIVE")!;
  const { plant } = call("get-plant", { id: p.id });
  expect(plant.status).toBe("VEGETATIVE");
  expect(plant.metrcLabel).toBe(p.metrcLabel);
  expect(plant.plantGroup.name).toBe(plant.metrcPlantBatchName);
  expect(plant.metrcStrain.name).toBe(plant.metrcStrainName);
  expect(plant.complianceType).toBe("METRC");
  expect(plant.teardowns).toEqual([]);
  expect(plant.bins).toBeUndefined();
  expect(call("get-plant", { id: p.id.split("_")[1], includeBins: true }).plant.bins).toEqual([]);
  expect(call("get-plant", { id: "plt_999" }).plant).toBeNull();
  expect(error("get-plant", { id: "plg_1" })).toContain("tool_error");
  expect(error("get-plant", {})).toContain("invalid_arguments");
});

test("search-plant-groups shows plant counts and reads ACTIVE as having immature plants", () => {
  const { call } = bench();
  expect(names(call("search-plant-groups"))).toEqual(["OG Kush Run 3"]);
  const all = call("search-plant-groups", { status: "ANY" });
  expect(all.totalCount).toBe(5);
  const counts = Object.fromEntries(all.items.map((g: any) => [g.name, [g.totalPlantsCount, g.immaturePlantsCount, g.isActive]]));
  expect(counts).toEqual({
    "Wedding Cake Run 22": [9, 0, false], "Gelato Run 14": [7, 0, false], "OG Kush Run 3": [6, 6, true], "Sour Diesel Run 9": [5, 0, false], "Blue Dream Run 31": [8, 0, false],
  });
  expect(call("search-plant-groups", { status: "INACTIVE" }).totalCount).toBe(4);
});

test("search-plant-groups filters, searches, sorts and pages", () => {
  const { call, error, world } = bench();
  const any = { status: "ANY" };
  const veg = world.locations.find((l) => l.name === "Veg Room")!;
  expect(names(call("search-plant-groups", { ...any, locationIds: [veg.id], sortBy: { field: "NAME", direction: "ASC" } }))).toEqual(["Gelato Run 14", "OG Kush Run 3", "Sour Diesel Run 9"]);
  expect(names(call("search-plant-groups", { ...any, metrcStrainNames: ["Gelato"] }))).toEqual(["Gelato Run 14"]);
  expect(call("search-plant-groups", { ...any, licenseIds: ["lic_2"] }).totalCount).toBe(5);
  expect(call("search-plant-groups", { ...any, ids: ["plg_1", "plg_2"] }).totalCount).toBe(2);
  expect(names(call("search-plant-groups", { ...any, search: "flower room" })).sort()).toEqual(["Blue Dream Run 31", "Wedding Cake Run 22"]);
  expect(names(call("search-plant-groups", { ...any, search: "kush" }))).toEqual(["OG Kush Run 3"]);
  expect(names(call("search-plant-groups", { ...any, sortBy: { field: "PLANTED_AT", direction: "DESC" } }))[0]).toBe("OG Kush Run 3");
  expect(names(call("search-plant-groups", { ...any, sortBy: { field: "INSERTED_AT", direction: "ASC" } }))[0]).toBe("Wedding Cake Run 22");
  const first = call("search-plant-groups", { ...any, limit: 3 });
  expect(first.hasMore).toBe(true);
  expect(call("search-plant-groups", { ...any, limit: 3, cursor: first.nextCursor }).items).toHaveLength(2);
  expect(error("search-plant-groups", { licenseIds: ["loc_1"] })).toContain("tool_error");
  expect(error("search-plant-groups", { status: "GROWING" })).toContain("invalid_arguments");
});

test("get-plant-group shows the plant counts by stage", () => {
  const { call, error, world } = bench();
  const id = (name: string) => world.plantGroups.find((g) => g.name === name)!.id;
  const gelato = call("get-plant-group", { id: id("Gelato Run 14") }).plantGroup;
  expect([gelato.totalPlantsCount, gelato.immaturePlantsCount, gelato.taggedPlantsCount, gelato.harvestedPlantsCount, gelato.destroyedPlantsCount]).toEqual([7, 0, 7, 0, 0]);
  const blueDream = call("get-plant-group", { id: id("Blue Dream Run 31") }).plantGroup;
  expect([blueDream.totalPlantsCount, blueDream.taggedPlantsCount, blueDream.harvestedPlantsCount]).toEqual([8, 0, 8]);
  const ogKush = call("get-plant-group", { id: id("OG Kush Run 3"), includeBins: true }).plantGroup;
  expect([ogKush.immaturePlantsCount, ogKush.isActive, ogKush.bins]).toEqual([6, true, []]);
  expect(gelato.metrcStrainId).toBe(world.strains.find((s) => s.name === "Gelato")!.id);
  expect(gelato.bins).toBeUndefined();
  expect(call("get-plant-group", { id: "plg_99" }).plantGroup).toBeNull();
  expect(error("get-plant-group", { id: "plt_1" })).toContain("tool_error");
});

test("search-harvests answers how much was harvested last month, by strain, in grams", () => {
  const { call } = bench();
  const lm = lastMonth(TODAY);
  const r = call("search-harvests", { harvestedAfter: lm.start, harvestedBefore: lm.end });
  expect(r.totalCount).toBe(5);
  const byStrain: Record<string, number> = {};
  for (const h of r.items) {
    expect(h.unitType.name).toBe("Gram");
    byStrain[h.metrcStrain.name] = (byStrain[h.metrcStrain.name] ?? 0) + Number(h.wetWeight);
  }
  expect(byStrain).toEqual({ "Blue Dream": 34650, Gelato: 24120, "Wedding Cake": 21600 });
  // The month before, and this month (which also has a Blue Dream harvest), stay out.
  expect(names(call("search-harvests", { harvestedBefore: addDays(lm.start, -1) }))).toEqual(["Sour Diesel Harvest 8"]);
  expect(names(call("search-harvests", { harvestedAfter: addDays(lm.end, 1) })).sort()).toEqual(["Blue Dream Harvest 32", "OG Kush Harvest 2"]);
  expect(call("search-harvests").totalCount).toBe(8);
});

test("search-harvests filters by strain, status, finished date, name, location, license and id", () => {
  const { call, error, world } = bench();
  expect(names(call("search-harvests", { metrcStrainNames: ["Gelato"], sortBy: { field: "NAME", direction: "ASC" } }))).toEqual(["Gelato Harvest 12", "Gelato Harvest 13"]);
  expect(names(call("search-harvests", { distruStatus: "DRYING" })).sort()).toEqual(["Blue Dream Harvest 32", "OG Kush Harvest 2"]);
  expect(call("search-harvests", { distruStatus: "PACKAGING" }).totalCount).toBe(0);
  // Finished harvests finish 14 days after they are harvested; drying ones have no finished date.
  const lm = lastMonth(TODAY);
  expect(names(call("search-harvests", { finishedAfter: lm.start, finishedBefore: lm.end })).sort()).toEqual(["Blue Dream Harvest 30", "Blue Dream Harvest 31", "Gelato Harvest 12", "Sour Diesel Harvest 8"]);
  expect(call("search-harvests", { finishedAfter: "2000-01-01" }).totalCount).toBe(6);
  expect(names(call("search-harvests", { search: "blue dream" }))).toEqual(["Blue Dream Harvest 30", "Blue Dream Harvest 31", "Blue Dream Harvest 32"]);
  expect(names(call("search-harvests", { search: "blue dream", sortBy: { field: "HARVESTED_AT", direction: "DESC" } }))[0]).toBe("Blue Dream Harvest 32");
  const dryRoom = world.locations.find((l) => l.name === "Dry Room")!;
  expect(call("search-harvests", { locationIds: [dryRoom.id], licenseId: "lic_2" }).totalCount).toBe(8);
  expect(call("search-harvests", { licenseId: "1" }).totalCount).toBe(0);
  expect(call("search-harvests", { ids: ["hrv_1", "hrv_2"], excludeIds: ["2"] }).items.map((h: any) => h.id)).toEqual(["hrv_1"]);
  expect(names(call("search-harvests", { sortBy: { field: "INSERTED_AT", direction: "ASC" }, limit: 1 }))).toEqual(["Sour Diesel Harvest 8"]);
  const first = call("search-harvests", { sortBy: { field: "HARVESTED_AT", direction: "ASC" }, limit: 5 });
  expect(first.hasMore).toBe(true);
  expect(names(call("search-harvests", { sortBy: { field: "HARVESTED_AT", direction: "ASC" }, limit: 5, cursor: first.nextCursor }))).toEqual(["Wedding Cake Harvest 21", "OG Kush Harvest 2", "Blue Dream Harvest 32"]);
  expect(error("search-harvests", { finishedAfter: "2026-10-01T00:00:00-07:00" })).toContain("tool_error");
  expect(error("search-harvests", { harvestedAfter: "October" })).toContain("tool_error");
  expect(error("search-harvests", { sortBy: { field: "SUBMITTED_FOR_REVIEW_AT", direction: "ASC" } })).toContain("tool_error");
  expect(error("search-harvests", { excludeIds: ["plt_1"] })).toContain("tool_error");
  expect(error("search-harvests", { teardownId: "1" })).toContain("unsupported_input");
});

test("search-harvests has no harvests this month in the first days of a month", () => {
  const { call } = bench("2026-12-02");
  const lm = lastMonth("2026-12-02");
  expect(call("search-harvests", { harvestedAfter: lm.start, harvestedBefore: lm.end }).totalCount).toBe(5);
  expect(call("search-harvests", { harvestedAfter: "2026-12-01" }).totalCount).toBe(0);
});

test("get-harvest agrees with search-harvests and leaves out what the world does not keep", () => {
  const { call, error } = bench();
  const listed = call("search-harvests", { search: "Wedding Cake" }).items[0];
  const { harvest } = call("get-harvest", { id: listed.id });
  for (const k of ["name", "distruStatus", "harvestedAt", "finishedDate", "wetWeight", "metrcStrain", "unitType", "license", "location"]) expect(harvest[k]).toEqual(listed[k]);
  expect(harvest.wetWeight).toBe("21600");
  expect([harvest.wasteWeight, harvest.packagedWeight, harvest.totalCost, harvest.teardown]).toEqual([null, null, null, null]);
  expect(harvest.breakdowns).toBeUndefined();
  expect(call("get-harvest", { id: listed.id.split("_")[1], includeBreakdowns: true }).harvest.breakdowns).toEqual([]);
  expect(call("get-harvest", { id: "hrv_99" }).harvest).toBeNull();
  expect(error("get-harvest", { id: "plt_1" })).toContain("tool_error");
});

test("report-plant-lifecycle is not served: the world keeps no veg dates or batch costs", () => {
  expect(bench().error("report-plant-lifecycle")).toContain("unimplemented");
});
