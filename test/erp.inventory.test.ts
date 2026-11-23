import { expect, test } from "bun:test";
import { activeQuantity, type World } from "../suites/erp/world.ts";
import { bench } from "./helpers.ts";

const productId = (w: World, name: string) => w.products.find((p) => p.name === name)!.id;
const locationId = (w: World, name: string) => w.locations.find((l) => l.name === name)!.id;
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);
/** Every row of a search, page by page. */
function all(call: (tool: string, args?: Record<string, unknown>) => any, tool: string, args: Record<string, unknown>) {
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const r = call(tool, { ...args, ...(cursor ? { cursor } : {}) });
    items.push(...r.items);
    cursor = r.nextCursor;
  } while (cursor);
  return items;
}

test("search-locations filters, sorts and pages", () => {
  const { call, error, world: w } = bench();
  const first = call("search-locations");
  expect(first.totalCount).toBe(6);
  expect(first.items[0].name).toBe("Dry Room");
  expect(first.items[0].license.licenseNumber).toBe("CCL19-0003371");
  expect(call("search-locations", { search: "VAULT" }).items.map((l: any) => l.name)).toEqual(["Vault"]);
  expect(call("search-locations", { search: "room", sortBy: { field: "NAME", direction: "ASC" } }).items.map((l: any) => l.name))
    .toEqual(["Dry Room", "Flower Room A", "Processing Room", "Shipping Room", "Veg Room"]);
  expect(ids(call("search-locations", { ids: ["loc_2", "3"] })).sort()).toEqual(["loc_2", "loc_3"]);
  expect(call("search-locations", { licenseId: "lic_2" }).totalCount).toBe(3);
  expect(call("search-locations", { complianceType: "METRC" }).totalCount).toBe(6);
  expect(call("search-locations", { complianceType: "NONE" }).totalCount).toBe(0);
  expect(ids(call("search-locations", { packageProductIds: [productId(w, "Blue Dream 7g")] }))).toEqual([locationId(w, "Vault")]);
  expect(call("search-locations", { packageProductIds: [productId(w, "Blue Dream 3.5g")] }).totalCount).toBe(0); // batch-tracked: no packages
  expect(call("search-locations", { sortBy: { field: "INSERTED_AT", direction: "ASC" } }).items[0].name).toBe("Vault");
  const page1 = call("search-locations", { limit: 4 });
  expect(page1.hasMore).toBe(true);
  const page2 = call("search-locations", { limit: 4, cursor: page1.nextCursor });
  expect(page2.hasMore).toBe(false);
  expect(new Set([...ids(page1), ...ids(page2)]).size).toBe(6);
  expect(error("search-locations", { ids: ["prd_1"] })).toContain("tool_error");
  expect(error("search-locations", { complianceType: "LEAF" })).toContain("invalid_arguments");
});

