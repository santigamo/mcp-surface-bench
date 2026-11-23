import { expect, test } from "bun:test";
import { addDays } from "../src/core/kit.ts";
import type { World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

const YESTERDAY = addDays(TODAY, -1);
const license = (w: World, kind: "DISTRIBUTION" | "CULTIVATION") => w.licenses.find((l) => l.kind === kind)!.id;
const labels = (r: { items: { label: string }[] }) => r.items.map((x) => x.label).sort();

test("search-licenses lists both Metrc licenses with their sync health", () => {
  const { call, error, world } = bench();
  const all = call("search-licenses");
  expect(all.items.map((l: any) => l.licenseNumber).sort()).toEqual(["C11-0000482-LIC", "CCL19-0003371"]);
  expect(all.items.every((l: any) => l.complianceType === "METRC" && l.metrcPullStatus && l.metrcPushStatus)).toBe(true);

  const dist = call("search-licenses", { ids: [license(world, "DISTRIBUTION")] }).items[0];
  expect(dist.hasCultivation).toBe(false);
  expect(dist.metrcPullStatus.cachesUpdatedUpUntil.harvests).toBeNull();
  expect(dist.metrcPushStatus).toMatchObject({ queuedCount: 1, failedCount: 2, oldestIncompleteActivity: { type: "ADJUST_PACKAGE", status: "FAILED", errorCount: 1 } });
  expect(dist.metrcPushStatus.lastCompletedActivityDatetime).toStartWith(`${YESTERDAY}T17:10`);
  const cult = call("search-licenses", { ids: ["2"] }).items[0];
  expect(cult).toMatchObject({ hasCultivation: true, metrcPushStatus: { queuedCount: 0, failedCount: 0, oldestIncompleteActivity: null } });

  expect(call("search-licenses", { complianceType: "NONE" }).totalCount).toBe(0);
  expect(call("search-licenses", { status: "INACTIVE" }).totalCount).toBe(0);
  expect(call("search-licenses", { status: "ANY", complianceType: "METRC" }).totalCount).toBe(2);
  expect(call("search-licenses", { sortBy: { field: "LICENSE_NUMBER", direction: "ASC" } }).items[0].licenseNumber).toBe("C11-0000482-LIC");
  expect(call("search-licenses", { sortBy: { field: "EXPIRY_DATE", direction: "ASC" } }).totalCount).toBe(2);
  const first = call("search-licenses", { limit: 1 });
  expect(first.hasMore).toBe(true);
  expect(call("search-licenses", { limit: 1, cursor: first.nextCursor }).items[0].id).not.toBe(first.items[0].id);

  expect(error("search-licenses", { ids: ["usr_1"] })).toContain("tool_error");
  expect(error("search-licenses", { includeMetrcAdjustmentReasons: true })).toContain("unsupported_input");
});

test("five Metrc packages are not in Distru yet: three on the distribution license, two on cultivation", () => {
  const { call, error, world } = bench();
  const dist = call("search-metrc-packages", { licenseId: license(world, "DISTRIBUTION"), importStatus: "UNIMPORTED" });
  const cult = call("search-metrc-packages", { licenseId: license(world, "CULTIVATION"), importStatus: "UNIMPORTED" });
  expect(dist.items.map((m: any) => m.metrcItem.name).sort()).toEqual(["Gelato Live Resin 1g", "Jack Herer 14g", "Sour Diesel 3.5g"]);
  expect(cult.items.map((m: any) => m.metrcItem.name).sort()).toEqual(["Blue Dream Bulk Flower", "Wedding Cake Bulk Flower"]);
  expect([...labels(dist), ...labels(cult)].sort()).toEqual(world.metrcPackages.filter((m) => m.importStatus === "UNIMPORTED").map((m) => m.label).sort());
  for (const m of [...dist.items, ...cult.items]) expect(m.package).toBeNull();

  const sourDiesel = dist.items.find((m: any) => m.metrcItem.name === "Sour Diesel 3.5g");
  expect(sourDiesel).toMatchObject({ quantity: "240", unitType: { name: "Each" }, metrcLocation: { name: "Vault" }, productMostRecentlyMappedToMetrcItem: { name: "Sour Diesel 3.5g" } });
  expect(cult.items[0]).toMatchObject({ unitType: { name: "Gram" }, labTestingState: "NotSubmitted", productMostRecentlyMappedToMetrcItem: null });

  expect(error("search-metrc-packages")).toContain("invalid_arguments");
  expect(error("search-metrc-packages", { licenseId: "com_1" })).toContain("tool_error");
  expect(error("search-metrc-packages", { licenseId: "lic_9" })).toContain("tool_error");
});

test("IMPORTABLE is UNIMPORTED, active or on hold, with quantity left", () => {
  const { call, world } = bench();
  const lic = license(world, "DISTRIBUTION");
  const unimported = world.metrcPackages.filter((m) => m.licenseId === lic && m.importStatus === "UNIMPORTED");
  expect(labels(call("search-metrc-packages", { licenseId: lic, importStatus: "IMPORTABLE" }))).toEqual(unimported.map((m) => m.label).sort());

  unimported[0]!.quantity = 0;
  unimported[1]!.status = "FINISHED";
  expect(labels(call("search-metrc-packages", { licenseId: lic, importStatus: "IMPORTABLE", statuses: ["ACTIVE", "FINISHED"] }))).toEqual([unimported[2]!.label]);
  expect(call("search-metrc-packages", { licenseId: lic, importStatus: "UNIMPORTED", statuses: ["ACTIVE", "FINISHED"] }).totalCount).toBe(3);
  // By default only ACTIVE and ONHOLD packages are searched.
  expect(call("search-metrc-packages", { licenseId: lic, importStatus: "UNIMPORTED" }).totalCount).toBe(2);
  unimported[2]!.status = "ONHOLD";
  expect(labels(call("search-metrc-packages", { licenseId: lic, importStatus: "IMPORTABLE" }))).toEqual([unimported[2]!.label]);
});

test("search-metrc-packages honours every filter, sorts and pages", () => {
  const { call, error, world } = bench();
  const lic = license(world, "DISTRIBUTION");
  const all = call("search-metrc-packages", { licenseId: lic, limit: 100 });
  const imported = all.items.find((m: any) => m.package !== null);
  expect(imported.package.metrcLabel).toBe(imported.label);
  expect(imported.package.product.name).toBe(imported.metrcItem.name);
  expect(call("search-metrc-packages", { licenseId: lic, importStatus: "IMPORTED" }).totalCount).toBe(all.totalCount - 3);

  const first = call("search-metrc-packages", { licenseId: lic });
  expect(first.items).toHaveLength(10);
  const second = call("search-metrc-packages", { licenseId: lic, cursor: first.nextCursor });
  expect(second.items[0].label).toBe(all.items[10].label);

  const one = all.items[4];
  expect(labels(call("search-metrc-packages", { licenseId: lic, search: one.label.slice(-6) }))).toEqual([one.label]);
  expect(labels(call("search-metrc-packages", { licenseId: lic, labels: [one.label.toLowerCase()] }))).toEqual([one.label]);
  expect(labels(call("search-metrc-packages", { licenseId: lic, metrcIds: [one.metrcId] }))).toEqual([one.label]);
  expect(call("search-metrc-packages", { licenseId: lic, searchMetrcItem: "live resin", limit: 100 }).items.every((m: any) => /live resin/i.test(m.metrcItem.name))).toBe(true);
  expect(call("search-metrc-packages", { licenseId: lic, searchMetrcStrain: "jack", limit: 100 }).items.every((m: any) => m.strainName === "Jack Herer")).toBe(true);
  expect(call("search-metrc-packages", { licenseId: license(world, "CULTIVATION"), searchMetrcCategory: "buds" }).totalCount).toBe(4);
  expect(call("search-metrc-packages", { licenseId: license(world, "CULTIVATION"), labTestingStates: ["NotSubmitted"] }).totalCount).toBe(2);

  const processing = call("search-metrc-locations", { licenseId: lic, search: "processing" }).items[0];
  expect(call("search-metrc-packages", { licenseId: lic, metrcLocationIds: [processing.id] }).items.map((m: any) => m.metrcItem.name)).toEqual(["Jack Herer 14g"]);

  const byLabel = call("search-metrc-packages", { licenseId: lic, limit: 100, sortBy: { field: "LABEL", direction: "ASC" } }).items.map((m: any) => m.label);
  expect(byLabel).toEqual([...byLabel].sort());
  const newest = call("search-metrc-packages", { licenseId: lic, sortBy: { field: "INSERTED_AT", direction: "DESC" } }).items[0];
  expect(newest.metrcItem.name).toBe("Jack Herer 14g");

  expect(error("search-metrc-packages", { licenseId: lic, metrcLocationIds: ["loc_1"] })).toContain("tool_error");
  expect(error("search-metrc-packages", { licenseId: lic, isTradeSample: false })).toContain("unsupported_input");
});

test("yesterday's Metrc adjustments: one of them failed, with its error and package label", () => {
  const { call, world } = bench();
  const yesterday = call("search-metrc-activities", { createdDateAfter: YESTERDAY, createdDateBefore: YESTERDAY, limit: 100 });
  expect(yesterday.totalCount).toBe(8);
  const adjustments = yesterday.items.filter((a: any) => a.type === "ADJUST_PACKAGE");
  expect(adjustments).toHaveLength(5);
  const failed = adjustments.filter((a: any) => a.status === "FAILED");
  expect(failed).toHaveLength(1);
  expect(failed[0].lastError).toContain("more than the package holds");
  expect(adjustments.filter((a: any) => a.status === "COMPLETED")).toHaveLength(4);
  expect(yesterday.items.map((a: any) => a.type)).toContain("CHANGE_PACKAGE_LOCATION");
  for (const a of yesterday.items) {
    expect(a.package.metrcLabel).toBe(world.packages.find((k) => k.id === a.package.id)!.metrcLabel);
    expect(a.title).toEndWith(a.package.metrcLabel);
  }

  const failures = call("search-metrc-activities", { statuses: ["FAILED"] });
  expect(failures.items.map((a: any) => a.insertedAt.slice(0, 10))).toEqual([YESTERDAY, addDays(TODAY, -2)]);
  const queued = call("search-metrc-activities", { statuses: ["QUEUED"] }).items;
  expect(queued.map((a: any) => [a.type, a.insertedAt.slice(0, 10)])).toEqual([["ADJUST_PACKAGE", TODAY]]);
  expect(call("search-metrc-activities", { createdDateAfter: YESTERDAY, createdDateBefore: YESTERDAY, statuses: ["FAILED", "QUEUED"] }).totalCount).toBe(1);
});

test("search-metrc-activities honours every filter, sorts and pages", () => {
  const { call, error, world } = bench();
  const all = call("search-metrc-activities", { limit: 100 });
  expect(all.totalCount).toBe(world.metrcActivities.length);
  expect(all.items[0].status).toBe("QUEUED");

  const first = call("search-metrc-activities");
  expect(first.hasMore).toBe(true);
  expect(call("search-metrc-activities", { cursor: first.nextCursor }).items).toHaveLength(all.totalCount - 10);
  expect(call("search-metrc-activities", { sortBy: { field: "INSERTED_AT", direction: "ASC" } }).items[0].insertedAt).toStartWith(addDays(TODAY, -2));

  const one = all.items[3];
  expect(call("search-metrc-activities", { ids: [one.id.split("_")[1]] }).items.map((a: any) => a.id)).toEqual([one.id]);
  expect(call("search-metrc-activities", { packageIds: [one.package.id] }).items.every((a: any) => a.package.id === one.package.id)).toBe(true);
  const lena = call("search-metrc-activities", { creatorIds: ["usr_5"], limit: 100 });
  expect(lena.items.every((a: any) => a.creator.profile.fullName === "Lena Hartmann")).toBe(true);
  expect(lena.totalCount).toBe(8);
  expect(call("search-metrc-activities", { licenseIds: [license(world, "CULTIVATION")] }).totalCount).toBe(0);
  expect(call("search-metrc-activities", { createdDateAfter: `${YESTERDAY}T12:00:00-08:00`, createdDateBefore: `${YESTERDAY}T23:59:59-08:00` }).totalCount).toBe(4);

  expect(error("search-metrc-activities", { createdDateAfter: "yesterday" })).toContain("tool_error");
  expect(error("search-metrc-activities", { creatorIds: ["lic_1"] })).toContain("tool_error");
  expect(error("search-metrc-activities", { assemblyIds: ["1"] })).toContain("unsupported_input");
});

test("search-metrc-manifests lists the three manifests and filters them", () => {
  const { call, error, world } = bench();
  const numbers = (args: Record<string, unknown>) => call("search-metrc-manifests", args).items.map((x: any) => x.manifestNumber);
  expect(numbers({}).sort()).toEqual(["0001234100", "0001234567", "0001234568"]);
  expect(numbers({ direction: "INCOMING" }).sort()).toEqual(["0001234567", "0001234568"]);
  expect(numbers({ direction: "OUTGOING" })).toEqual(["0001234100"]);
  expect(numbers({ search: "4567" })).toEqual(["0001234567"]);
  expect(numbers({ searchLicenseNumber: world.companies.find((c) => c.name === "Sierra Extracts")!.licenseNumber!.toLowerCase() })).toEqual(["0001234568"]);
  expect(numbers({ licenseIds: [license(world, "CULTIVATION")] })).toEqual([]);
  expect(numbers({ packageLabel: world.metrcManifests[0]!.packages[2]!.label })).toEqual(["0001234567"]);
  expect(numbers({ received: false }).sort()).toEqual(["0001234567", "0001234568"]);
  expect(numbers({ received: true })).toEqual(["0001234100"]);
  expect(numbers({ voided: false })).toHaveLength(3);
  expect(numbers({ voided: true })).toEqual([]);
  expect(numbers({ sortBy: { field: "MANIFEST_NUMBER", direction: "ASC" } })).toEqual(["0001234100", "0001234567", "0001234568"]);
  expect(numbers({ sortBy: { field: "INSERTED_AT", direction: "DESC" } })[0]).toBe("0001234568");

  const page1 = call("search-metrc-manifests", { limit: 2 });
  expect(page1.hasMore).toBe(true);
  expect(call("search-metrc-manifests", { limit: 2, cursor: page1.nextCursor }).items).toHaveLength(1);

  const outgoing = call("search-metrc-manifests", { direction: "OUTGOING" }).items[0];
  expect(outgoing).toMatchObject({ shipperLicenseNumber: "C11-0000482-LIC", recipients: [{ name: "Sunset Dispensary" }], packageCount: 2, importStatus: "UNIMPORTED", isImportable: true });

  expect(error("search-metrc-manifests", { licenseIds: ["loc_1"] })).toContain("tool_error");
  expect(error("search-metrc-manifests", { importStatus: "IMPORTED" })).toContain("unsupported_input");
});

test("get-metrc-manifest shows the four packages on incoming manifest 0001234567", () => {
  const { call, error } = bench();
  const plain = call("get-metrc-manifest", { manifestNumber: "0001234567" }).manifest;
  expect(plain).toMatchObject({ direction: "INCOMING", shipperName: "Humboldt Family Farms", recipients: [{ licenseNumber: "C11-0000482-LIC" }], packageCount: 4, receivedDatetime: null });
  expect(plain.deliveries).toBeUndefined();

  const full = call("get-metrc-manifest", { manifestNumber: "0001234567", direction: "INCOMING", includeDeliveries: true }).manifest;
  expect(full.deliveries).toHaveLength(1);
  const packages = full.deliveries[0].packages;
  expect(packages.map((p: any) => [p.itemName, p.shippedQuantity, p.status])).toEqual([
    ["Blue Dream 7g", "250", "SHIPPED"], ["Wedding Cake 3.5g", "400", "SHIPPED"], ["OG Kush 3.5g", "320", "SHIPPED"], ["Jack Herer 14g", "90", "SHIPPED"],
  ]);
  expect(packages.every((p: any) => p.label.length === 24 && p.receivedQuantity === null && p.package === null)).toBe(true);
  expect(packages[0].productMostRecentlyMappedToMetrcItem.name).toBe("Blue Dream 7g");

  const delivered = call("get-metrc-manifest", { manifestNumber: "0001234100", includeDeliveries: true }).manifest;
  expect(delivered.deliveries[0].packages.every((p: any) => p.status === "ACCEPTED" && p.receivedQuantity === p.shippedQuantity)).toBe(true);

  expect(call("get-metrc-manifest", { manifestNumber: "0001234567", direction: "OUTGOING" }).manifest).toBeNull();
  expect(call("get-metrc-manifest", { manifestNumber: "0009999999" }).manifest).toBeNull();
  expect(error("get-metrc-manifest")).toContain("invalid_arguments");
});

test("search-metrc-locations lists the rooms of each license, by name", () => {
  const { call, error, world } = bench();
  const all = call("search-metrc-locations", { limit: 100 });
  expect(all.items.map((r: any) => r.name)).toEqual(["Dry Room", "Flower Room A", "Processing Room", "Shipping Room", "Vault", "Veg Room"]);
  expect(all.items.every((r: any) => /^\d+$/.test(r.id))).toBe(true);
  expect(call("search-metrc-locations", { licenseId: license(world, "CULTIVATION") }).items.map((r: any) => r.name)).toEqual(["Dry Room", "Flower Room A", "Veg Room"]);
  expect(call("search-metrc-locations", { search: "ROOM" }).totalCount).toBe(5);
  const first = call("search-metrc-locations", { limit: 4 });
  expect(call("search-metrc-locations", { limit: 4, cursor: first.nextCursor }).items).toHaveLength(2);

  // A room a synced package is in but no Distru location matches is a room too.
  world.metrcPackages[0]!.metrcLocationName = "Quarantine";
  expect(call("search-metrc-locations", { search: "quarantine" }).items).toMatchObject([{ name: "Quarantine", license: { id: world.metrcPackages[0]!.licenseId } }]);

  expect(error("search-metrc-locations", { licenseId: "usr_1" })).toContain("tool_error");
});
