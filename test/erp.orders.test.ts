import { describe, expect, test } from "bun:test";
import { addDays } from "../src/core/kit.ts";
import { quarter } from "../suites/erp/seed.ts";
import { invoiceMoney, orderTotal, type World } from "../suites/erp/world.ts";
import { TODAY, bench } from "./helpers.ts";

const lastQuarter = quarter(TODAY, 1);
/** "More than 30 days overdue": due on or before this day. */
const overdueCutoff = addDays(TODAY, -31);

const order = (w: World, number: string) => w.salesOrders.find((o) => o.orderNumber === number)!;
const companyId = (w: World, name: string) => w.companies.find((c) => c.name === name)!.id;
const numbers = (r: { items: { orderNumber?: string; invoiceNumber?: string }[] }) => r.items.map((i) => i.orderNumber ?? i.invoiceNumber);

/** Calls a search tool page by page and returns every item. */
function everyItem(call: (tool: string, args: Record<string, unknown>) => any, tool: string, args: Record<string, unknown>) {
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const r = call(tool, { ...args, ...(cursor ? { cursor } : {}) });
    items.push(...r.items);
    cursor = r.nextCursor;
  } while (cursor);
  return items;
}

/** The top customers by revenue last quarter, computed straight from the world as a grader would. */
function expectedTopCustomers(w: World) {
  const totals = new Map<string, number>();
  for (const o of w.salesOrders) {
    const day = o.orderDatetime.slice(0, 10);
    if (o.status === "CANCELED" || day < lastQuarter.start || day > lastQuarter.end) continue;
    totals.set(o.customerId, (totals.get(o.customerId) ?? 0) + orderTotal(o));
  }
  return [...totals].sort((a, b) => b[1] - a[1]);
}

