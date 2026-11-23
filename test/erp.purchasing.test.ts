import { describe, expect, test } from "bun:test";
import { purchaseMoney, purchaseTotal, type World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

const YEAR_START = `${TODAY.slice(0, 4)}-01-01`;
const po = (w: World, number: string) => w.purchaseOrders.find((p) => p.purchaseNumber === number)!;
const thisYear = (w: World) => w.purchaseOrders.filter((p) => p.orderDatetime >= YEAR_START);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe("search-purchase-orders", () => {
  test("lists every purchase across pages, newest change first", () => {
    const { call, world } = bench();
    const first = call("search-purchase-orders");
    expect(first.totalCount).toBe(28);
    expect(first.items).toHaveLength(10);
    const seen = [...first.items];
    for (let r = first; r.hasMore; ) { r = call("search-purchase-orders", { cursor: r.nextCursor }); seen.push(...r.items); }
    expect(new Set(seen.map((p: any) => p.id)).size).toBe(28);
    expect(seen[0].purchaseNumber).toBe("PO-1180");
    expect(call("search-purchase-orders", { limit: 100 }).hasMore).toBe(false);
    const item = first.items.find((p: any) => p.purchaseNumber === "PO-1180");
    expect(item.supplier.name).toBe("Mendocino Gold Growers");
    expect(item.intakeLocation.name).toBe("Vault");
    expect(item.owner.profile.fullName).toBe("Tom Becker");
    expect(item.total).toBe(purchaseTotal(po(world, "PO-1180")).toFixed(2));
  });

  test("finds PO-1182 from its number, and not PO-1128", () => {
    const { call } = bench();
    const r = call("search-purchase-orders", { search: "1182" });
    expect(r.items.map((p: any) => p.purchaseNumber)).toEqual(["PO-1182"]);
    expect(r.items[0].paymentStatus).toBe("PARTIALLY_PAID");
    expect(call("search-purchase-orders", { search: "po-11", limit: 100 }).totalCount).toBe(28);
    expect(call("search-purchase-orders", { search: "PO-1128" }).items.map((p: any) => p.purchaseNumber)).toEqual(["PO-1128"]);
  });

  test("paymentStatus splits the purchases as purchaseMoney does", () => {
    const { call, world } = bench();
    const numbers = (status: string) => call("search-purchase-orders", { paymentStatus: [status], limit: 100 }).items.map((p: any) => p.purchaseNumber).sort();
    const expected = (status: string) => world.purchaseOrders.filter((p) => purchaseMoney(world, p).status === status).map((p) => p.purchaseNumber).sort();
    expect(numbers("NOT_PAID")).toEqual(["PO-1178", "PO-1179", "PO-1180"]);
    expect(numbers("PARTIALLY_PAID")).toEqual(["PO-1177", "PO-1182"]);
    expect(numbers("OVER_PAID")).toEqual(["PO-1176"]);
    expect(numbers("PAID")).toHaveLength(22);
    for (const s of ["NOT_PAID", "PARTIALLY_PAID", "OVER_PAID", "PAID"]) expect(numbers(s)).toEqual(expected(s));
    expect(call("search-purchase-orders", { paymentStatus: ["NOT_PAID", "PARTIALLY_PAID", "OVER_PAID"] }).totalCount).toBe(6);
  });

  test("filters by ids, status, supplier, owner, product, dates and total", () => {
    const { call, world } = bench();
    const count = (args: Record<string, unknown>) => call("search-purchase-orders", args).totalCount;
    const p1182 = po(world, "PO-1182");
    expect(call("search-purchase-orders", { ids: [p1182.id.split("_")[1]] }).items[0].purchaseNumber).toBe("PO-1182");
    expect(count({ status: ["PROCESSING", "DELIVERING"] })).toBe(2);
    expect(count({ status: ["DRAFT"] })).toBe(0);
    expect(count({ supplierIds: ["com_1"] })).toBe(world.purchaseOrders.filter((p) => p.vendorId === "com_1").length);
    expect(count({ ownerIds: ["usr_4"] })).toBe(28);
    expect(count({ ownerIds: ["usr_1"] })).toBe(0);
    const blueDream7g = world.products.find((p) => p.name === "Blue Dream 7g")!.id;
    expect(count({ productIds: [blueDream7g] })).toBe(world.purchaseOrders.filter((p) => p.items.some((i) => i.productId === blueDream7g)).length);
    expect(count({ orderDateAfter: YEAR_START })).toBe(23);
    expect(count({ orderDateBefore: "2025-12-31" })).toBe(5);
    expect(count({ dueDateAfter: TODAY })).toBe(world.purchaseOrders.filter((p) => p.dueDatetime.slice(0, 10) >= TODAY).length);
    expect(count({ dueDateBefore: "2026-01-01T00:00:00-08:00" })).toBe(world.purchaseOrders.filter((p) => Date.parse(p.dueDatetime) <= Date.parse("2026-01-01T00:00:00-08:00")).length);
    expect(count({ totalGreaterThanOrEqualTo: 6400, totalLessThanOrEqualTo: 6400 })).toBe(1);
  });

  test("sorts by each documented field", () => {
    const { call } = bench();
    const numbers = (field: string, direction: string) => call("search-purchase-orders", { sortBy: { field, direction }, limit: 3 }).items.map((p: any) => p.purchaseNumber);
    expect(numbers("PURCHASE_NUMBER", "ASC")).toEqual(["PO-1128", "PO-1155", "PO-1156"]);
    expect(numbers("ORDER_DATE", "ASC")).toEqual(["PO-1128", "PO-1155", "PO-1156"]);
    expect(numbers("INSERTED_AT", "DESC")[0]).toBe("PO-1180");
    expect(numbers("DUE_DATE", "DESC")[0]).toBe("PO-1180");
    expect(numbers("UPDATED_AT", "ASC")[0]).toBe("PO-1128");
  });

  test("refuses what it should", () => {
    const { error } = bench();
    expect(error("search-purchase-orders", { supplierIds: ["usr_1"] })).toContain("tool_error");
    expect(error("search-purchase-orders", { orderDateAfter: "2026-01-01T00:00:00" })).toContain("tool_error");
    expect(error("search-purchase-orders", { limit: 101 })).toContain("tool_error");
    expect(error("search-purchase-orders", { cursor: "nope" })).toContain("tool_error");
    expect(error("search-purchase-orders", { batchIds: ["bat_1"] })).toContain("unsupported_input");
    expect(error("search-purchase-orders", { paymentStatus: ["UNPAID"] })).toContain("invalid_arguments");
  });
});

describe("get-purchase-order", () => {
  test("returns the header, and the line items, charges and payments when asked", () => {
    const { call, world } = bench();
    const id = po(world, "PO-1182").id;
    const bare = call("get-purchase-order", { id }).purchaseOrder;
    expect(bare).toMatchObject({ purchaseNumber: "PO-1182", total: "6400.00", paid: "1000.00", paymentStatus: "PARTIALLY_PAID", supplier: { name: "Humboldt Family Farms" } });
    expect(bare.orderItems).toBeUndefined();
    expect(bare.payments).toBeUndefined();
    const full = call("get-purchase-order", { id, includeOrderItems: true, includeOrderCharges: true, includePayments: true }).purchaseOrder;
    expect(full.orderItems).toHaveLength(1);
    expect(full.orderItems[0]).toMatchObject({ quantity: "250", receivedQuantity: "250", price: "25.60", product: { name: "Blue Dream 7g" } });
    expect(full.orderCharges).toEqual([]);
    expect(full.payments.map((p: any) => p.amount)).toEqual(["1000.00"]);
    const processing = call("get-purchase-order", { id: po(world, "PO-1180").id, includeOrderItems: true }).purchaseOrder;
    expect(processing.orderItems.every((i: any) => i.receivedQuantity === "0")).toBe(true);
  });

  test("answers an unknown id with null and refuses another kind of id", () => {
    const { call, error } = bench();
    expect(call("get-purchase-order", { id: "po_999" }).purchaseOrder).toBeNull();
    expect(error("get-purchase-order", { id: "so_1" })).toContain("tool_error");
    expect(error("get-purchase-order", {})).toContain("invalid_arguments");
  });
});

describe("purchase payments", () => {
  test("search-purchase-payments lists posted payments, latest first, across pages", () => {
    const { call, world } = bench();
    const first = call("search-purchase-payments");
    expect(first.totalCount).toBe(world.purchasePayments.length);
    expect(first.hasMore).toBe(true);
    const second = call("search-purchase-payments", { cursor: first.nextCursor });
    expect(second.items[0].id).not.toBe(first.items[0].id);
    const dates = first.items.map((p: any) => Date.parse(p.paymentDate));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(first.items[0].status).toBe("POSTED");
  });

  test("search-purchase-payments filters", () => {
    const { call, world } = bench();
    const count = (args: Record<string, unknown>) => call("search-purchase-payments", args).totalCount;
    const p1182 = po(world, "PO-1182");
    const r = call("search-purchase-payments", { purchaseIds: [p1182.id] });
    expect(r.items.map((p: any) => [p.amount, p.purchase.paymentStatus, p.purchase.paid, p.purchase.total, p.supplier.name])).toEqual([["1000.00", "PARTIALLY_PAID", "1000.00", "6400.00", "Humboldt Family Farms"]]);
    expect(count({ supplierIds: ["com_1"] })).toBe(world.purchasePayments.filter((p) => world.purchaseOrders.find((o) => o.id === p.purchaseId)!.vendorId === "com_1").length);
    expect(count({ amountMin: "1000", amountMax: 1000 })).toBe(1);
    expect(count({ paymentMethodIds: ["pmm_1"] })).toBe(world.purchasePayments.length);
    expect(count({ paymentMethodIds: ["pmm_2"] })).toBe(0);
    expect(count({ paymentDateAfter: TODAY })).toBe(0);
    expect(count({ paymentDateBefore: "2025-12-31" })).toBe(world.purchasePayments.filter((p) => p.paymentDatetime < "2026").length);
    expect(count({ status: "VOIDED" })).toBe(0);
    expect(count({ status: "ALL" })).toBe(world.purchasePayments.length);
    const one = call("search-purchase-payments", { limit: 1 }).items[0];
    expect(count({ paymentNumber: one.paymentNumber })).toBe(1);
    expect(count({ search: "PO-1182" })).toBe(1);
    expect(count({ search: "humbolt" })).toBe(count({ supplierIds: ["com_1"] }));
    expect(count({ search: "PO-11_2" })).toBeGreaterThan(1);
    const sortedByNumber = call("search-purchase-payments", { sortBy: { field: "PAYMENT_NUMBER", direction: "ASC" }, limit: 2 }).items.map((p: any) => p.paymentNumber);
    expect(sortedByNumber).toEqual(["PMT-1", "PMT-10"]);
    for (const field of ["INSERTED_AT", "UPDATED_AT", "PAYMENT_DATE"]) expect(call("search-purchase-payments", { sortBy: { field, direction: "ASC" } }).items).toHaveLength(10);
  });

  test("search-purchase-payments refuses a bad amount", () => {
    const { error } = bench();
    expect(error("search-purchase-payments", { amountMin: "lots" })).toContain("tool_error");
    expect(error("search-purchase-payments", { purchaseIds: ["com_1"] })).toContain("tool_error");
  });

  test("get-purchase-payment returns one payment, and null for an unknown or invoice payment id", () => {
    const { call, world } = bench();
    const payment = world.purchasePayments[0]!;
    expect(call("get-purchase-payment", { id: payment.id }).purchasePayment).toMatchObject({ id: payment.id, amount: payment.amount.toFixed(2), paymentMethod: { name: "ACH" } });
    expect(call("get-purchase-payment", { id: "ppy_999" }).purchasePayment).toBeNull();
    expect(call("get-purchase-payment", { id: "ipy_1" }).purchasePayment).toBeNull();
  });
});

describe("create-purchase-payment", () => {
  test("records $2,500 against PO-1182", () => {
    const { call, world } = bench();
    const p1182 = po(world, "PO-1182");
    const before = { payments: world.purchasePayments.length, actions: world.actions.length };
    const r = call("create-purchase-payment", { purchaseId: p1182.id, amount: "2500", paymentMethodId: "pmm_2", note: "Second installment" }).purchasePayment;
    expect(r).toMatchObject({ amount: "2500.00", status: "POSTED", note: "Second installment", paymentMethod: { id: "pmm_2", name: "Check" } });
    expect(r.purchase).toEqual({ id: p1182.id, purchaseNumber: "PO-1182", paymentStatus: "PARTIALLY_PAID", paid: "3500.00", total: "6400.00" });
    expect(r.paymentDate).toBe("2026-11-23T10:00:00-08:00");
    expect(world.purchasePayments).toHaveLength(before.payments + 1);
    expect(world.purchasePayments.at(-1)).toMatchObject({ id: r.id, paymentNumber: r.paymentNumber, purchaseId: p1182.id, amount: 2500, paymentMethodId: "pmm_2", recordedAt: "2026-11-23T10:00:00-08:00", voidedAt: null });
    expect(r).toMatchObject({ insertedAt: "2026-11-23T10:00:00-08:00", updatedAt: "2026-11-23T10:00:00-08:00", voidedAt: null });
    expect(world.actions).toHaveLength(before.actions + 1);
    // A payment is a line of its purchase order, so it shows in the order's history and moves its updatedDate.
    expect(world.actions.at(-1)!.records[0]).toMatchObject({ type: "PURCHASE", id: p1182.id, name: "PO-1182", entity: "PURCHASE_PAYMENT", rowId: r.id, op: "INSERT", rowLabel: r.paymentNumber });
    expect(call("get-purchase-order", { id: p1182.id }).purchaseOrder.updatedDate).toBe("2026-11-23T10:00:00-08:00");
    expect(call("get-purchase-payment", { id: r.id }).purchasePayment).toEqual(r);
    expect(call("get-purchase-order", { id: p1182.id }).purchaseOrder.paid).toBe("3500.00");
  });

  test("takes a payment date and marks an overpayment", () => {
    const { call, world } = bench();
    const r = call("create-purchase-payment", { purchaseId: po(world, "PO-1182").id, amount: 5500, paymentMethodId: "1", paymentDate: "2026-11-20T17:00:00Z" }).purchasePayment;
    expect(r.paymentDate).toBe("2026-11-20T09:00:00-08:00");
    expect(r.insertedAt).toBe("2026-11-23T10:00:00-08:00"); // recorded now, paid three days ago
    expect(r.purchase.paymentStatus).toBe("OVER_PAID");
  });

  test("refuses what its page says it checks, and leaves the world untouched", () => {
    const { error, world } = bench();
    const id = po(world, "PO-1182").id;
    const before = JSON.stringify(world);
    expect(error("create-purchase-payment", { purchaseId: "po_999", amount: 2500, paymentMethodId: "pmm_1" })).toContain("No purchase order");
    expect(error("create-purchase-payment", { purchaseId: id, amount: 2500, paymentMethodId: "pmm_9" })).toContain("No payment method");
    expect(error("create-purchase-payment", { purchaseId: id, amount: 0, paymentMethodId: "pmm_1" })).toContain("more than $0");
    expect(error("create-purchase-payment", { purchaseId: id, amount: "$2,500", paymentMethodId: "pmm_1" })).toContain("tool_error");
    expect(error("create-purchase-payment", { purchaseId: id, amount: 10.005, paymentMethodId: "pmm_1" })).toContain("cents");
    expect(error("create-purchase-payment", { purchaseId: id, amount: 2500, paymentMethodId: "pmm_1", paymentDate: "2026-11-20" })).toContain("tool_error");
    expect(error("create-purchase-payment", { purchaseId: id, amount: 2500, paymentMethodId: "pmm_1", qbPaymentAccount: "Checking" })).toContain("QuickBooks");
    expect(error("create-purchase-payment", { purchaseId: id, amount: 2500 })).toContain("invalid_arguments");
    world.purchaseOrders.find((p) => p.id === id)!.status = "DRAFT";
    expect(error("create-purchase-payment", { purchaseId: id, amount: 2500, paymentMethodId: "pmm_1" })).toContain("DRAFT");
    world.purchaseOrders.find((p) => p.id === id)!.status = "COMPLETED";
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("report-purchase-totals", () => {
  test("per VENDOR over this year totals the purchases placed this year, biggest first", () => {
    const { call, world } = bench();
    const r = call("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: { start: YEAR_START, end: TODAY } });
    const purchases = thisYear(world);
    expect(world.purchaseOrders.length - purchases.length).toBe(5);
    expect(r.meta).toMatchObject({ report: "Purchase totals by vendor", dateRange: `orderDatetime ${YEAR_START} to ${TODAY}`, totalRowCount: 6, truncated: false });
    expect(r.meta.columns.map((c: any) => c.key)).toContain("totalPurchases");
    for (const row of r.rows) {
      const theirs = purchases.filter((p) => p.vendorId === row.vendorId);
      expect(row.totalPurchases).toBe(sum(theirs.map(purchaseTotal)).toFixed(2));
      expect(row.purchaseOrderCount).toBe(String(theirs.length));
      expect(row.relationshipType).toBe("Vendor");
      expect(row.productOwner).toBe("Tom Becker");
    }
    expect(sum(r.rows.map((x: any) => +x.totalPurchases)).toFixed(2)).toBe(sum(purchases.map(purchaseTotal)).toFixed(2));
    const totals = r.rows.map((x: any) => +x.totalPurchases);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    const humboldt = r.rows.find((x: any) => x.name === "Humboldt Family Farms");
    expect(humboldt.lastPurchaseDate).toBe("11/2/2026");
  });

  test("agrees with report-purchase-order-history and search-purchase-orders over the same range", () => {
    const { call } = bench();
    const range = { start: YEAR_START, end: TODAY };
    const vendors = call("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: range }).rows;
    const history = call("report-purchase-order-history", { orderDatetime: range }).rows;
    const search = call("search-purchase-orders", { orderDateAfter: YEAR_START, orderDateBefore: TODAY, limit: 100 }).items;
    const total = (xs: string[]) => sum(xs.map(Number)).toFixed(2);
    expect(total(history.map((x: any) => x.amount))).toBe(total(vendors.map((x: any) => x.totalPurchases)));
    expect(total(search.map((x: any) => x.total))).toBe(total(vendors.map((x: any) => x.totalPurchases)));
    expect(history).toHaveLength(23);
  });

  test("defaults to the last 30 days", () => {
    const { call, world } = bench();
    const r = call("report-purchase-totals", { rowsPer: "VENDOR" });
    expect(r.meta.dateRange).toBe("orderDatetime 2026-10-25 to 2026-11-23");
    const recent = world.purchaseOrders.filter((p) => p.orderDatetime.slice(0, 10) >= "2026-10-25");
    expect(sum(r.rows.map((x: any) => +x.totalPurchases)).toFixed(2)).toBe(sum(recent.map(purchaseTotal)).toFixed(2));
  });

  test("per PRODUCT sums quantity and spend over the line items", () => {
    const { call, world } = bench();
    const r = call("report-purchase-totals", { rowsPer: "PRODUCT", orderDatetime: { start: YEAR_START, end: TODAY } });
    const items = thisYear(world).flatMap((p) => p.items);
    expect(sum(r.rows.map((x: any) => +x.totalPurchased)).toFixed(2)).toBe(sum(thisYear(world).map(purchaseTotal)).toFixed(2));
    const bd7 = r.rows.find((x: any) => x.name === "Blue Dream 7g");
    expect(bd7.quantityPurchased).toBe(String(sum(items.filter((i) => i.productId === bd7.productId).map((i) => i.quantity))));
    expect(bd7).toMatchObject({ category: "Flower", subcategory: "Quarters", unitType: "Each", salePrice: "40.00" });
  });

  test("honours the PRODUCT filters, owners, vendor groups and paging", () => {
    const { call } = bench();
    const all = { start: "2025-01-01", end: TODAY };
    const rows = (args: Record<string, unknown>) => call("report-purchase-totals", { rowsPer: "PRODUCT", orderDatetime: all, ...args }).rows;
    expect(rows({ productCategoryIds: ["cat_3"] }).every((x: any) => x.category === "Edibles")).toBe(true);
    expect(rows({ productSubcategoryIds: ["sub_1"] }).every((x: any) => x.subcategory === "Eighths")).toBe(true);
    expect(rows({ vendorIds: ["com_4"] }).every((x: any) => x.vendor === "Sweet Leaf Confections")).toBe(true);
    expect(rows({ productTagIds: ["tag_1"] }).length).toBeGreaterThan(0);
    expect(rows({ brandIds: ["com_1"] })).toEqual([]);
    expect(rows({ productGroupIds: ["grp_1"] }).every((x: any) => x.group === "House brand")).toBe(true);
    expect(rows({ locationIds: ["loc_1"] }).length).toBe(rows({}).length);
    expect(rows({ locationIds: ["loc_2"] })).toEqual([]);
    expect(rows({ ownerIds: ["usr_1"] })).toEqual([]);
    expect(call("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: all, vendorGroupIds: ["cgr_1"] }).rows).toEqual([]);
    const first = call("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: all, maxRowsLimit: 4 });
    expect(first.meta).toMatchObject({ rowCount: 4, totalRowCount: 6, truncated: true });
    const next = call("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: all, maxRowsLimit: 4, cursor: first.nextCursor });
    expect(next.meta).toMatchObject({ offset: 4, rowCount: 2, truncated: false });
    expect(next.nextCursor).toBeUndefined();
  });

  test("refuses filters of the other rowsPer and bad ranges", () => {
    const { error } = bench();
    expect(error("report-purchase-totals", { rowsPer: "VENDOR", productCategoryIds: ["cat_1"] })).toContain("only when rowsPer is PRODUCT");
    expect(error("report-purchase-totals", { rowsPer: "PRODUCT", vendorGroupIds: ["cgr_1"] })).toContain("only when rowsPer is VENDOR");
    expect(error("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: { start: "Jan 1" } })).toContain("tool_error");
    expect(error("report-purchase-totals", { rowsPer: "VENDOR", maxRowsLimit: 5001 })).toContain("5000");
    expect(error("report-purchase-totals", {})).toContain("invalid_arguments");
  });
});

describe("report-purchase-order-history", () => {
  test("one row per purchase in the last 30 days by default, latest first", () => {
    const { call, world } = bench();
    const r = call("report-purchase-order-history");
    const recent = world.purchaseOrders.filter((p) => p.orderDatetime.slice(0, 10) >= "2026-10-25");
    expect(r.meta.totalRowCount).toBe(recent.length);
    expect(r.rows[0]).toMatchObject({ purchaseNumber: "PO-1180", vendor: "Mendocino Gold Growers", status: "PROCESSING", paid: "0.00", owner: "Tom Becker", purchaseDate: "2026-11-14 08:45:00.000000" });
  });

  test("filters and pages", () => {
    const { call, world } = bench();
    const all = { start: "2025-01-01", end: TODAY };
    const count = (args: Record<string, unknown>) => call("report-purchase-order-history", { orderDatetime: all, ...args }).meta.totalRowCount;
    expect(count({})).toBe(28);
    expect(count({ search: "1182" })).toBe(1);
    expect(count({ statuses: ["PROCESSING", "DELIVERING"] })).toBe(2);
    expect(count({ vendorIds: ["com_6"] })).toBe(world.purchaseOrders.filter((p) => p.vendorId === "com_6").length);
    expect(count({ locationIds: ["loc_1"] })).toBe(28);
    expect(count({ productIds: [world.products.find((p) => p.name === "OG Kush 3.5g")!.id] })).toBeGreaterThan(0);
    expect(count({ paid: { max: 0 } })).toBe(3);
    expect(count({ total: { min: 50000 } })).toBe(world.purchaseOrders.filter((p) => purchaseTotal(p) >= 50000).length);
    expect(call("report-purchase-order-history", { dueDatetime: { start: TODAY } }).meta.totalRowCount).toBe(world.purchaseOrders.filter((p) => p.dueDatetime.slice(0, 10) >= TODAY).length);
    const first = call("report-purchase-order-history", { orderDatetime: all, maxRowsLimit: 20 });
    const next = call("report-purchase-order-history", { orderDatetime: all, maxRowsLimit: 20, cursor: first.nextCursor });
    expect(new Set([...first.rows, ...next.rows].map((x: any) => x.purchaseOrderId)).size).toBe(28);
  });

  test("refuses what it should", () => {
    const { error } = bench();
    expect(error("report-purchase-order-history", { vendorIds: ["po_1"] })).toContain("tool_error");
    expect(error("report-purchase-order-history", { batchIds: ["bat_1"] })).toContain("unsupported_input");
    expect(error("report-purchase-order-history", { statuses: ["DRAFT"] })).toContain("invalid_arguments");
  });
});