test("search-batches returns batches of active batch-tracked products, with stock per location", () => {
  const { call, error, world: w } = bench();
  expect(call("search-batches").totalCount).toBe(20);
  expect(call("search-batches", { productStatus: "ANY" }).totalCount).toBe(21);
  const inactive = call("search-batches", { productStatus: "INACTIVE" });
  expect(inactive.items.map((b: any) => [b.product.name, b.product.inactive])).toEqual([["Sour Diesel Pre-Roll 5-Pack", true]]);

  const [blueDream] = call("search-batches", { search: "blue dream 3.5" }).items;
  expect(blueDream).toMatchObject({ id: "bat_1", name: "LOT-2200", batchNumber: "LOT-2200", quantity: "70", product: { name: "Blue Dream 3.5g", unitType: { name: "Each" } } });
  expect(blueDream.activeQuantitiesByLocation).toEqual([{ location: { id: "loc_1", name: "Vault" }, quantity: "60" }, { location: { id: "loc_2", name: "Shipping Room" }, quantity: "10" }]);
  const product = w.products.find((p) => p.id === blueDream.product.id)!;
  expect(blueDream.activeQuantityCost).toBe((70 * product.unitCost).toFixed(2));
  expect(call("search-batches", { search: "LOT-2200" }).items[0].id).toBe("bat_1");
  expect(call("search-batches", { search: "FL-1001" }).items[0].id).toBe("bat_1");

  expect(ids(call("search-batches", { ids: ["bat_2", "3"] })).sort()).toEqual(["bat_2", "bat_3"]);
  expect(ids(call("search-batches", { productIds: [product.id] }))).toEqual(["bat_1"]);
  const [, prerolls, , vapes] = w.categories;
  expect(call("search-batches", { productCategoryIds: [vapes!.id] }).totalCount).toBe(6);
  const cartridges = vapes!.subcategories[0]!, infused = prerolls!.subcategories[2]!;
  // A subcategory of an unlisted category adds to the listed categories; one of a listed category narrows it.
  expect(call("search-batches", { productCategoryIds: [prerolls!.id], productSubcategoryIds: [cartridges.id], limit: 100 }).totalCount).toBe(13 + 4);
  expect(call("search-batches", { productCategoryIds: [prerolls!.id], productSubcategoryIds: [infused.id] }).items.map((b: any) => b.product.name).sort())
    .toEqual(["Gelato Infused Pre-Roll", "OG Kush Infused Pre-Roll", "Sour Diesel Infused Pre-Roll"]);
  const summerPromo = w.tags.find((t) => t.name === "Summer promo")!;
  expect(call("search-batches", { productTagIds: [summerPromo.id] }).items.map((b: any) => b.product.name)).toEqual(["Blue Dream Pre-Roll 5-Pack"]);
  const caliVape = w.companies.find((x) => x.name === "Cali Vape Works")!;
  expect(call("search-batches", { vendorIds: [caliVape.id] }).totalCount).toBe(6);
  expect(call("search-batches", { brandIds: [caliVape.id] }).totalCount).toBe(0);
  expect(call("search-batches", { productGroupIds: ["grp_1"] }).items.every((b: any) => w.products.find((p) => p.id === b.product.id)!.groupId === "grp_1")).toBe(true);
  expect(call("search-batches", { sortBy: { field: "BATCH_NUMBER", direction: "ASC" } }).items[0].batchNumber).toBe("LOT-2200");
  // The seed creates later lots earlier: the default puts the newest first.
  expect(call("search-batches").items[0].id).toBe("bat_1");
  expect(call("search-batches", { sortBy: { field: "INSERTED_AT", direction: "ASC" } }).items[0].id).toBe("bat_21");

  const pages = all(call, "search-batches", { limit: 7 });
  expect(pages).toHaveLength(20);
  expect(new Set(pages.map((b) => b.id)).size).toBe(20);
  expect(error("search-batches", { ids: ["pkg_1"] })).toContain("tool_error");
  expect(error("search-batches", { thcPercentageTotal: { min: 20 } })).toContain("unsupported_input");
});

test("get-batch shows quantities by location only when asked", () => {
  const { call, error } = bench();
  const plain = call("get-batch", { id: "bat_1" }).batch;
  expect(plain).toMatchObject({ id: "bat_1", name: "LOT-2200", quantity: "70", product: { name: "Blue Dream 3.5g" }, owner: null });
  expect(plain.activeQuantitiesByLocation).toBeUndefined();
  expect(plain.activeQuantityCostItems).toBeUndefined();
  const detailed = call("get-batch", { id: "1", includeActiveQuantitiesByLocation: true, includeActiveQuantityCostItems: true }).batch;
  expect(detailed.activeQuantitiesByLocation.map((r: any) => [r.location.name, r.quantity])).toEqual([["Vault", "60"], ["Shipping Room", "10"]]);
  expect(detailed.activeQuantityCostItems).toBeNull();
  expect(call("get-batch", { id: "bat_999" }).batch).toBeNull();
  expect(error("get-batch", { id: "prd_1" })).toContain("tool_error");
  expect(error("get-batch")).toContain("invalid_arguments");
});