describe("sales orders", () => {
  test("search-sales-orders lists every order, newest change first, and pages", () => {
    const { call } = bench();
    const first = call("search-sales-orders");
    expect(first.totalCount).toBe(104);
    expect(first.items).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    const updated = first.items.map((o: any) => Date.parse(o.updatedDate));
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
    const all = everyItem(call, "search-sales-orders", { limit: 30 });
    expect(new Set(all.map((o) => o.id)).size).toBe(104);
  });

  test("search finds an order from its number with or without the prefix, and old orders too", () => {
    const { call } = bench();
    expect(numbers(call("search-sales-orders", { search: "4512" }))).toEqual(["SO-4512"]);
    expect(numbers(call("search-sales-orders", { search: "SO-4512" }))[0]).toBe("SO-4512");
    expect(numbers(call("search-sales-orders", { search: "so-1042" }))).toEqual(["SO-1042"]);
    const byCustomer = call("search-sales-orders", { search: "bayside", limit: 100 });
    expect(byCustomer.items.every((o: any) => o.customer.name === "Bayside Botanicals")).toBe(true);
  });

  test("search-sales-orders honours every filter and sort it supports", () => {
    const { call, world: w } = bench();
    const so4512 = order(w, "SO-4512");
    const all = { limit: 100 };
    expect(numbers(call("search-sales-orders", { ids: [so4512.id.split("_")[1]] }))).toEqual(["SO-4512"]);
    const bayside = call("search-sales-orders", { ...all, customerIds: [so4512.customerId] });
    expect(bayside.items.every((o: any) => o.customer.id === so4512.customerId)).toBe(true);
    expect(call("search-sales-orders", { ...all, ownerIds: ["usr_1"] }).items.every((o: any) => o.owner.id === "usr_1")).toBe(true);
    expect(call("search-sales-orders", { menuIds: ["men_1"] }).totalCount).toBe(0);
    expect(call("search-sales-orders", { batchIds: ["bat_1"] }).totalCount).toBe(0);
    const gummies = w.products.find((p) => p.name === "Watermelon Gummies 100mg")!.id;
    expect(numbers(call("search-sales-orders", { ...all, productIds: [gummies] }))).toContain("SO-4512");
    const q = call("search-sales-orders", { ...all, orderDateAfter: lastQuarter.start, orderDateBefore: lastQuarter.end });
    expect(q.items.every((o: any) => o.orderDate.slice(0, 10) >= lastQuarter.start && o.orderDate.slice(0, 10) <= lastQuarter.end)).toBe(true);
    expect(numbers(call("search-sales-orders", { deliveryDateAfter: addDays(TODAY, -1), deliveryDateBefore: TODAY }))).toEqual(["SO-4512"]);
    expect(call("search-sales-orders", { ...all, dueDateBefore: overdueCutoff, dueDateAfter: "2026-10-01" }).items.length).toBeGreaterThan(0);
    expect(call("search-sales-orders", { ...all, status: ["CANCELED"] }).items.map((o: any) => o.status)).toEqual(["Canceled", "Canceled"]);
    expect(call("search-sales-orders", { ...all, paymentStatus: ["PAYING"] }).totalCount).toBe(2);
    expect(call("search-sales-orders", { totalGreaterThanOrEqualTo: 80000, totalLessThanOrEqualTo: 90000 }).items.map((o: any) => o.customer.name)).toEqual(["Coastal Roots"]);
    expect(call("search-sales-orders", { recordOnly: true }).totalCount).toBe(0);
    expect(call("search-sales-orders", { recordOnly: false }).totalCount).toBe(104);
    const byTotal = call("search-sales-orders", { sortBy: { field: "TOTAL", direction: "DESC" }, limit: 3 }).items.map((o: any) => +o.total);
    expect(byTotal).toEqual([...byTotal].sort((a, b) => b - a));
    expect(call("search-sales-orders", { sortBy: { field: "ORDER_NUMBER", direction: "ASC" }, limit: 1 }).items[0].orderNumber).toBe("SO-1042");
    for (const field of ["DUE_DATE", "INSERTED_AT", "ORDER_DATE", "UPDATED_AT"]) call("search-sales-orders", { sortBy: { field, direction: "ASC" } });
  });

  test("search-sales-orders refuses what it cannot answer", () => {
    const { error } = bench();
    expect(error("search-sales-orders", { ids: ["inv_3"] })).toContain("tool_error");
    expect(error("search-sales-orders", { orderDateAfter: "last week" })).toContain("tool_error");
    expect(error("search-sales-orders", { limit: 500 })).toContain("tool_error");
    expect(error("search-sales-orders", { cursor: "nope" })).toContain("tool_error");
    expect(error("search-sales-orders", { taxIds: ["tax_1"] })).toContain("unsupported_input");
    expect(error("search-sales-orders", { status: ["SHIPPED"] })).toContain("invalid_arguments");
  });

  test("get-sales-order leads to the order's invoice and its lines", () => {
    const { call, world: w } = bench();
    const so = order(w, "SO-4512");
    const bare = call("get-sales-order", { id: so.id }).salesOrder;
    expect(bare.orderNumber).toBe("SO-4512");
    expect(bare.status).toBe("Delivered");
    expect(bare.customer.name).toBe("Bayside Botanicals");
    expect(bare.invoices).toBeUndefined();
    expect(bare.orderItems).toBeUndefined();
    expect(bare.license.licenseNumber).toBe("C11-0000482-LIC");
    const full = call("get-sales-order", {
      id: so.id.split("_")[1], includeInvoices: true, includeOrderItems: true, includeOrderItemCostItems: true, includeOrderItemPriceTiers: true,
      includeOrderCharges: true, includeOriginalOrders: true,
    }).salesOrder;
    const invoice = w.invoices.find((i) => i.salesOrderId === so.id)!;
    expect(full.invoices).toEqual([{ id: invoice.id, invoiceNumber: "INV-4512", paymentStatus: "NOT_PAID", total: "4728.00", paid: "0.00", remainingAmount: "4728.00" }]);
    expect(full.orderItems.map((i: any) => [i.product.name, i.quantity])).toEqual([["Blue Dream 7g", "60"], ["Gelato Cartridge 1g", "48"], ["Watermelon Gummies 100mg", "120"]]);
    expect(full.orderItems.map((i: any) => i.lineGroup)).toEqual([1, 2, 3]);
    expect(full.orderItems[0]).toMatchObject({ priceTierMode: "AUTO", priceTier: null, costItems: null });
    expect(full.orderCharges).toEqual([]);
    expect(full.originalOrders).toEqual([]);
    expect(full.revenue).toBe(money(orderTotal(so)));
  });

  test("get-sales-order on an order that has not shipped, a missing id and a wrong one", () => {
    const { call, error } = bench();
    const pending = call("search-sales-orders", { status: ["PENDING"], limit: 1 }).items[0];
    const detail = call("get-sales-order", { id: pending.id, includeOrderItemPriceTiers: true }).salesOrder;
    expect(detail.revenue).toBeNull();
    expect(detail.orderItems.length).toBeGreaterThan(0);
    expect(call("get-sales-order", { id: "so_9999" })).toEqual({ salesOrder: null });
    expect(error("get-sales-order", { id: "inv_99" })).toContain("tool_error");
    expect(error("get-sales-order", {})).toContain("invalid_arguments");
  });
});

