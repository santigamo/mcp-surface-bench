import { expect, test } from "bun:test";
import { bound, within } from "../src/core/kit.ts";
import { quarter } from "../suites/erp/seed.ts";
import { activeQuantity, availableQuantity, type World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

const cents = (n: number) => Math.round(n * 100);
const total = (rows: any[], key: string) => rows.reduce((n, r) => n + cents(+r[key]), 0);

/** Every row of a report, page by page. */
function allRows(call: (tool: string, args?: Record<string, unknown>) => any, tool: string, args: Record<string, unknown>) {
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const r = call(tool, { ...args, ...(cursor ? { cursor } : {}) });
    rows.push(...r.rows);
    cursor = r.nextCursor;
  } while (cursor);
  return rows;
}

test("report-inventory-valuation answers what the inventory is worth today", () => {
  const { call, world: w } = bench();
  const active = w.products.filter((p) => p.active);
  const r = call("report-inventory-valuation");
  expect(r.meta).toMatchObject({ report: "Inventory valuation", dateRange: "as of 2026-11-23T10:00:00-08:00", rowLimit: 500, offset: 0, rowCount: active.length, totalRowCount: active.length, truncated: false });
  expect(r.nextCursor).toBeUndefined();
  expect(r.meta.columns.map((c: any) => c.key)).not.toContain("activeQuantityPassedTesting");

  // One row per active product, sold-out ones included, with the world's quantities; PRICE is the default.
  expect(r.rows.map((x: any) => x.productId).sort()).toEqual(active.map((p) => p.id).sort());
  for (const p of active) {
    const row = r.rows.find((x: any) => x.productId === p.id);
    expect([row.activeQuantity, row.availableQuantity, row.reservedQuantity]).toEqual([String(activeQuantity(w, p)), String(availableQuantity(w, p)), String(p.reserved)]);
    expect(row.activeValue).toBe((activeQuantity(w, p) * p.unitPrice).toFixed(2));
  }
  expect(r.rows.find((x: any) => x.name === "Gelato 3.5g")).toMatchObject({ activeQuantity: "0", activeValue: "0.00", activeQuantityPassedTesting: "0", inventoryThresholdMin: "60" });
  expect(r.rows.find((x: any) => x.name === "Blue Dream Cartridge 1g")).toMatchObject({ activeQuantity: "110", reservedQuantity: "45", availableQuantity: "65", activeQuantityPassedTesting: null });
  expect(r.rows.map((x: any) => x.name)).not.toContain("Sour Diesel Pre-Roll 5-Pack");

  const byPrice = active.reduce((n, p) => n + cents(activeQuantity(w, p) * p.unitPrice), 0);
  expect(total(r.rows, "activeValue")).toBe(byPrice);
  const byCost = call("report-inventory-valuation", { calculationMethod: "COST" });
  expect(total(byCost.rows, "activeValue")).toBe(active.reduce((n, p) => n + cents(activeQuantity(w, p) * p.unitCost), 0));
  expect(byCost.rows.map((x: any) => x.activeQuantity)).toEqual(r.rows.map((x: any) => x.activeQuantity));
  expect(call("report-inventory-valuation", { calculationMethod: "PRICE" })).toEqual(r);

  const available = r.rows.map((x: any) => +x.availableQuantity);
  expect(available).toEqual([...available].sort((a, b) => b - a));
});

test("report-inventory-valuation pages exactly", () => {
  const { call } = bench();
  const full = call("report-inventory-valuation").rows;
  const first = call("report-inventory-valuation", { maxRowsLimit: 10 });
  expect(first.meta).toMatchObject({ rowLimit: 10, offset: 0, rowCount: 10, totalRowCount: full.length, truncated: true });
  const last = call("report-inventory-valuation", { maxRowsLimit: 10, cursor: Buffer.from("30").toString("base64url") });
  expect(last.meta).toMatchObject({ offset: 30, rowCount: full.length - 30, truncated: false });
  expect(last.nextCursor).toBeUndefined();
  expect(allRows(call, "report-inventory-valuation", { maxRowsLimit: 10 })).toEqual(full);
});