test("search-packages filters by stock, status, place and product", () => {
  const { call, error, world: w } = bench();
  const live = w.packages.filter((k) => k.status === "ACTIVE" && w.products.find((p) => p.id === k.productId)!.active);
  expect(call("search-packages").totalCount).toBe(live.length);
  const finished = w.packages.filter((k) => k.status === "FINISHED").map((k) => k.id);
  expect(finished.length).toBeGreaterThan(0);
  expect(call("search-packages", { withQuantity: false }).items.map((k: any) => k.id).sort()).toEqual([...finished].sort());
  expect(call("search-packages", { distruStatuses: ["FINISHED"], withQuantity: false }).totalCount).toBe(finished.length);
  // ids lifts the quantity default, so an emptied package is still found.
  expect(call("search-packages", { ids: [finished[0]!] }).items[0]).toMatchObject({ distruStatus: "FINISHED", quantity: "0", quantityActive: "0", quantityCost: null });
  expect(call("search-packages", { status: "INACTIVE" }).totalCount).toBe(0);
  expect(call("search-packages", { status: "ANY" }).totalCount).toBe(live.length);

  const label = live[3]!.metrcLabel;
  expect(ids(call("search-packages", { search: label }))).toEqual([live[3]!.id]);
  expect(ids(call("search-packages", { search: label.slice(-6) }))).toEqual([live[3]!.id]);
  const wc = call("search-packages", { search: "wedding cake 3.5" });
  expect(wc.items.every((k: any) => k.product.name === "Wedding Cake 3.5g")).toBe(true);
  const row = wc.items[0];
  expect(row).toMatchObject({ complianceType: "METRC", labTestingState: "PASSED", location: { name: "Vault" }, license: { licenseNumber: "C11-0000482-LIC" }, complianceProductName: "Wedding Cake 3.5g" });
  expect(typeof row.metrcId).toBe("number");

  const vault = locationId(w, "Vault");
  expect(call("search-packages", { locationIds: [vault], licenseIds: ["lic_1"] }).totalCount).toBe(live.filter((k) => k.locationId === vault).length);
  expect(call("search-packages", { licenseIds: ["lic_2"] }).items.map((k: any) => k.product.name)).toEqual(["Gelato Bulk Flower"]);
  expect(call("search-packages", { locationIds: [locationId(w, "Shipping Room")] }).totalCount).toBe(0);
  expect(call("search-packages", { productIds: [productId(w, "Blue Dream 7g")] }).totalCount).toBe(2);
  const concentrates = w.categories[4]!;
  expect(call("search-packages", { productCategoryIds: [concentrates.id], limit: 100 }).items.every((k: any) => /Resin|Rosin|Badder/.test(k.product.name))).toBe(true);
  expect(call("search-packages", { productTagIds: [w.tags[0]!.id], vendorIds: ["com_1", "com_2"], productGroupIds: ["grp_1", "grp_2"], brandIds: ["com_1"] }).totalCount).toBe(0);
  expect(call("search-packages", { labTestingStates: ["NOT_TESTED"] }).totalCount).toBe(0);
  expect(call("search-packages", { labTestingStates: ["PASSED"] }).totalCount).toBe(live.length);

  // A package is syncing while a change of it is not in Metrc yet: queued, or failed and holding the queue back.
  const pending = [...new Set(w.metrcActivities.filter((a) => a.status !== "COMPLETED").map((a) => a.packageId!))];
  expect(ids(call("search-packages", { syncing: true })).sort()).toEqual(pending.sort());
  expect(call("search-packages", { syncing: false }).totalCount).toBe(live.length - pending.length);

  const byQuantity = call("search-packages", { sortBy: { field: "QUANTITY", direction: "DESC" }, limit: 100 }).items.map((k: any) => +k.quantity);
  expect(byQuantity).toEqual([...byQuantity].sort((a, b) => b - a));
  expect(call("search-packages", { sortBy: { field: "COMPLIANCE_LABEL", direction: "ASC" } }).items[0].metrcLabel).toBe([...live.map((k) => k.metrcLabel)].sort()[0]);
  expect(call("search-packages", { sortBy: { field: "INSERTED_AT", direction: "ASC" } }).items[0].id).toBe([...live].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!.id);
  expect(all(call, "search-packages", { limit: 6 })).toHaveLength(live.length);
  expect(error("search-packages", { sortBy: { field: "EXPIRATION_DATE", direction: "ASC" } })).toContain("tool_error");
  expect(error("search-packages", { isTestSample: true })).toContain("unsupported_input");
});