describe("invoices", () => {
  test("the invoices more than 30 days overdue, with their sales reps", () => {
    const { call, world: w } = bench();
    const r = call("search-invoices", { dueDateBefore: overdueCutoff, paymentStatus: ["NOT_PAID", "PARTIALLY_PAID"], limit: 100 });
    const expected = w.invoices.filter((inv) => {
      const m = invoiceMoney(w, inv);
      return !inv.voided && m.remaining > 0 && inv.dueDatetime.slice(0, 10) <= overdueCutoff;
    });
    expect(expected).toHaveLength(4);
    expect(r.items.map((i: any) => i.id).sort()).toEqual(expected.map((i) => i.id).sort());
    expect(r.items.map((i: any) => i.customer.name).sort()).toEqual(["Golden Gate Greens", "Harbor Lights Cannabis", "Sierra Vista Cannabis", "Topanga Wellness"]);
    for (const item of r.items) {
      const inv = w.invoices.find((i) => i.id === item.id)!;
      expect(item.owner.id).toBe(inv.ownerId);
      expect(item.remainingAmount).toBe(money(invoiceMoney(w, inv).remaining));
    }
    // The voided one and the ones due 12 and 27 days ago stay out.
    const names = r.items.map((i: any) => i.customer.name);
    for (const name of ["Laurel Canyon Collective", "Redwood Remedies", "Pacific Bloom"]) expect(names).not.toContain(name);
  });

  test("voidStatus leaves voided invoices out unless ids are given", () => {
    const { call, world: w } = bench();
    const voided = w.invoices.find((i) => i.voided)!;
    expect(call("search-invoices").totalCount).toBe(99);
    expect(call("search-invoices", { voidStatus: "ANY" }).totalCount).toBe(100);
    const only = call("search-invoices", { voidStatus: "VOIDED" }).items;
    expect(only.map((i: any) => i.id)).toEqual([voided.id]);
    expect(only[0].remainingAmount).toBe("0.00");
    expect(only[0].voidedAt).not.toBeNull();
    expect(call("search-invoices", { ids: [voided.id] }).items).toHaveLength(1);
    expect(call("search-invoices", { ids: [voided.id], voidStatus: "NOT_VOIDED" }).items).toHaveLength(0);
  });

  test("search-invoices pages over every invoice and honours every filter and sort it supports", () => {
    const { call, world: w } = bench();
    const all = everyItem(call, "search-invoices", { limit: 40, voidStatus: "ANY" });
    expect(new Set(all.map((i) => i.id)).size).toBe(100);
    expect(numbers(call("search-invoices", { search: "4512" }))).toEqual(["INV-4512"]);
    // search matches the invoice number only, as the page says: the order number finds nothing here.
    expect(call("search-invoices", { search: "SO-4512" }).totalCount).toBe(0);
    const greenleaf = companyId(w, "Greenleaf Collective");
    expect(call("search-invoices", { customerIds: [greenleaf], limit: 100 }).items.every((i: any) => i.customer.id === greenleaf)).toBe(true);
    expect(call("search-invoices", { ownerIds: ["usr_3"], limit: 100 }).items.every((i: any) => i.owner.id === "usr_3")).toBe(true);
    const gummies = w.products.find((p) => p.name === "Watermelon Gummies 100mg")!.id;
    expect(numbers(call("search-invoices", { productIds: [gummies], limit: 100 }))).toContain("INV-4512");
    const recent = call("search-invoices", { invoiceDateAfter: addDays(TODAY, -3), invoiceDateBefore: TODAY, limit: 100 });
    expect(numbers(recent)).toEqual(["INV-4512"]);
    const dueOnDay = call("search-invoices", { dueDateAfter: "2026-09-09", dueDateBefore: "2026-09-09" }).items;
    expect(dueOnDay.every((i: any) => i.dueDate.startsWith("2026-09-09"))).toBe(true);
    expect(dueOnDay.map((i: any) => i.invoiceNumber)).toContain("INV-4449");
    expect(call("search-invoices", { paidGreaterThanOrEqualTo: 1, paidLessThanOrEqualTo: 6000, paymentStatus: ["PARTIALLY_PAID"] }).totalCount).toBe(2);
    expect(call("search-invoices", { totalGreaterThanOrEqualTo: 80000, totalLessThanOrEqualTo: 90000 }).items.map((i: any) => i.customer.name)).toEqual(["Coastal Roots"]);
    expect(call("search-invoices", { salesOrderStatus: ["DELIVERED"] }).items.map((i: any) => i.invoiceNumber)).toEqual(["INV-4512"]);
    const byRemaining = call("search-invoices", { sortBy: { field: "REMAINING_AMOUNT", direction: "DESC" }, limit: 3 }).items.map((i: any) => +i.remainingAmount);
    expect(byRemaining).toEqual([...byRemaining].sort((a, b) => b - a));
    for (const field of ["DUE_DATE", "INSERTED_AT", "INVOICE_DATE", "INVOICE_NUMBER", "TOTAL", "UPDATED_AT"]) call("search-invoices", { sortBy: { field, direction: "DESC" } });
  });

  test("search-invoices refuses what it cannot answer", () => {
    const { error } = bench();
    expect(error("search-invoices", { ids: ["so_3"] })).toContain("tool_error");
    expect(error("search-invoices", { dueDateBefore: "2026-10-23T00:00:00" })).toContain("tool_error");
    expect(error("search-invoices", { customFields: [{ customFieldId: "cf_1", contains: "x" }] })).toContain("unsupported_input");
    expect(error("search-invoices", { paymentStatus: ["OVERPAID"] })).toContain("invalid_arguments");
  });

  test("get-invoice gives the header, lines and charges", () => {
    const { call, error, world: w } = bench();
    const inv = w.invoices.find((i) => i.invoiceNumber === "INV-4478")!;
    const bare = call("get-invoice", { id: inv.id }).invoice;
    expect(bare).toMatchObject({ invoiceNumber: "INV-4478", paymentStatus: "PARTIALLY_PAID", paymentTermName: "Net 30" });
    expect(bare.paid).toBe(money(invoiceMoney(w, inv).paid));
    expect(bare.invoiceItems).toBeUndefined();
    const full = call("get-invoice", { id: inv.id, includeInvoiceItems: true, includeInvoiceCharges: true }).invoice;
    expect(full.invoiceItems).toHaveLength(order(w, "SO-4478").items.length);
    expect(full.invoiceCharges).toEqual([]);
    expect(call("get-invoice", { id: "inv_9999" })).toEqual({ invoice: null });
    expect(error("get-invoice", { id: "so_1" })).toContain("tool_error");
  });
});

