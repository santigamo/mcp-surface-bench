import { expect, test } from "bun:test";
import { addDays } from "../src/core/kit.ts";
import { erp } from "../suites/erp/index.ts";
import { recordAction } from "../suites/erp/tools/shared.ts";
import type { World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

const yesterday = addDays(TODAY, -1);
const orderId = (w: World, number: string) => w.salesOrders.find((o) => o.orderNumber === number)!.id;
/** Logs a write as the MCP write tools do. */
const write = (world: World, records: Parameters<typeof recordAction>[1]) => recordAction({ world, now: erp.clock(TODAY) }, records);

test("get-record-history answers who changed the price on SO-1042, and when", () => {
  const { call, world } = bench();
  const history = call("get-record-history", { recordType: "SALES_ORDER", recordId: orderId(world, "SO-1042") });
  expect(history.totalCount).toBe(6);
  expect(history.hasMore).toBe(false);
  const times = history.items.map((e: any) => Date.parse(e.changedAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(history.items.at(-1).rows[0]).toMatchObject({ entity: "SALES_ORDER", op: "INSERT", rowLabel: null, fields: [] });

  const price = history.items.filter((e: any) => e.rows.some((r: any) => r.fields.some((f: any) => f.field === "priceBase")));
  expect(price).toHaveLength(1);
  expect(price[0]).toMatchObject({
    type: "CHANGE", actor: { id: "usr_3", name: "Priya Nair", companyName: null }, source: "WEB", sourceDetail: null, rowCount: 1, truncated: false, events: [],
    rows: [{ entity: "ORDER_ITEM", entityLabel: "Order item", op: "UPDATE", rowLabel: "Wedding Cake 3.5g", fields: [{ field: "priceBase", label: "Price", oldValue: "24.00", newValue: "19.50" }] }],
  });
  // The order line keeps its id, which the sales order tools print.
  expect(price[0].rows[0].rowId).toBe(world.salesOrders.find((o) => o.orderNumber === "SO-1042")!.items[0]!.id);
  expect(price[0].changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T14:37:00-0[78]:00$/);
  const own = history.items.find((e: any) => e.rows[0].entity === "SALES_ORDER" && e.rows[0].op === "UPDATE").rows[0];
  expect(own.rowId).toBe(orderId(world, "SO-1042"));
});

test("get-record-history sorts, pages and takes bare ids", () => {
  const { call, world } = bench();
  const id = orderId(world, "SO-1042");
  const oldest = call("get-record-history", { recordType: "SALES_ORDER", recordId: id, sortBy: { field: "CHANGED_AT", direction: "ASC" } });
  expect(oldest.items[0].rows[0].op).toBe("INSERT");
  const first = call("get-record-history", { recordType: "SALES_ORDER", recordId: id.split("_")[1], limit: 4 });
  expect([first.items.length, first.hasMore]).toEqual([4, true]);
  const rest = call("get-record-history", { recordType: "SALES_ORDER", recordId: id.split("_")[1], limit: 4, cursor: first.nextCursor });
  expect(rest.items.map((e: any) => e.id)).toEqual(oldest.items.slice(0, 2).map((e: any) => e.id).reverse());
  const product = world.products.find((p) => p.name === "Mango Gummies 100mg")!;
  const gummies = call("get-record-history", { recordType: "PRODUCT", recordId: product.id });
  expect(gummies.items).toHaveLength(1);
  expect(gummies.items[0]).toMatchObject({ actor: null, source: "PUBLIC_API", sourceDetail: "API key: storefront sync" });
  expect(call("get-record-history", { recordType: "PLANT_GROUP", recordId: "plg_1" }).items).toEqual([]);
});

test("get-record-history refuses a record that does not exist", () => {
  const { error } = bench();
  expect(error("get-record-history", { recordType: "SALES_ORDER", recordId: "so_9999" })).toBe("tool_error: No sales order found with id so_9999.");
  expect(error("get-record-history", { recordType: "TEARDOWN", recordId: "1" })).toContain("tool_error: No teardown found");
  expect(error("get-record-history", { recordType: "SALES_ORDER", recordId: "SO-1042" })).toContain("tool_error");
  expect(error("get-record-history", { recordType: "SALES_ORDER", recordId: "prd_1" })).toContain("tool_error");
  expect(error("get-record-history", { recordType: "SALES_ORDER" })).toContain("invalid_arguments");
  expect(error("get-record-history", { recordType: "CONTACT", recordId: "con_1" })).toContain("invalid_arguments");
});

test("search-activity answers what the public API changed yesterday", () => {
  const { call } = bench();
  const r = call("search-activity", { sources: ["PUBLIC_API"], changedAt: { start: yesterday, end: yesterday } });
  expect(r.totalCount).toBe(4);
  const records = r.items.flatMap((e: any) => e.records);
  expect(records.map((x: any) => [x.type, x.name, x.op, x.changedFields]).sort()).toEqual([
    ["COMPANY", "Greenleaf Collective", "UPDATE", ["phone"]],
    ["PRODUCT", "Gelato Cartridge 1g", "UPDATE", ["unitPrice"]],
    ["PRODUCT", "Mango Gummies 100mg", "UPDATE", ["unitPrice"]],
    ["SALES_ORDER", "SO-4509", "INSERT", []],
  ]);
  for (const e of r.items) {
    expect(e).toMatchObject({ actor: null, impersonator: null, source: "PUBLIC_API", rowCount: 1, truncated: false });
    expect(e.recordCounts).toEqual([{ type: e.records[0].type, count: 1 }]);
  }
  // The public API's actions the day before and today fall outside the range, at either end.
  const around = call("search-activity", { sources: ["PUBLIC_API"], changedAt: { start: addDays(TODAY, -2), end: TODAY } });
  expect(around.totalCount).toBe(6);
  expect(call("search-activity", { changedAt: { start: yesterday, end: yesterday } }).totalCount).toBe(6);
});

test("search-activity filters by op, record type, user, source, id and instant", () => {
  const { call, world } = bench();
  const day = { start: yesterday, end: yesterday };
  expect(call("search-activity", { changedAt: day, ops: ["INSERT"] }).items.map((e: any) => e.records[0].name)).toEqual(["SO-4509"]);
  expect(call("search-activity", { changedAt: day, recordTypes: ["PRODUCT"] }).totalCount).toBe(3);
  expect(call("search-activity", { changedAt: day, recordTypes: ["PRODUCT"], sources: ["PUBLIC_API"] }).totalCount).toBe(2);
  expect(call("search-activity", { changedAt: day, sources: ["MCP"] }).items[0].records[0].changedFields).toEqual(["quantityAvailableThresholdMin"]);
  expect(call("search-activity", { changedAt: day, userIds: ["usr_2"] }).items.map((e: any) => e.actor.name)).toEqual(["Daniel Reyes"]);
  expect(call("search-activity", { changedAt: { start: `${yesterday}T06:00:00-08:00`, end: `${yesterday}T07:00:00-08:00` } }).totalCount).toBe(2);
  // Asked for by id, an action is found whenever it ran, and names its line's fields.
  const priceAction = world.actions.find((a) => a.records.some((r) => r.fields.some((f) => f.field === "priceBase")))!;
  const found = call("search-activity", { ids: [priceAction.id.split("_")[1]] });
  expect(found.items[0].records).toEqual([{ type: "SALES_ORDER", id: orderId(world, "SO-1042"), name: "SO-1042", op: "UPDATE", changedFields: ["orderItem.priceBase"], rowCount: 1, truncated: false }]);
  expect(call("search-activity", { ids: [priceAction.id], changedAt: day }).totalCount).toBe(0);
});

test("search-activity defaults to the last 7 days, newest first, and pages", () => {
  const { call } = bench();
  const recent = call("search-activity");
  expect(recent.totalCount).toBe(8);
  expect([recent.items.length, recent.hasMore]).toEqual([8, false]);
  expect(recent.items[0].changedAt.startsWith(TODAY)).toBe(true);
  const first = call("search-activity", { limit: 5 });
  expect(first.hasMore).toBe(true);
  expect(call("search-activity", { limit: 5, cursor: first.nextCursor }).items).toHaveLength(3);
  expect(call("search-activity", { sortBy: { field: "CHANGED_AT", direction: "ASC" } }).items[0].changedAt.startsWith(addDays(TODAY, -2))).toBe(true);
  expect(call("search-activity", { changedAt: { end: TODAY } }).totalCount).toBe(8);
  expect(call("search-activity", { changedAt: { start: addDays(TODAY, -367) } }).totalCount).toBe(8);
  expect(call("search-activity", { changedAt: { start: addDays(TODAY, -410), end: addDays(TODAY, -45) } }).totalCount).toBe(6);
});

test("search-activity refuses ranges the documentation does not allow", () => {
  const { error } = bench();
  expect(error("search-activity", { changedAt: { start: addDays(TODAY, -368) } })).toContain("tool_error");
  expect(error("search-activity", { changedAt: { start: "2025-01-01", end: "2026-01-02" } })).toContain("tool_error");
  expect(error("search-activity", { changedAt: { start: TODAY, end: yesterday } })).toContain("tool_error");
  expect(error("search-activity", { changedAt: { start: "yesterday" } })).toContain("tool_error");
  expect(error("search-activity", { ids: ["so_1"] })).toContain("tool_error");
  expect(error("search-activity", { userIds: ["com_1"] })).toContain("tool_error");
  expect(error("search-activity", { sources: ["API"] })).toContain("invalid_arguments");
  expect(error("search-activity", { sortBy: { field: "ID", direction: "ASC" } })).toContain("invalid_arguments");
  // 366 whole days are allowed.
  expect(bench().call("search-activity", { changedAt: { start: "2025-01-01", end: "2026-01-01" } }).totalCount).toBe(6);
});

test("both tools show what the MCP write tools logged", () => {
  const { call, world } = bench();
  const so = orderId(world, "SO-4512");
  const line = world.salesOrders.find((o) => o.id === so)!.items[0]!.id;
  write(world, [
    { type: "SALES_ORDER", id: so, name: "SO-4512", entity: "ORDER_ITEM", rowId: line, op: "UPDATE", rowLabel: "Blue Dream 7g", fields: [{ field: "quantity", label: "Quantity", oldValue: "60", newValue: "50" }] },
    { type: "SALES_ORDER", id: so, name: "SO-4512", entity: "SALES_ORDER", rowId: so, op: "UPDATE", rowLabel: null, fields: [{ field: "internalNotes", label: "Internal notes", oldValue: null, newValue: "Short 10" }] },
  ]);
  const latest = call("get-record-history", { recordType: "SALES_ORDER", recordId: so }).items[0];
  expect(latest).toMatchObject({ actor: { id: "usr_1", name: "Maya Okafor" }, source: "MCP", rowCount: 2 });
  expect(latest.rows.map((r: any) => [r.entity, r.rowLabel])).toEqual([["SALES_ORDER", null], ["ORDER_ITEM", "Blue Dream 7g"]]);
  const feed = call("search-activity", { sources: ["MCP"], changedAt: { start: TODAY, end: TODAY } });
  expect(feed.items[0].records).toEqual([{ type: "SALES_ORDER", id: so, name: "SO-4512", op: "UPDATE", changedFields: ["orderItem.quantity", "internalNotes"], rowCount: 2, truncated: false }]);
});

test("what the write tools log shows in the history of the record it belongs to", () => {
  const { call, world } = bench();
  const po = world.purchaseOrders.find((p) => p.purchaseNumber === "PO-1182")!;
  // A purchase payment is a line of its purchase order.
  const { purchasePayment } = call("create-purchase-payment", { purchaseId: po.id, amount: 2500, paymentMethodId: world.paymentMethods[0]!.id });
  const paid = call("get-record-history", { recordType: "PURCHASE", recordId: po.id }).items[0];
  expect(paid.rows).toEqual([{ entity: "PURCHASE_PAYMENT", entityLabel: "Purchase payment", op: "INSERT", rowId: purchasePayment.id, rowLabel: purchasePayment.paymentNumber, fields: expect.any(Array) }]);
  expect(call("search-activity", { ids: [paid.id] }).items[0].records).toMatchObject([{ type: "PURCHASE", id: po.id, name: "PO-1182", op: "UPDATE", changedFields: expect.arrayContaining(["purchasePayment.amount"]) }]);
  // A contact is a line of its company.
  const sunset = world.companies.find((c) => c.name === "Sunset Dispensary")!;
  const { contact } = call("mutate-company-contact", { action: "CREATE", companyId: sunset.id, firstName: "Jane", lastName: "Lee", title: "Purchasing manager" });
  expect(call("get-record-history", { recordType: "COMPANY", recordId: sunset.id }).items[0].rows[0]).toMatchObject({ entity: "CONTACT", op: "INSERT", rowId: contact.id, rowLabel: "Jane Lee" });
  // An emailed invoice keeps the addresses; a manifest is a COMPLIANCE_TRANSFER, found by its number.
  const invoice = world.invoices.find((i) => i.invoiceNumber === "INV-4512")!;
  call("email-pdf", { document: "INVOICE", id: invoice.id, emailAddresses: ["noah.kim@baysidebotanicals.example"] });
  expect(call("get-record-history", { recordType: "INVOICE", recordId: invoice.id }).items[0].rows).toEqual([
    { entity: "INVOICE_RECIPIENT_EMAIL", entityLabel: "Invoice recipient email", op: "INSERT", rowLabel: "noah.kim@baysidebotanicals.example", fields: [{ field: "email", label: "Email", oldValue: null, newValue: "noah.kim@baysidebotanicals.example" }] },
  ]);
  call("email-pdf", { document: "METRC_MANIFEST", id: "0001234567", emailAddresses: ["receiving@tidewatercannabis.example"] });
  expect(call("get-record-history", { recordType: "COMPLIANCE_TRANSFER", recordId: "0001234567" }).items).toHaveLength(1);
  const feed = call("search-activity", { sources: ["MCP"], recordTypes: ["PURCHASE", "COMPLIANCE_TRANSFER", "COMPANY", "INVOICE"] });
  expect(feed.items.map((e: any) => e.records[0].type).sort()).toEqual(["COMPANY", "COMPLIANCE_TRANSFER", "INVOICE", "PURCHASE"]);
});

test("search-activity counts every record past the 50-row cap, and shows a deleted record by its last name", () => {
  const { call, world } = bench();
  const tags = Array.from({ length: 52 }, (_, i) => ({ type: "TAG" as const, id: `tag_${100 + i}`, name: `Promo ${i}`, entity: "TAG" as const, rowId: `tag_${100 + i}`, op: "INSERT" as const, rowLabel: null, fields: [] }));
  write(world, tags);
  const big = call("search-activity", { sources: ["MCP"], changedAt: { start: TODAY } }).items[0];
  expect([big.rowCount, big.truncated, big.records.length, big.recordCounts]).toEqual([52, true, 50, [{ type: "TAG", count: 52 }]]);

  const product = world.products.find((p) => p.name === "Gelato Cartridge 1g")!;
  world.products = world.products.filter((p) => p !== product);
  const gone = call("search-activity", { recordTypes: ["PRODUCT"], changedAt: { start: yesterday, end: yesterday }, sources: ["PUBLIC_API"] });
  expect(gone.items.map((e: any) => [e.records[0].type, e.records[0].name])).toContainEqual([null, "Gelato Cartridge 1g"]);
  expect(call("get-record-history", { recordType: "PRODUCT", recordId: product.id }).items).toHaveLength(1);
});