test("report-inventory-valuation narrows stock by location and rows by product", () => {
  const { call, error, world: w } = bench();
  const gummies = w.products.find((p) => p.name === "Watermelon Gummies 100mg")!;
  const inVault = call("report-inventory-valuation", { locationIds: ["loc_1"], search: "watermelon" }).rows;
  expect(inVault).toHaveLength(1);
  expect(inVault[0].activeQuantity).toBe(String(activeQuantity(w, gummies, "loc_1")));
  const both = call("report-inventory-valuation", { locationIds: ["loc_1", "loc_2"], search: "ED-1024" }).rows[0];
  expect(both.activeQuantity).toBe(String(activeQuantity(w, gummies)));
  // Every product keeps its row when a location holds none of it.
  expect(call("report-inventory-valuation", { locationIds: ["loc_6"] }).rows.every((x: any) => x.activeQuantity === "0")).toBe(true);

  const [flower, prerolls] = w.categories as [World["categories"][0], World["categories"][0]];
  const rows = (args: Record<string, unknown>) => call("report-inventory-valuation", args).rows.map((x: any) => x.name).sort();
  expect(rows({ productCategoryIds: [flower.id] })).toHaveLength(8);
  expect(rows({ productCategoryIds: [flower.id], productSubcategoryIds: [flower.subcategories[1]!.id] })).toEqual(["Blue Dream 7g", "Wedding Cake 7g"]);
  expect(rows({ productSubcategoryIds: [prerolls.subcategories[2]!.id] })).toEqual(["Gelato Infused Pre-Roll", "OG Kush Infused Pre-Roll", "Sour Diesel Infused Pre-Roll"]);
  expect(rows({ productTagIds: [w.tags.find((t) => t.name === "Summer promo")!.id] })).toEqual(["Blue Dream Pre-Roll 5-Pack", "Mango Gummies 100mg"]);
  expect(rows({ vendorIds: [w.companies.find((c) => c.name === "Sierra Extracts")!.id] })).toHaveLength(4);
  expect(rows({ brandIds: ["com_1"] })).toEqual([]);
  expect(rows({ productGroupIds: ["grp_2"] }).length).toBe(w.products.filter((p) => p.active && p.groupId === "grp_2").length);

  const incoming = w.purchaseOrders.filter((po) => po.status !== "COMPLETED").flatMap((po) => po.items);
  const ordered = w.products.find((p) => p.id === incoming[0]!.productId)!;
  expect(call("report-inventory-valuation", { search: ordered.sku }).rows[0].incomingQuantity).toBe(String(incoming.filter((i) => i.productId === ordered.id).reduce((n, i) => n + i.quantity, 0)));

  expect(error("report-inventory-valuation", { userIds: ["usr_1"] })).toContain("unsupported_input");
  expect(error("report-inventory-valuation", { maxRowsLimit: 0 })).toContain("tool_error");
  expect(error("report-inventory-valuation", { calculationMethod: "FIFO" })).toContain("invalid_arguments");
  expect(error("report-inventory-valuation", { locationIds: ["prd_1"] })).toContain("tool_error");
  expect(error("report-inventory-valuation", { cursor: "not a cursor" })).toContain("tool_error");
});

test("report-cogs answers the margin by product category last quarter", () => {
  const { call, world: w } = bench();
  const q = quarter(TODAY, 1);
  expect(q).toEqual({ start: "2026-07-01", end: "2026-09-30" });
  const [after, before] = [bound(q.start, "after", w.timezone), bound(q.end, "before", w.timezone)];
  const sold = w.salesOrders.filter((o) => o.status === "COMPLETED" && within(o.orderDatetime, after, before));
  const lines = sold.flatMap((o) => o.items);
  expect(lines.length).toBeGreaterThan(150);
  expect(w.salesOrders.some((o) => o.status === "CANCELED" && within(o.orderDatetime, after, before))).toBe(true);

  const r = call("report-cogs", { orderDatetime: q });
  expect(r.meta).toMatchObject({ report: "Cost of goods sold", dateRange: "ordered 2026-07-01 to 2026-09-30", rowLimit: 500, rowCount: lines.length, totalRowCount: lines.length, truncated: false });
  expect(r.nextCursor).toBeUndefined();
  expect(new Set(r.rows.map((x: any) => x.salesOrderId))).toEqual(new Set(sold.map((o) => o.id)));

  // Margin per category from the rows equals the margin from the order lines.
  const category = (productId: string) => { const p = w.products.find((x) => x.id === productId)!; return w.categories.find((c) => c.id === p.categoryId)!.name; };
  const expected = new Map<string, { price: number; cost: number }>();
  for (const i of lines) {
    const e = expected.get(category(i.productId)) ?? { price: 0, cost: 0 };
    e.price += cents(i.quantity * i.unitPrice); e.cost += cents(i.quantity * i.unitCost);
    expected.set(category(i.productId), e);
  }
  expect(new Set(r.rows.map((x: any) => x.productCategory))).toEqual(new Set(expected.keys()));
  for (const [name, e] of expected) {
    const rows = r.rows.filter((x: any) => x.productCategory === name);
    expect(total(rows, "totalPrice")).toBe(e.price);
    expect(total(rows, "totalCostActual")).toBe(e.cost);
    expect(total(rows, "totalProfitsActual")).toBe(e.price - e.cost);
  }

  const order = sold[0]!, item = order.items[0]!;
  const row = r.rows.find((x: any) => x.salesOrderId === order.id && x.productId === item.productId);
  expect(row).toMatchObject({
    orderNumber: order.orderNumber, finalInput: "Final", costOrigin: null, quantity: String(item.quantity), unitType: "Each",
    unitPrice: item.unitPrice.toFixed(2), totalPrice: (item.quantity * item.unitPrice).toFixed(2), unitCostActual: item.unitCost.toFixed(2),
    profitUnitActual: (item.unitPrice - item.unitCost).toFixed(2), marginActual: String(Math.round(((item.unitPrice - item.unitCost) / item.unitPrice) * 10000) / 10000),
    package: null, batch: null,
  });
});