test("get-package adds Metrc detail and the reason a package is syncing", () => {
  const { call, error, world: w } = bench();
  const queued = w.metrcActivities.find((a) => a.status === "QUEUED")!;
  const k = call("get-package", { id: queued.packageId! }).package;
  expect(k).toMatchObject({ id: queued.packageId, syncing: true, syncingReason: "STOCK_ADJUSTMENT", metrcStatus: "ACTIVE", isActive: true });
  expect(k.quantityCostItems).toBeUndefined();
  const p = w.packages.find((x) => x.id === queued.packageId)!, product = w.products.find((x) => x.id === p.productId)!;
  expect(k.quantityCost).toBe((p.quantity * product.unitCost).toFixed(2));
  expect(call("get-package", { id: "pkg_2", includeQuantityCostItems: true }).package.quantityCostItems).toBeNull();
  expect(call("get-package", { id: "pkg_2" }).package).toMatchObject({ syncing: false, syncingReason: null });
  expect(call("get-package", { id: "pkg_999" }).package).toBeNull();
  expect(error("get-package", { id: "bat_1" })).toContain("tool_error");
});

test("move-stock moves 20 units of Blue Dream 3.5g from the vault to the shipping room", () => {
  const { call, world: w } = bench();
  const [batch] = call("search-batches", { search: "Blue Dream 3.5g" }).items;
  const vault = call("search-locations", { search: "vault" }).items[0].id, shipping = call("search-locations", { search: "shipping" }).items[0].id;
  const actions = w.actions.length;

  const { stockTransfer } = call("move-stock", { fromLocationId: vault, toLocationId: shipping, items: [{ batchId: batch.id, quantity: 20 }], description: "Restock shipping" });
  expect(stockTransfer).toMatchObject({
    id: "stt_1", stockTransferNumber: "ST-1", status: "COMPLETED", transferDatetime: "2026-11-23T10:00:00-08:00", completedAt: "2026-11-23T10:00:00-08:00", description: "Restock shipping",
    fromLocation: { id: "loc_1", name: "Vault" }, toLocation: { id: "loc_2", name: "Shipping Room" },
    items: [{ quantity: "20", product: { id: batch.product.id, name: "Blue Dream 3.5g" }, batch: { id: "bat_1", name: "LOT-2200" }, package: null }],
  });

  expect(w.batches[0]!.stock).toEqual([{ locationId: "loc_1", quantity: 40 }, { locationId: "loc_2", quantity: 30 }]);
  expect(activeQuantity(w, w.products[0]!)).toBe(70);
  expect(w.stockTransfers).toEqual([{
    id: "stt_1", number: "ST-1", fromLocationId: "loc_1", toLocationId: "loc_2", items: [{ productId: "prd_1", batchId: "bat_1", quantity: 20 }], description: "Restock shipping",
    transferDatetime: "2026-11-23T10:00:00-08:00", completedAt: "2026-11-23T10:00:00-08:00",
  }]);
  expect(w.actions).toHaveLength(actions + 1);
  expect(w.actions.at(-1)).toMatchObject({
    source: "MCP", actorName: "Maya Okafor",
    records: [{ type: "STOCK_TRANSFER", id: "stt_1", entity: "STOCK_TRANSFER", rowId: "stt_1", op: "INSERT" }, { type: "STOCK_TRANSFER", id: "stt_1", entity: "STOCK_TRANSFER_ITEM", rowId: null, rowLabel: "Blue Dream 3.5g", op: "INSERT" }],
  });
  expect(call("get-batch", { id: "bat_1", includeActiveQuantitiesByLocation: true }).batch.activeQuantitiesByLocation.map((r: any) => r.quantity)).toEqual(["40", "30"]);
});

test("move-stock moves product-tracked stock and drops a location it empties", () => {
  const { call, world: w } = bench();
  const gummies = w.products.find((p) => p.name === "Watermelon Gummies 100mg")!;
  const [inVault, inShipping] = gummies.stock.map((s) => s.quantity) as [number, number];
  const r = call("move-stock", { fromLocationId: "loc_2", toLocationId: "1", items: [{ productId: gummies.id, quantity: String(inShipping) }], transferDatetime: "2026-11-20T12:00:00Z" });
  expect(r.stockTransfer.items).toEqual([{ quantity: String(inShipping), product: { id: gummies.id, name: gummies.name }, batch: null, package: null }]);
  expect(r.stockTransfer.transferDatetime).toBe("2026-11-20T04:00:00-08:00");
  expect(gummies.stock).toEqual([{ locationId: "loc_1", quantity: inVault + inShipping }]);
  call("move-stock", { fromLocationId: "loc_1", toLocationId: "loc_3", items: [{ productId: gummies.id, quantity: 2.5 }] });
  expect(gummies.stock).toEqual([{ locationId: "loc_1", quantity: inVault + inShipping - 2.5 }, { locationId: "loc_3", quantity: 2.5 }]);
});