describe("invoice payments", () => {
  test("search-invoice-payments lists posted payments, newest first, and pages", () => {
    const { call } = bench();
    const first = call("search-invoice-payments");
    expect(first.totalCount).toBe(89);
    const dates = first.items.map((p: any) => Date.parse(p.paymentDate));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(new Set(everyItem(call, "search-invoice-payments", { limit: 25 }).map((p) => p.id)).size).toBe(89);
  });

  test("search-invoice-payments honours every filter and sort it supports", () => {
    const { call, world: w } = bench();
    const inv = w.invoices.find((i) => i.invoiceNumber === "INV-4478")!;
    const forInvoice = call("search-invoice-payments", { invoiceIds: [inv.id] }).items;
    expect(forInvoice).toHaveLength(1);
    expect(forInvoice[0]).toMatchObject({ status: "POSTED", appliedAmount: money(invoiceMoney(w, inv).paid), invoice: { invoiceNumber: "INV-4478", paymentStatus: "PARTIALLY_PAID" } });
    const greenleaf = companyId(w, "Greenleaf Collective");
    expect(call("search-invoice-payments", { customerIds: [greenleaf], limit: 100 }).items.every((p: any) => p.customer.id === greenleaf)).toBe(true);
    expect(call("search-invoice-payments", { paymentMethodIds: ["pmm_1"], limit: 100 }).items.every((p: any) => p.received.paymentMethod.id === "pmm_1")).toBe(true);
    const inQuarter = call("search-invoice-payments", { paymentDateAfter: lastQuarter.start, paymentDateBefore: lastQuarter.end, limit: 100 });
    expect(inQuarter.items.every((p: any) => p.paymentDate.slice(0, 10) >= lastQuarter.start && p.paymentDate.slice(0, 10) <= lastQuarter.end)).toBe(true);
    expect(call("search-invoice-payments", { appliedAmountMin: "2900", appliedAmountMax: 2920 }).items.map((p: any) => p.invoice.invoiceNumber)).toEqual(["INV-4449"]);
    const payment = forInvoice[0];
    expect(call("search-invoice-payments", { paymentNumber: payment.paymentNumber.toLowerCase() }).items[0].id).toBe(payment.id);
    expect(call("search-invoice-payments", { search: "INV-4478" }).items.map((p: any) => p.id)).toEqual([payment.id]);
    expect(call("search-invoice-payments", { search: "golden%greens" }).items.every((p: any) => p.customer.name === "Golden Gate Greens")).toBe(true);
    expect(call("search-invoice-payments", { search: "INV-447_" }).totalCount).toBeGreaterThan(1);
    expect(call("search-invoice-payments", { status: "VOIDED" }).totalCount).toBe(0);
    expect(call("search-invoice-payments", { status: "ALL" }).totalCount).toBe(89);
    for (const field of ["INSERTED_AT", "PAYMENT_DATE", "PAYMENT_NUMBER", "UPDATED_AT"]) call("search-invoice-payments", { sortBy: { field, direction: "ASC" } });
  });

  test("a voided payment is left out by default and kept as recorded", () => {
    const { call, world: w } = bench();
    w.invoicePayments[0]!.voided = true;
    expect(call("search-invoice-payments").totalCount).toBe(88);
    const voided = call("search-invoice-payments", { status: "VOIDED" }).items[0];
    expect(voided).toMatchObject({ id: w.invoicePayments[0]!.id, status: "VOIDED", appliedAmount: money(w.invoicePayments[0]!.amount) });
    expect(voided.voidedAt).not.toBeNull();
  });

  test("get-invoice-payment, a missing id and a purchase payment's id", () => {
    const { call, error, world: w } = bench();
    const p = w.invoicePayments[0]!;
    const got = call("get-invoice-payment", { id: p.id }).invoicePayment;
    expect(got).toMatchObject({ id: p.id, received: { amount: money(p.amount) }, creditUses: [], overpaymentCredits: [] });
    expect(call("get-invoice-payment", { id: "ipy_9999" })).toEqual({ invoicePayment: null });
    expect(call("get-invoice-payment", { id: "ppy_1" })).toEqual({ invoicePayment: null });
    expect(error("get-invoice-payment", { id: "inv_1" })).toContain("tool_error");
    expect(error("search-invoice-payments", { appliedAmountMin: "a lot" })).toContain("tool_error");
  });
});