test("report-cogs keeps Default on the product's configured cost", () => {
  const { call, world: w } = bench();
  const q = { start: "2026-07-01", end: "2026-09-30" };
  const r = call("report-cogs", { orderDatetime: q });
  expect(r.rows.every((x: any) => x.unitCostDefault === x.unitCostActual && x.marginDefault === x.marginActual)).toBe(true);
  const p = w.products.find((x) => x.id === r.rows[0].productId)!;
  p.unitCost += 1;
  const after = call("report-cogs", { orderDatetime: q }).rows[0];
  expect(after.unitCostActual).toBe(r.rows[0].unitCostActual);
  expect(after.unitCostDefault).toBe(p.unitCost.toFixed(2));
});

test("report-cogs defaults to the last 30 days, and a delivery range lifts that default", () => {
  const { call, world: w } = bench();
  const recent = call("report-cogs");
  expect(recent.meta.dateRange).toBe("ordered 2026-10-25 to 2026-11-23");
  const start = bound("2026-10-25", "after", w.timezone)!;
  const expected = w.salesOrders.filter((o) => o.status === "COMPLETED" && Date.parse(o.orderDatetime) >= start).flatMap((o) => o.items).length;
  expect(recent.meta.totalRowCount).toBe(expected);
  expect(call("report-cogs", { orderDatetime: { start: "2026-10-25", end: "2026-11-23" } }).rows).toEqual(recent.rows);

  const delivered = call("report-cogs", { deliveryDatetime: { start: "2026-07-01T00:00:00-07:00", end: "2026-09-30" } });
  expect(delivered.meta.dateRange).toBe("delivered 2026-07-01T00:00:00-07:00 to 2026-09-30");
  const deliveredIn = w.salesOrders.filter((o) => o.status === "COMPLETED" && within(o.deliveryDatetime, bound("2026-07-01", "after", w.timezone), bound("2026-09-30", "before", w.timezone)));
  expect(delivered.meta.totalRowCount).toBe(deliveredIn.flatMap((o) => o.items).length);
  const both = call("report-cogs", { orderDatetime: { start: "2026-09-01" }, deliveryDatetime: { end: "2026-09-30" } });
  expect(both.meta.dateRange).toBe("ordered 2026-09-01 to now; delivered any time to 2026-09-30");
  expect(both.rows.length).toBeGreaterThan(0);
  expect(both.rows.every((x: any) => deliveredIn.some((o) => o.id === x.salesOrderId && o.orderDatetime >= "2026-09-01"))).toBe(true);
});

test("report-cogs pages across a quarter and filters by product", () => {
  const { call, error, world: w } = bench();
  const q = { start: "2026-07-01", end: "2026-09-30" };
  const full = call("report-cogs", { orderDatetime: q }).rows;
  const first = call("report-cogs", { orderDatetime: q, maxRowsLimit: 50 });
  expect(first.meta).toMatchObject({ rowLimit: 50, rowCount: 50, totalRowCount: full.length, truncated: true });
  expect(allRows(call, "report-cogs", { orderDatetime: q, maxRowsLimit: 50 })).toEqual(full);

  const edibles = w.categories[2]!;
  const ofEdibles = call("report-cogs", { orderDatetime: q, productCategoryIds: [edibles.id] }).rows;
  expect(ofEdibles.length).toBe(full.filter((x: any) => x.productCategory === "Edibles").length);
  const gummies = call("report-cogs", { orderDatetime: q, productCategoryIds: [edibles.id], productSubcategoryIds: [edibles.subcategories[0]!.id] }).rows;
  expect(gummies.length).toBeGreaterThan(0);
  expect(gummies.every((x: any) => x.productName.includes("Gummies"))).toBe(true);
  expect(call("report-cogs", { orderDatetime: q, vendorIds: ["com_4"] }).rows.every((x: any) => x.productCategory === "Edibles")).toBe(true);
  expect(call("report-cogs", { orderDatetime: q, productTagIds: ["tag_3"], productGroupIds: ["grp_1", "grp_2"] }).rows.every((x: any) => ["Blue Dream Pre-Roll 5-Pack", "Mango Gummies 100mg"].includes(x.productName))).toBe(true);
  expect(call("report-cogs", { orderDatetime: q, brandIds: ["com_1"] }).rows).toEqual([]);

  expect(error("report-cogs", { orderDatetime: { start: "last quarter" } })).toContain("tool_error");
  expect(error("report-cogs", { orderDatetime: { start: "2026-07-01T00:00:00" } })).toContain("tool_error");
  expect(error("report-cogs", { maxRowsLimit: 0 })).toContain("tool_error");
  expect(error("report-cogs", { orderDatetime: { from: "2026-07-01" } })).toContain("invalid_arguments");
});