test("move-stock refuses what its page refuses and leaves the world untouched", () => {
  const { error, world: w } = bench();
  const before = JSON.stringify(w);
  const move = (items: unknown[], extra: Record<string, unknown> = {}) => error("move-stock", { fromLocationId: "loc_1", toLocationId: "loc_2", items, ...extra });
  const blueDream = productId(w, "Blue Dream 3.5g");
  expect(move([{ productId: blueDream, quantity: 20 }])).toContain("is batch-tracked: send the batchId");
  expect(move([{ productId: productId(w, "Blue Dream 7g"), quantity: 1 }])).toContain("distru-move-packages");
  expect(move([{ batchId: "bat_1", productId: blueDream, quantity: 1 }])).toContain("exactly one of batchId or productId");
  expect(move([{ quantity: 1 }])).toContain("exactly one of batchId or productId");
  for (const quantity of [0, -5, "", "abc"]) expect(move([{ batchId: "bat_1", quantity }])).toContain("greater than 0");
  expect(move([{ batchId: "bat_1", quantity: 61 }])).toContain("Only 60 of Blue Dream 3.5g (batch LOT-2200) is at Vault");
  expect(move([{ batchId: "bat_1", quantity: 40 }, { batchId: "bat_1", quantity: 30 }])).toContain("this call moves 70");
  expect(move([{ batchId: "bat_1", quantity: 1 }], { toLocationId: "loc_1" })).toContain("same location");
  expect(move([{ batchId: "bat_1", quantity: 1 }], { toLocationId: "loc_99" })).toContain("No location found");
  expect(move([{ batchId: "bat_99", quantity: 1 }])).toContain("No batch found");
  expect(move([{ batchId: "prd_1", quantity: 1 }])).toContain("tool_error");
  expect(move([{ batchId: "bat_1", quantity: 1 }], { transferDatetime: "2026-11-20" })).toContain("UTC offset");
  expect(move([])).toContain("at least one item");
  // A valid line before a refused one does not move either.
  expect(move([{ batchId: "bat_1", quantity: 5 }, { batchId: "bat_2", quantity: 100000 }])).toContain("tool_error");
  expect(move([{ batchId: "bat_1", quantity: 1 }], { customFields: [{ customFieldId: "cf_1", value: "x" }] })).toContain("unsupported_input");
  expect(error("move-stock", { fromLocationId: "loc_1", items: [] })).toContain("invalid_arguments");
  expect(JSON.stringify(w)).toBe(before);
});