describe("report-invoice-history", () => {
  test("agrees with search-invoices on the overdue invoices", () => {
    const { call } = bench();
    const searched = call("search-invoices", { dueDateBefore: overdueCutoff, paymentStatus: ["NOT_PAID", "PARTIALLY_PAID"], limit: 100 }).items;
    const r = call("report-invoice-history", { dueDatetime: { end: overdueCutoff }, statuses: ["NOT_PAID", "PARTIALLY_PAID"] });
    expect(r.meta.dateRange).toBe(`dueDatetime any to ${overdueCutoff}`);
    expect(r.rows.map((x: any) => x.invoiceId).sort()).toEqual(searched.map((i: any) => i.id).sort());
    for (const row of r.rows) {
      const inv = searched.find((i: any) => i.id === row.invoiceId);
      expect(row.outstanding).toBe(inv.remainingAmount);
      expect(row.invoiceOwnerId).toBe(inv.owner.id);
      expect(row.owner).toBe(inv.owner.profile.fullName);
    }
    const numbersDesc = r.rows.map((x: any) => x.invoiceNumber);
    expect(numbersDesc).toEqual([...numbersDesc].sort().reverse());
  });

  test("defaults to the last 30 days of invoices and pages", () => {
    const { call } = bench();
    const r = call("report-invoice-history");
    expect(r.meta.dateRange).toBe(`invoiceDatetime ${addDays(TODAY, -29)} to ${TODAY}`);
    expect(r.rows.every((x: any) => x.invoiceDate >= addDays(TODAY, -29))).toBe(true);
    const year = { invoiceDatetime: { start: addDays(TODAY, -500), end: TODAY } };
    const first = call("report-invoice-history", { ...year, maxRowsLimit: 60 });
    expect(first.meta).toMatchObject({ rowCount: 60, totalRowCount: 99, truncated: true });
    const second = call("report-invoice-history", { ...year, maxRowsLimit: 60, cursor: first.nextCursor });
    expect(second.meta).toMatchObject({ rowCount: 39, offset: 60, truncated: false });
    expect(second.nextCursor).toBeUndefined();
  });

  test("honours every filter it supports", () => {
    const { call, world: w } = bench();
    const year = { invoiceDatetime: { start: addDays(TODAY, -500), end: TODAY } };
    expect(call("report-invoice-history", { ...year, search: "4512" }).rows.map((x: any) => x.invoiceNumber)).toEqual(["INV-4512"]);
    const voided = call("report-invoice-history", { ...year, voidStatus: "VOIDED" }).rows;
    expect(voided.map((x: any) => [x.customer, x.outstanding])).toEqual([["Laurel Canyon Collective", "0.00"]]);
    expect(call("report-invoice-history", { ...year, voidStatus: "ANY" }).meta.totalRowCount).toBe(100);
    expect(call("report-invoice-history", { ...year, statuses: ["FULLY_PAID"] }).rows.every((x: any) => x.status === "FULLY_PAID" && x.outstanding === "0.00")).toBe(true);
    expect(call("report-invoice-history", { ...year, paid: { min: 1, max: 6000 }, total: { min: 7000 } }).rows.map((x: any) => x.invoiceNumber).sort()).toEqual(["INV-4449", "INV-4478"]);
    expect(call("report-invoice-history", { ...year, orderStatuses: ["DELIVERED"] }).rows.map((x: any) => x.invoiceNumber)).toEqual(["INV-4512"]);
    const greenleaf = companyId(w, "Greenleaf Collective");
    expect(call("report-invoice-history", { ...year, customerIds: [greenleaf] }).rows.every((x: any) => x.customerId === greenleaf)).toBe(true);
    const gummies = w.products.find((p) => p.name === "Watermelon Gummies 100mg")!.id;
    expect(call("report-invoice-history", { ...year, productIds: [gummies] }).rows.map((x: any) => x.invoiceNumber)).toContain("INV-4512");
    expect(call("report-invoice-history", { ...year, batchIds: ["bat_1"] }).rows).toEqual([]);
    expect(call("report-invoice-history", { ...year, shippedFromLicenseIds: ["lic_2"] }).rows).toEqual([]);
    expect(call("report-invoice-history", { ...year, shippedFromLicenseIds: ["lic_1"] }).meta.totalRowCount).toBe(99);
  });

  test("refuses what it cannot answer", () => {
    const { error } = bench();
    expect(error("report-invoice-history", { maxRowsLimit: 6000 })).toContain("tool_error");
    expect(error("report-invoice-history", { customerIds: ["usr_1"] })).toContain("tool_error");
    expect(error("report-invoice-history", { statuses: ["PAID"] })).toContain("invalid_arguments");
  });
});