test("search-stock-transfers finds transfers by place, line, date and number", () => {
  const { call, error } = bench();
  expect(call("search-stock-transfers")).toEqual({ items: [], hasMore: false, totalCount: 0 });
  call("move-stock", { fromLocationId: "loc_1", toLocationId: "loc_2", items: [{ batchId: "bat_1", quantity: 20 }], transferDatetime: "2026-11-01T09:00:00-07:00" });
  call("move-stock", { fromLocationId: "loc_1", toLocationId: "loc_3", items: [{ batchId: "bat_2", quantity: 5 }, { productId: "prd_24", quantity: 3 }] });

  expect(ids(call("search-stock-transfers"))).toEqual(["stt_2", "stt_1"]);
  expect(ids(call("search-stock-transfers", { ids: ["1"] }))).toEqual(["stt_1"]);
  expect(ids(call("search-stock-transfers", { search: "st-2" }))).toEqual(["stt_2"]);
  expect(call("search-stock-transfers", { statuses: ["COMPLETED"] }).totalCount).toBe(2);
  expect(call("search-stock-transfers", { statuses: ["TRANSIT", "CANCELED"] }).totalCount).toBe(0);
  expect(ids(call("search-stock-transfers", { fromLocationIds: ["loc_1"], toLocationIds: ["loc_3"] }))).toEqual(["stt_2"]);
  expect(ids(call("search-stock-transfers", { productIds: ["prd_24"] }))).toEqual(["stt_2"]);
  expect(ids(call("search-stock-transfers", { batchIds: ["bat_1"] }))).toEqual(["stt_1"]);
  expect(call("search-stock-transfers", { packageIds: ["pkg_1"] }).totalCount).toBe(0);
  expect(ids(call("search-stock-transfers", { transferDatetimeAfter: "2026-11-02" }))).toEqual(["stt_2"]);
  expect(ids(call("search-stock-transfers", { transferDatetimeBefore: "2026-11-01" }))).toEqual(["stt_1"]);
  // A transfer shows the date it was given, and completes when it is recorded.
  expect(ids(call("search-stock-transfers", { completedAtAfter: "2026-11-23T00:00:00-08:00", completedAtBefore: "2026-11-23" }))).toEqual(["stt_2", "stt_1"]);
  expect(call("search-stock-transfers", { ids: ["stt_1"] }).items[0]).toMatchObject({ transferDatetime: "2026-11-01T08:00:00-08:00", completedAt: "2026-11-23T10:00:00-08:00" });
  expect(call("search-stock-transfers", { completedAtBefore: "2026-11-22" }).totalCount).toBe(0);
  expect(ids(call("search-stock-transfers", { sortBy: { field: "INITIATED_AT", direction: "ASC" } }))).toEqual(["stt_1", "stt_2"]);
  for (const field of ["COMPLETED_AT", "INSERTED_AT", "STOCK_TRANSFER_NUMBER", "UPDATED_AT"]) expect(ids(call("search-stock-transfers", { sortBy: { field, direction: "ASC" } }))).toEqual(["stt_1", "stt_2"]);
  const first = call("search-stock-transfers", { limit: 1 });
  expect(first.hasMore).toBe(true);
  expect(ids(call("search-stock-transfers", { limit: 1, cursor: first.nextCursor }))).toEqual(["stt_1"]);
  expect(call("search-stock-transfers", { ids: ["stt_2"] }).items[0].items.map((i: any) => i.batch?.name ?? null)).toEqual(["LOT-2207", null]);
  expect(error("search-stock-transfers", { transferDatetimeAfter: "yesterday" })).toContain("tool_error");
  expect(error("search-stock-transfers", { customFields: [{ customFieldId: "cf_1", contains: "x" }] })).toContain("unsupported_input");
});

test("report-inventory-assets has a row per holding that adds up to each product's stock", () => {
  const { call, error, world: w } = bench();
  const full = call("report-inventory-assets");
  expect(full.meta).toMatchObject({ report: "Inventory assets", truncated: false, offset: 0 });
  for (const p of w.products) {
    const rows = full.rows.filter((r: any) => r.productId === p.id);
    expect(rows.reduce((n: number, r: any) => n + +r.activeQuantity, 0)).toBe(activeQuantity(w, p));
    expect(rows.every((r: any) => r.trackingMethod === p.tracking && r.unitCostActual === p.unitCost.toFixed(2))).toBe(true);
  }
  expect(full.rows.filter((r: any) => r.productId === "prd_1").map((r: any) => [r.location, r.batchNumber, r.activeQuantity])).toEqual([["Vault", "LOT-2200", "60"], ["Shipping Room", "LOT-2200", "10"]]);
  expect(full.rows.find((r: any) => r.product.startsWith("Sour Diesel Pre-Roll 5-Pack")).product).toBe("Sour Diesel Pre-Roll 5-Pack (INACTIVE)");
  expect(full.rows.find((r: any) => r.trackingMethod === "PACKAGE")).toMatchObject({ labTestingState: "PASSED", license: "Tidewater Distribution" });

  const shipping = call("report-inventory-assets", { locationId: "loc_2" });
  expect(shipping.rows.every((r: any) => r.location === "Shipping Room")).toBe(true);
  expect(call("report-inventory-assets", { productCategoryIds: [w.categories[2]!.id] }).rows.every((r: any) => r.category === "Edibles")).toBe(true);
  const narrow = { productSubcategoryIds: ["sub_1"], productTagIds: ["tag_1"], vendorIds: [w.products[0]!.vendorId!], productGroupIds: ["grp_1"] };
  expect(call("report-inventory-assets", narrow).rows.map((r: any) => r.product)).toEqual(["Blue Dream 3.5g", "Blue Dream 3.5g"]);
  expect(call("report-inventory-assets", { ...narrow, brandIds: ["com_1"] }).rows).toEqual([]);

  const page1 = call("report-inventory-assets", { maxRowsLimit: 40 });
  expect(page1.meta).toMatchObject({ rowLimit: 40, rowCount: 40, totalRowCount: full.rows.length, truncated: true });
  const page2 = call("report-inventory-assets", { maxRowsLimit: 40, cursor: page1.nextCursor });
  expect(page2.meta).toMatchObject({ offset: 40, rowCount: full.rows.length - 40, truncated: false });
  expect(page2.nextCursor).toBeUndefined();
  expect([...page1.rows, ...page2.rows]).toEqual(full.rows);
  expect(error("report-inventory-assets", { snapshotDatetime: "2026-01-01T00:00:00-08:00" })).toContain("unsupported_input");
  expect(error("report-inventory-assets", { maxRowsLimit: 0 })).toContain("tool_error");
});