describe("sales reports", () => {
  test("report-sales-totals per customer ranks last quarter's revenue without canceled or out-of-range orders", () => {
    const { call, world: w } = bench();
    const r = call("report-sales-totals", { rowsPer: "CUSTOMER", orderDatetime: { start: lastQuarter.start, end: lastQuarter.end } });
    const expected = expectedTopCustomers(w);
    expect(r.rows.map((x: any) => [x.customerId, x.totalSales])).toEqual(expected.map(([id, total]) => [id, money(total)]));
    const top10 = r.rows.slice(0, 10).map((x: any) => x.name);
    expect(top10[0]).toBe("Greenleaf Collective");
    expect(top10).not.toContain("Coastal Roots");
    expect(top10).not.toContain("Marina Green Dispensary");
    const greenleaf = r.rows[0];
    expect(greenleaf.owner).toBe("Daniel Reyes");
    expect(greenleaf.lastOrderDate).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    expect(r.meta.dateRange).toBe(`orderDatetime ${lastQuarter.start} to ${lastQuarter.end}`);
  });

  test("report-sales-orders and search-sales-orders agree with the customer totals", () => {
    const { call } = bench();
    const range = { start: lastQuarter.start, end: lastQuarter.end };
    const totals = call("report-sales-totals", { rowsPer: "CUSTOMER", orderDatetime: range }).rows;
    const byCustomer = (rows: { customerId: string; total: string }[]) => {
      const m = new Map<string, number>();
      for (const x of rows) m.set(x.customerId, Math.round(((m.get(x.customerId) ?? 0) + +x.total) * 100) / 100);
      return m;
    };
    const expected = new Map<string, number>(totals.map((x: any) => [x.customerId, +x.totalSales]));
    expect(byCustomer(call("report-sales-orders", { rowsPer: "ORDER", orderDatetime: range }).rows)).toEqual(expected);
    const searched = everyItem(call, "search-sales-orders", { orderDateAfter: range.start, orderDateBefore: range.end, status: ["COMPLETED", "DELIVERED", "PENDING", "PROCESSING", "READY_TO_SHIP", "DELIVERING"], limit: 25 });
    expect(byCustomer(searched.map((o) => ({ customerId: o.customer.id, total: o.total })))).toEqual(expected);
    const lines = call("report-sales-orders", { rowsPer: "LINE_ITEM", orderDatetime: range }).rows;
    expect(byCustomer(lines.map((l: any) => ({ customerId: l.customerId, total: String(+l.quantity * +l.orderItemPrice) })))).toEqual(expected);
  });

  test("report-sales-totals per product and per sales rep add up to the same revenue", () => {
    const { call } = bench();
    const range = { orderDatetime: { start: lastQuarter.start, end: lastQuarter.end } };
    const total = (rows: { totalSales: string }[]) => Math.round(rows.reduce((n, x) => n + +x.totalSales, 0) * 100) / 100;
    const customers = total(call("report-sales-totals", { rowsPer: "CUSTOMER", ...range }).rows);
    const products = call("report-sales-totals", { rowsPer: "PRODUCT", ...range }).rows;
    const reps = call("report-sales-totals", { rowsPer: "SALES_REP", ...range }).rows;
    expect(total(products)).toBe(customers);
    expect(total(reps)).toBe(customers);
    expect(reps.map((x: any) => x.leaderboardRank)).toEqual(["1", "2", "3", "4", "5"]);
    expect(reps.find((x: any) => x.user === "Tom Becker").totalSales).toBe("0.00");
    expect(products[0]).toMatchObject({ shippedFromLicense: "C11-0000482-LIC", unitType: "Each" });
  });

  test("report-sales-totals honours every filter it supports", () => {
    const { call, world: w } = bench();
    const range = { orderDatetime: { start: lastQuarter.start, end: lastQuarter.end } };
    expect(call("report-sales-totals", { rowsPer: "CUSTOMER", ...range, statuses: ["CANCELED"] }).rows.map((x: any) => x.name)).toEqual(["Marina Green Dispensary", "Laurel Canyon Collective"]);
    expect(call("report-sales-totals", { rowsPer: "CUSTOMER", ...range, ownerIds: ["usr_1"] }).rows.every((x: any) => x.customerOwnerId === "usr_1")).toBe(true);
    const bayArea = call("report-sales-totals", { rowsPer: "CUSTOMER", ...range, customerGroupIds: ["cgr_1"] }).rows;
    expect(bayArea.every((x: any) => w.companies.find((c) => c.id === x.customerId)!.groupId === "cgr_1")).toBe(true);
    const product = (args: Record<string, unknown>) => call("report-sales-totals", { rowsPer: "PRODUCT", ...range, ...args }).rows;
    const greenleaf = companyId(w, "Greenleaf Collective");
    expect(product({ customerIds: [greenleaf] }).length).toBeGreaterThan(0);
    expect(product({ excludeCustomerIds: [greenleaf] }).length).toBeGreaterThan(0);
    expect(product({ locationIds: ["loc_1"] })).toEqual([]);
    expect(product({ shippedFromLicenseIds: ["lic_1"] }).length).toBeGreaterThan(0);
    expect(product({ search: "gummies" }).every((x: any) => x.name.includes("Gummies"))).toBe(true);
    expect(product({ productCategoryIds: ["cat_3"] }).every((x: any) => x.category === "Edibles")).toBe(true);
    expect(product({ productSubcategoryIds: ["sub_1"] }).every((x: any) => x.subcategory === "Eighths")).toBe(true);
    expect(product({ productTagIds: ["tag_1"] }).length).toBeGreaterThan(0);
    expect(product({ vendorIds: ["com_4"] }).every((x: any) => x.vendorId === "com_4")).toBe(true);
    expect(product({ brandIds: ["com_1"] })).toEqual([]);
    expect(product({ productGroupIds: ["grp_1"] }).every((x: any) => x.group === "House brand")).toBe(true);
    const reps = call("report-sales-totals", { rowsPer: "SALES_REP", ...range, ownerIds: ["usr_2"], search: "greenleaf" }).rows;
    expect(reps).toHaveLength(1);
    expect(+reps[0].totalSales).toBe(expectedTopCustomers(w).find(([id]) => id === greenleaf)![1]);
    const paged = call("report-sales-totals", { rowsPer: "CUSTOMER", ...range, maxRowsLimit: 10 });
    expect(paged.meta.truncated).toBe(true);
    expect(call("report-sales-totals", { rowsPer: "CUSTOMER", ...range, maxRowsLimit: 10, cursor: paged.nextCursor }).meta.offset).toBe(10);
    expect(call("report-sales-totals", { rowsPer: "CUSTOMER" }).meta.dateRange).toBe(`orderDatetime ${addDays(TODAY, -29)} to ${TODAY}`);
  });

  test("report-sales-totals refuses inputs of another rowsPer", () => {
    const { error } = bench();
    expect(error("report-sales-totals", { rowsPer: "CUSTOMER", customerIds: ["com_7"] })).toContain("tool_error");
    expect(error("report-sales-totals", { rowsPer: "PRODUCT", customerGroupIds: ["cgr_1"] })).toContain("tool_error");
    expect(error("report-sales-totals", { rowsPer: "CUSTOMER", search: "green" })).toContain("tool_error");
    expect(error("report-sales-totals", {})).toContain("invalid_arguments");
  });

  test("report-sales-orders rows per order and per line item honour every filter they support", () => {
    const { call, world: w } = bench();
    const range = { orderDatetime: { start: addDays(TODAY, -500), end: TODAY } };
    const orders = (args: Record<string, unknown>) => call("report-sales-orders", { rowsPer: "ORDER", ...range, ...args }).rows;
    const lines = (args: Record<string, unknown>) => call("report-sales-orders", { rowsPer: "LINE_ITEM", ...range, ...args }).rows;
    expect(orders({}).length).toBe(102);
    const so4512 = orders({ search: "4512" });
    expect(so4512).toHaveLength(1);
    expect(so4512[0]).toMatchObject({ orderNumber: "SO-4512", status: "DELIVERED", paid: "0.00", outstanding: "4728.00", orderSource: "INTERNAL_USER" });
    expect(so4512[0].orderDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.000000$/);
    expect(orders({ search: "bayside" }).every((x: any) => x.customer === "Bayside Botanicals")).toBe(true);
    expect(orders({ orderSources: ["API"] }).map((x: any) => x.orderNumber)).toEqual(["SO-4509"]);
    expect(orders({ statuses: ["CANCELED"] }).map((x: any) => x.outstanding)).toEqual(["0.00", "0.00"]);
    expect(orders({ paymentStatuses: ["PAYING"] }).map((x: any) => x.orderNumber).sort()).toEqual(["SO-4449", "SO-4478"]);
    expect(orders({ total: { min: 80000 } }).map((x: any) => x.customer)).toEqual(["Coastal Roots"]);
    expect(orders({ matchedWithComplianceTransfer: true })).toEqual([]);
    expect(orders({ menuIds: ["men_1"] })).toEqual([]);
    expect(orders({ batchIds: ["bat_1"] })).toEqual([]);
    expect(orders({ brandIds: ["com_1"] })).toEqual([]);
    expect(orders({ shippedFromLicenseIds: ["lic_1"] }).length).toBe(102);
    expect(orders({ customerGroupIds: ["cgr_2"] }).every((x: any) => w.companies.find((c) => c.id === x.customerId)!.groupId === "cgr_2")).toBe(true);
    const bayside = companyId(w, "Bayside Botanicals");
    expect(orders({ customerIds: [bayside] }).every((x: any) => x.customerId === bayside)).toBe(true);
    const gummies = w.products.find((p) => p.name === "Watermelon Gummies 100mg")!.id;
    const withGummies = lines({ productIds: [gummies], search: "SO-4512" });
    expect(withGummies.map((x: any) => x.product)).toEqual(["Blue Dream 7g", "Gelato Cartridge 1g", "Watermelon Gummies 100mg"]);
    expect(withGummies[0]).toMatchObject({ invoiceNumbers: "INV-4512", salesRep: "Daniel Reyes", priceTierMode: "AUTO" });
    expect(lines({ search: "SO-4512", productCategoryIds: ["cat_3"] }).map((x: any) => x.product)).toEqual(["Watermelon Gummies 100mg"]);
    expect(lines({ productSubcategoryIds: ["sub_1"] }).every((x: any) => x.subcategory === "Eighths")).toBe(true);
    expect(lines({ productTagIds: ["tag_3"] }).length).toBeGreaterThan(0);
    expect(lines({ vendorIds: ["com_4"] }).every((x: any) => x.vendorId === "com_4")).toBe(true);
    expect(lines({ productGroupIds: ["grp_2"] }).every((x: any) => x.group === "Partner brands")).toBe(true);
    expect(lines({ brandIds: ["com_1"] })).toEqual([]);
    expect(lines({ sample: "ONLY" })).toEqual([]);
    expect(lines({ sample: "EXCLUDE" }).length).toBeGreaterThan(0);
    expect(lines({ tradeSamplePackages: "EXCLUDE" })).toEqual([]);
    const dates = lines({}).map((x: any) => x.orderDateUtc);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(call("report-sales-orders", { rowsPer: "TAX_RATE", ...range }).rows).toEqual([]);
  });

  test("report-sales-orders dates: the default, and other date filters lifting it", () => {
    const { call } = bench();
    const byDefault = call("report-sales-orders", { rowsPer: "ORDER" });
    expect(byDefault.meta.dateRange).toBe(`orderDatetime ${addDays(TODAY, -29)} to ${TODAY}`);
    const due = call("report-sales-orders", { rowsPer: "ORDER", dueDatetime: { end: overdueCutoff }, paymentStatuses: ["NOT_PAID", "PAYING"] });
    expect(due.meta.dateRange).toBe(`dueDatetime any to ${overdueCutoff}`);
    expect(due.rows.map((x: any) => x.orderNumber).sort()).toEqual(["SO-4449", "SO-4465", "SO-4478", "SO-4484"]);
    const delivered = call("report-sales-orders", { rowsPer: "ORDER", deliveryDatetime: { start: addDays(TODAY, -500) } });
    expect(delivered.rows.every((x: any) => x.deliveryDate !== null)).toBe(true);
    const paged = call("report-sales-orders", { rowsPer: "LINE_ITEM", deliveryDatetime: { start: addDays(TODAY, -500) }, maxRowsLimit: 100 });
    expect(paged.meta.truncated).toBe(true);
    const next = call("report-sales-orders", { rowsPer: "LINE_ITEM", deliveryDatetime: { start: addDays(TODAY, -500) }, maxRowsLimit: 100, cursor: paged.nextCursor });
    expect(next.meta.offset).toBe(100);
  });

  test("report-sales-orders refuses what it cannot answer", () => {
    const { error } = bench();
    expect(error("report-sales-orders", { rowsPer: "ORDER", vendorIds: ["com_4"] })).toContain("tool_error");
    expect(error("report-sales-orders", { rowsPer: "ORDER", sample: "ONLY" })).toContain("tool_error");
    expect(error("report-sales-orders", { rowsPer: "TAX_RATE", taxIds: ["tax_1"] })).toContain("unsupported_input");
    expect(error("report-sales-orders", { rowsPer: "ORDER", orderDatetime: { start: "yesterday" } })).toContain("tool_error");
  });
});