test("a package-tracked product's packages come from its batch, which holds no stock of its own", () => {
  const { call, world: w } = bench();
  const bd7 = w.products.find((p) => p.name === "Blue Dream 7g")!;
  const lot = w.batches.find((b) => b.productId === bd7.id)!;
  expect(lot.stock).toEqual([]);
  const packages = call("search-packages", { productIds: [bd7.id] }).items;
  expect(packages.every((k: any) => k.batch.id === lot.id && k.batch.name === lot.batchNumber)).toBe(true);
  // The batch's quantity is its active packages', and the product's stock is still counted once, from the packages.
  expect(call("get-batch", { id: lot.id, includeActiveQuantitiesByLocation: true }).batch).toMatchObject({
    quantity: String(activeQuantity(w, bd7)), activeQuantitiesByLocation: [{ location: { name: "Vault" }, quantity: String(activeQuantity(w, bd7)) }],
  });
  expect(call("search-products", { ids: [bd7.id] }).items[0].quantityActive).toBe(String(activeQuantity(w, bd7)));
  // search-batches lists batch-tracked products' batches only, as its page says; Blue Dream 3.5g keeps its batch.
  expect(call("search-batches", { productIds: [bd7.id] }).totalCount).toBe(0);
  expect(call("search-batches", { search: "Blue Dream 3.5g" }).items[0]).toMatchObject({ id: "bat_1", batchNumber: "LOT-2200" });
  const rows = call("report-inventory-assets", { maxRowsLimit: 5000 }).rows.filter((r: any) => r.productId === bd7.id);
  expect(rows.every((r: any) => r.batchId === lot.id && r.packageId !== null)).toBe(true);
});

test("reports refuse more rows per page than the documented 5,000", () => {
  const { call, error } = bench();
  for (const tool of ["report-inventory-assets", "report-inventory-valuation", "report-cogs"]) {
    expect(error(tool, { maxRowsLimit: 5001 })).toBe("tool_error: maxRowsLimit must be between 1 and 5000.");
    expect(call(tool, { maxRowsLimit: 5000 }).meta.rowLimit).toBe(5000);
  }
});

test("search ranks by similarity where the page says so, and finds a typo where it promises a fuzzy match", () => {
  const { call } = bench();
  const names = (tool: string, args: Record<string, unknown>) => call(tool, args).items.map((x: any) => x.name ?? x.product?.name);
  // search-packages: label matches first, then product name or SKU, the name also within a typo.
  expect(names("search-packages", { search: "blue dreem 7g" })).toEqual(["Blue Dream 7g", "Blue Dream 7g"]);
  // search-locations: name similarity, the shortest name holding the term first.
  expect(names("search-locations", { search: "room" })).toEqual(["Veg Room", "Dry Room", "Shipping Room", "Flower Room A", "Processing Room"]);
  // search-batches matches the batch number or the product, a substring only.
  expect(call("search-batches", { search: "LOT-2200" }).items.map((b: any) => b.id)).toEqual(["bat_1"]);
  expect(call("search-batches", { search: "blu dream" }).totalCount).toBe(0);
});