describe("PDFs", () => {
  test("email-pdf sends the invoice of order 4512 to the address it is given", () => {
    const { call, world: w } = bench();
    const so = call("search-sales-orders", { search: "4512" }).items[0];
    const invoiceId = call("get-sales-order", { id: so.id, includeInvoices: true }).salesOrder.invoices[0].id;
    const buyer = w.companies.find((c) => c.id === so.customer.id)!.invoiceEmail!;
    const actionsBefore = w.actions.length;
    expect(call("email-pdf", { document: "INVOICE", id: invoiceId, emailAddresses: [buyer] })).toEqual({ emailedTo: [buyer] });
    expect(w.outbox).toEqual([{ document: "INVOICE", recordId: invoiceId, emailAddresses: [buyer], sentAt: "2026-11-23T10:00:00-08:00" }]);
    expect(w.actions).toHaveLength(actionsBefore + 1);
    expect(w.actions.at(-1)!.records[0]).toMatchObject({ type: "INVOICE", id: invoiceId, name: "INV-4512" });
  });

  test("email-pdf checks the document, the record and the addresses before sending anything", () => {
    const { call, error, world: w } = bench();
    const before = JSON.stringify(w);
    expect(error("email-pdf", { document: "INVOICE", id: "inv_99", emailAddresses: [] })).toContain("never picks an address");
    expect(error("email-pdf", { document: "INVOICE", id: "inv_99", emailAddresses: ["noah at bayside"] })).toContain("tool_error");
    expect(error("email-pdf", { document: "INVOICE", id: "inv_9999", emailAddresses: ["a@b.example"] })).toContain("No invoice found");
    expect(error("email-pdf", { document: "INVOICE", id: "so_102", emailAddresses: ["a@b.example"] })).toContain("tool_error");
    expect(error("email-pdf", { document: "INVOICE_COA", id: "inv_99", emailAddresses: ["a@b.example"] })).toContain("No lab result file");
    expect(error("email-pdf", { document: "RECEIPT", id: "inv_99", emailAddresses: ["a@b.example"] })).toContain("invalid_arguments");
    expect(error("email-pdf", { document: "INVOICE", id: "inv_99" })).toContain("invalid_arguments");
    expect(JSON.stringify(w)).toBe(before);
    call("email-pdf", { document: "METRC_MANIFEST", id: "0001234567", emailAddresses: ["maya@tidewatercannabis.example", "lena@tidewatercannabis.example"] });
    expect(w.outbox[0]!.emailAddresses).toHaveLength(2);
  });

  test("download-pdf links each document the world has records for", () => {
    const { call, world: w } = bench();
    const cases: [string, string, string][] = [
      ["INVOICE", "inv_99", "Invoice INV-4512.pdf"], ["SALES_ORDER", "102", "Order slip SO-4512.pdf"],
      ["PURCHASE_ORDER", w.purchaseOrders.find((p) => p.purchaseNumber === "PO-1182")!.id, "Purchase order PO-1182.pdf"], ["METRC_MANIFEST", "0001234567", "Manifest 0001234567.pdf"],
    ];
    for (const [document, id, filename] of cases) {
      const r = call("download-pdf", { document, id });
      expect(r.filename).toBe(filename);
      expect(r.url).toStartWith("https://");
      expect(r.expiresDatetime).toBe("2026-11-23T11:00:00-08:00");
    }
    expect(w.outbox).toEqual([]);
  });

  test("download-pdf refuses documents the world has no source for", () => {
    const { error, world: w } = bench();
    expect(error("download-pdf", { document: "SALES_ORDER_COA", id: "so_102" })).toContain("No lab result file");
    expect(error("download-pdf", { document: "BATCH_COA", id: "bat_1" })).toContain("No lab result file");
    expect(error("download-pdf", { document: "PACKAGE_COA", id: "pkg_1" })).toContain("No lab result file");
    expect(error("download-pdf", { document: "PACKAGE_COA", id: "pkg_9999" })).toContain("No package found");
    expect(error("download-pdf", { document: "ASSEMBLY", id: "asm_1" })).toContain("No assembly found");
    expect(error("download-pdf", { document: "TEST_RESULT_COA", id: "test_1" })).toContain("No test result found");
    expect(error("download-pdf", { document: "METRC_MANIFEST", id: "0009999999" })).toContain("No Metrc manifest found");
    w.purchaseOrders[0]!.status = "DRAFT";
    expect(error("download-pdf", { document: "PURCHASE_ORDER", id: w.purchaseOrders[0]!.id })).toContain("draft");
  });
});

const money = (n: number) => n.toFixed(2);
