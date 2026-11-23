// Every task done end to end, the way a competent agent would: the tool calls it makes, through the same strict
// runtime as the area tests, then the task's own grader. A read task builds its answer from the tool results alone;
// a write task is graded on the world the calls leave. Where a task has more than one reasonable route (a report or
// paging through a search), each route has its own test. This proves every task can be done with the tools as
// implemented, and that tools and graders agree.
import { describe, expect, test } from "bun:test";
import { addDays, isoIn } from "../src/core/kit.ts";
import { erp } from "../suites/erp/index.ts";
import { lastMonth, quarter } from "../suites/erp/seed.ts";
import { tasks } from "../suites/erp/tasks.ts";
import type { World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

// ---------- helpers ----------

type Call = ReturnType<typeof bench>["call"];

/** A fresh world and its strict runtime, with what an agent needs to page and to answer. */
function session() {
  const b = bench();
  const before: World = structuredClone(b.world);
  /** Every item of a search, following nextCursor. */
  const all = (tool: string, args: Record<string, unknown> = {}): any[] => {
    const items: any[] = [];
    let cursor: string | undefined;
    do {
      const r = b.call(tool, { ...args, ...(cursor ? { cursor } : {}) });
      items.push(...r.items);
      cursor = r.nextCursor;
    } while (cursor);
    return items;
  };
  /** Every row of a report, following nextCursor with the same arguments. */
  const rows = (tool: string, args: Record<string, unknown> = {}): any[] => {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = b.call(tool, { ...args, ...(cursor ? { cursor } : {}) });
      out.push(...r.rows);
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  };
  return { ...b, before, all, rows };
}

const task = (id: string) => tasks.find((t) => t.id === id)!;

/** Grades a read task's answer and expects every required check to pass; returns the informative ones that failed. */
function gradeRead(id: string, s: ReturnType<typeof session>, answer: string): string[] {
  const checks = task(id).grade({ answer, before: s.before, after: s.world });
  expect(checks.filter((c) => !c.pass && c.required !== false).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
  return checks.filter((c) => !c.pass).map((c) => c.name);
}

/** Grades a write task on the world the calls left, and expects every check to pass. */
function gradeWrite(id: string, s: ReturnType<typeof session>) {
  const checks = task(id).grade({ answer: "Done.", before: s.before, after: s.world });
  expect(checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
}

const table = (head: string[], body: (string | number)[][]) => [head, head.map(() => "---"), ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
/** Totals per key, highest first. */
function totalsBy<T>(items: T[], key: (x: T) => string, value: (x: T) => number): [string, number][] {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + value(x));
  return [...m].sort((a, b) => b[1] - a[1]);
}

/** The company's timezone, read once at the start of a session as the conventions page asks. */
const timezone = (call: Call) => call("get-me").timezone as string;
/** The instant of the run, as an agent reads it from its own clock, in the company's timezone. */
const nowIn = (tz: string) => isoIn(tz, erp.clock(TODAY));

const yesterday = addDays(TODAY, -1);
const lastQuarter = quarter(TODAY, 1);
const yearStart = `${TODAY.slice(0, 4)}-01-01`;

// ---------- catalog ----------

describe("catalog", () => {
  test("Lab dropdown: check packages have none, then create it", () => {
    const s = session();
    expect(s.call("search-custom-fields", { entityType: "PACKAGE", search: "Lab" }).items).toEqual([]);
    s.call("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "DROPDOWN", options: ["SC Labs", "Steep Hill"] });
    gradeWrite("catalog-lab-dropdown", s);
  });

  test("Summer promo on pre-rolls: resolve the category and tag, page the products, add the tag in one bulk update", () => {
    const s = session();
    const category = s.call("search-lookups", { type: "PRODUCT_CATEGORY", search: "pre-roll" }).items[0];
    const tag = s.call("search-lookups", { type: "PRODUCT_TAG", search: "summer promo" }).items[0];
    const prerolls = s.all("search-products", { productCategoryIds: [category.id], limit: 5 });
    s.call("bulk-update-products", { ids: prerolls.map((p) => p.id), addTagIds: [tag.id] });
    gradeWrite("catalog-tag-prerolls", s);
  });
});

// ---------- commerce ----------

describe("commerce", () => {
  const mainMenu = (call: Call) => call("search-menus", { search: "main wholesale" }).items[0].id;

  test("sold out on the main menu, from search-menu-products", () => {
    const s = session();
    const items = s.all("search-menu-products", { menuId: mainMenu(s.call), limit: 5 });
    const out = items.filter((p) => p.soldOut);
    gradeRead("commerce-main-menu-sold-out", s, `Sold out on the Main Wholesale Menu:\n${bullets(out.map((p) => p.name))}`);
  });

  test("sold out on the main menu, from search-products by menu", () => {
    const s = session();
    const items = s.all("search-products", { menuIds: [mainMenu(s.call)], limit: 100 });
    const out = items.filter((p) => Number(p.quantityAvailable) <= 0);
    const low = items.filter((p) => Number(p.quantityAvailable) > 0).sort((a, b) => Number(a.quantityAvailable) - Number(b.quantityAvailable)).slice(0, 2);
    gradeRead("commerce-main-menu-sold-out", s,
      `${table(["Product", "Available"], out.map((p) => [p.name, p.quantityAvailable]))}\n\nEverything else is in stock; the lowest are ${low.map((p) => `${p.name} with ${p.quantityAvailable} available`).join(" and ")}.`);
  });

  test("THC of the Spring Menu's flower: filter the menu's products by category type", () => {
    const s = session();
    const menu = s.call("search-menus", { search: "spring" }).items[0].id;
    const flower = s.all("search-menu-products", { menuId: menu, officialProductCategories: ["FLOWER"] });
    gradeRead("commerce-spring-flower-thc", s, table(["Product", "THC"], flower.map((p) => [p.name, `${p.totalThc}%`])));
  });

  test("ordering off on the Bay Area menu: stop partner orders", () => {
    const s = session();
    const menu = s.call("search-menus", { search: "bay area" }).items[0];
    expect(s.call("get-menu-settings", { id: menu.id }).menu.allowPartnerOrders).toBe(true);
    s.call("mutate-menu", { action: "UPDATE", id: menu.id, allowPartnerOrders: false });
    gradeWrite("commerce-bay-area-ordering", s);
  });
});

// ---------- compliance ----------

describe("compliance", () => {
  test("unimported Metrc packages: one search per license", () => {
    const s = session();
    const licenses: any[] = s.call("search-licenses").items;
    const unimported = licenses.flatMap((l: any) => s.all("search-metrc-packages", { licenseId: l.id, importStatus: "UNIMPORTED", limit: 3 }).map((m: any) => ({ ...m, license: l.licenseNumber })));
    gradeRead("compliance-unimported-packages", s, table(["Tag", "Item", "License"], unimported.map((m: any) => [m.label, m.metrcItem.name, m.license])));
  });

  /** The answer to "did yesterday's adjustments all go through?", from activities. */
  const adjustmentsAnswer = (activities: any[]) => {
    const failed = activities.filter((a) => a.status === "FAILED"), queued = activities.filter((a) => a.status === "QUEUED");
    expect(failed).toHaveLength(1);
    return `No. The adjustment of package ${failed[0].package.metrcLabel} failed: ${failed[0].lastError}\n\nStill queued behind it:\n${bullets(queued.map((a) => a.package.metrcLabel))}`;
  };

  test("yesterday's adjustments, from the activities of that day", () => {
    const s = session();
    timezone(s.call);
    const day = s.all("search-metrc-activities", { createdDateAfter: yesterday, createdDateBefore: yesterday, limit: 4 });
    const notes = gradeRead("compliance-yesterday-adjustments", s, adjustmentsAnswer(day.filter((a) => a.type === "ADJUST_PACKAGE")));
    expect(notes).toEqual([]);
  });

  test("yesterday's adjustments, from the license's sync health and then its stuck activities", () => {
    const s = session();
    const stuck = s.call("search-licenses").items.filter((l: any) => l.metrcPushStatus?.failedCount > 0);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].metrcPushStatus.oldestIncompleteActivity.queuedDatetime.slice(0, 10)).toBe(yesterday);
    const pending = s.all("search-metrc-activities", { licenseIds: [stuck[0].id], statuses: ["FAILED", "QUEUED"] });
    const ofYesterday = pending.filter((a) => a.type === "ADJUST_PACKAGE" && a.insertedAt.slice(0, 10) === yesterday);
    expect(gradeRead("compliance-yesterday-adjustments", s, adjustmentsAnswer(ofYesterday))).toEqual([]);
  });

  test("packages on manifest 0001234567: find it, then read its deliveries", () => {
    const s = session();
    const [found] = s.call("search-metrc-manifests", { search: "0001234567", direction: "INCOMING" }).items;
    const manifest = s.call("get-metrc-manifest", { manifestNumber: found.manifestNumber, includeDeliveries: true }).manifest;
    const packages = manifest.deliveries.flatMap((d: any) => d.packages);
    gradeRead("compliance-manifest-packages", s, table(["Package", "Item", "Quantity"], packages.map((p: any) => [p.label, p.itemName, p.shippedQuantity])));
  });
});

// ---------- costing ----------

describe("costing", () => {
  test("inventory value, from the valuation report at price (its default)", () => {
    const s = session();
    const value = sum(s.rows("report-inventory-valuation", { maxRowsLimit: 10 }).map((r) => Number(r.activeValue)));
    gradeRead("costing-inventory-value", s, `Our inventory is worth ${usd(value)} at list price.`);
  });

  test("inventory value, from the valuation report at cost", () => {
    const s = session();
    const value = sum(s.rows("report-inventory-valuation", { calculationMethod: "COST" }).map((r) => Number(r.activeValue)));
    gradeRead("costing-inventory-value", s, `At cost, our inventory is worth ${usd(value)}.`);
  });

  test("inventory value, from the assets report, leaving out discontinued products", () => {
    const s = session();
    const held = s.rows("report-inventory-assets", { maxRowsLimit: 25 }).filter((r) => !r.product.endsWith("(INACTIVE)"));
    gradeRead("costing-inventory-value", s, `At cost, the stock on hand is worth ${usd(sum(held.map((r) => Number(r.totalCostDefault))))}.`);
  });

  test("inventory value, paging through the active products", () => {
    const s = session();
    const products = s.all("search-products", { limit: 15 });
    gradeRead("costing-inventory-value", s, `At cost: ${usd(sum(products.map((p) => Number(p.activeQuantityCost))))}.`);
  });

  test("margin by category last quarter, from the cost of goods sold report", () => {
    const s = session();
    timezone(s.call);
    const lines = s.rows("report-cogs", { orderDatetime: lastQuarter, maxRowsLimit: 100 });
    const revenue = totalsBy(lines, (r) => r.productCategory, (r) => Number(r.totalPrice));
    const profit = new Map(totalsBy(lines, (r) => r.productCategory, (r) => Number(r.totalProfitsActual)));
    gradeRead("costing-category-margin", s, table(["Category", "Revenue", "Gross profit", "Margin"],
      revenue.map(([category, r]) => [category, usd(r), usd(profit.get(category)!), `${((profit.get(category)! / r) * 100).toFixed(1)}%`])));
  });
});

// ---------- cultivation ----------

describe("cultivation", () => {
  test("plants in veg, listed by tag", () => {
    const s = session();
    const plants = s.all("search-plants", { statuses: ["VEGETATIVE"], limit: 5 });
    gradeRead("cultivation-plants-in-veg", s, `${plants.length} plants are in veg:\n${bullets(plants.map((p) => `${p.metrcLabel} (${p.plantGroup.name})`))}`);
  });

  test("plants in veg, counted by plant group", () => {
    const s = session();
    const plants = s.all("search-plants", { statuses: ["VEGETATIVE"], limit: 100 });
    const groups = totalsBy(plants, (p) => p.plantGroup.name, () => 1);
    gradeRead("cultivation-plants-in-veg", s, `${plants.length} plants are in veg: ${groups.map(([g, n]) => `${g} (${n})`).join(" and ")}.`);
  });

  test("last month's harvest by strain, from the harvests of that month", () => {
    const s = session();
    timezone(s.call);
    const month = lastMonth(TODAY);
    const harvests = s.all("search-harvests", { harvestedAfter: month.start, harvestedBefore: month.end, limit: 4 });
    const byStrain = totalsBy(harvests, (h) => h.metrcStrain.name, (h) => Number(h.wetWeight));
    gradeRead("cultivation-harvest-by-strain", s, table(["Strain", "Wet weight"], byStrain.map(([strain, g]) => [strain, `${g.toLocaleString("en-US")} g`])));
  });
});

// ---------- directory ----------

describe("directory", () => {
  const sunset = (call: Call) => call("search-companies", { search: "Sunset Dispensary" }).items.find((c: any) => c.name === "Sunset Dispensary");

  test("Sunset Dispensary's rep and buyer: the company, then its contacts", () => {
    const s = session();
    const company = sunset(s.call);
    const contacts = s.call("get-company", { id: company.id, includeContacts: true }).company.contacts;
    const buyer = contacts.find((k: any) => k.title === "Buyer");
    gradeRead("directory-sunset-rep-buyer", s, `The sales rep on Sunset Dispensary is ${company.owner.fullName}. The buyer is ${buyer.firstName} ${buyer.lastName}: ${buyer.email}.`);
  });

  test("my overdue tasks: my open tasks due before now", () => {
    const s = session();
    const me = s.call("get-me");
    const now = nowIn(me.timezone);
    const overdue = s.all("search-tasks", { ownerIds: [me.user.id], statuses: ["ACTIVE"], dueDateBefore: now, limit: 2 });
    gradeRead("directory-my-overdue-tasks", s, `You have ${overdue.length} overdue tasks:\n${bullets(overdue.map((t) => `${t.name} (due ${t.dueDate.slice(0, 10)})`))}`);
  });

  test("my overdue tasks: all my tasks, sorted by due date and read against the clock", () => {
    const s = session();
    const me = s.call("get-me");
    const mine = s.all("search-tasks", { ownerIds: [me.user.id], sortBy: { field: "DUE_DATE", direction: "ASC" } });
    const now = Date.parse(nowIn(me.timezone));
    const overdue = mine.filter((t) => t.status === "ACTIVE" && Date.parse(t.dueDate) < now);
    const today = mine.filter((t) => t.status === "ACTIVE" && t.dueDate.slice(0, 10) === TODAY && Date.parse(t.dueDate) >= now);
    gradeRead("directory-my-overdue-tasks", s, `${bullets(overdue.map((t) => t.name))}\n\n${today.map((t) => `${t.name} is due later today, so it is not overdue.`).join(" ")}`);
  });

  test("Jane Lee at Sunset Dispensary: find the company, then add the contact", () => {
    const s = session();
    s.call("mutate-company-contact", { action: "CREATE", companyId: sunset(s.call).id, firstName: "Jane", lastName: "Lee", title: "Purchasing Manager" });
    gradeWrite("directory-add-contact", s);
  });
});

// ---------- history ----------

describe("history", () => {
  test("who changed the price on SO-1042: the order, then its history", () => {
    const s = session();
    const [order] = s.call("search-sales-orders", { search: "SO-1042" }).items;
    const history = s.all("get-record-history", { recordType: "SALES_ORDER", recordId: order.id });
    const change = history.find((e) => e.rows.some((r: any) => r.fields.some((f: any) => f.field === "priceBase")));
    const row = change.rows.find((r: any) => r.fields.some((f: any) => f.field === "priceBase"));
    const field = row.fields.find((f: any) => f.field === "priceBase");
    gradeRead("history-price-change-so-1042", s,
      `${change.actor.name} changed the price of ${row.rowLabel} on SO-1042 from $${field.oldValue} to $${field.newValue}, on ${change.changedAt.slice(0, 10)}.`);
  });

  test("what the public API changed yesterday, filtered by source and day", () => {
    const s = session();
    timezone(s.call);
    const entries = s.all("search-activity", { sources: ["PUBLIC_API"], changedAt: { start: yesterday, end: yesterday } });
    const records = [...new Set(entries.flatMap((e) => e.records.map((r: any) => r.name)))];
    gradeRead("history-public-api-yesterday", s, `Yesterday the public API changed:\n${bullets(records)}`);
  });

  test("what the public API changed yesterday, reading the last week's feed", () => {
    const s = session();
    const week = s.all("search-activity", { limit: 3 });
    const fromApi = week.filter((e) => e.source === "PUBLIC_API" && e.changedAt.slice(0, 10) === yesterday);
    const records = [...new Set(fromApi.flatMap((e) => e.records.map((r: any) => `${r.name} (${r.changedFields.join(", ") || "created"})`)))];
    gradeRead("history-public-api-yesterday", s, `Yesterday, through the storefront sync API key:\n${bullets(records)}`);
  });
});

// ---------- inventory ----------

describe("inventory", () => {
  test("below minimum, from search-products' own filter", () => {
    const s = session();
    const below = s.all("search-products", { belowQuantityAvailableThresholdMin: true });
    gradeRead("inventory-below-minimum", s, table(["Product", "Available", "Minimum"], below.map((p) => [p.name, p.quantityAvailable, p.quantityAvailableThresholdMin])));
  });

  test("below minimum, from the valuation report's thresholds", () => {
    const s = session();
    const below = s.rows("report-inventory-valuation", { maxRowsLimit: 20 }).filter((r) => r.inventoryThresholdMin !== null && Number(r.availableQuantity) < Number(r.inventoryThresholdMin));
    gradeRead("inventory-below-minimum", s, bullets(below.map((r) => `${r.name}: ${r.availableQuantity} available, minimum ${r.inventoryThresholdMin}`)));
  });

  test("move 20 Blue Dream 3.5g: the product's batch, the two rooms, then the transfer", () => {
    const s = session();
    const [product] = s.call("search-products", { search: "Blue Dream 3.5g" }).items;
    expect(product.inventoryTrackingMethod).toBe("BATCH");
    const [batch] = s.call("search-batches", { productIds: [product.id] }).items;
    const vault = s.call("search-locations", { search: "vault" }).items[0];
    const shipping = s.call("search-locations", { search: "shipping" }).items[0];
    s.call("move-stock", { fromLocationId: vault.id, toLocationId: shipping.id, items: [{ batchId: batch.id, quantity: 20 }] });
    gradeWrite("inventory-move-blue-dream", s);
  });
});

// ---------- orders ----------

describe("orders", () => {
  /** The latest due date that is more than 30 days ago, for a balance still owed now. */
  const lineDay = addDays(TODAY, -31);

  test("invoices more than 30 days overdue, from search-invoices", () => {
    const s = session();
    timezone(s.call);
    const late = s.all("search-invoices", { dueDateBefore: lineDay, paymentStatus: ["NOT_PAID", "PARTIALLY_PAID"], limit: 2 });
    gradeRead("orders-overdue-invoices", s,
      table(["Invoice", "Customer", "Due", "Balance", "Sales rep"], late.map((i) => [i.invoiceNumber, i.customer.name, i.dueDate.slice(0, 10), usd(Number(i.remainingAmount)), i.owner.profile.fullName])));
  });

  test("invoices more than 30 days overdue, from the invoice history report", () => {
    const s = session();
    const late = s.rows("report-invoice-history", { dueDatetime: { end: lineDay }, statuses: ["NOT_PAID", "PARTIALLY_PAID"] }).filter((r) => Number(r.outstanding) > 0);
    gradeRead("orders-overdue-invoices", s, bullets(late.map((r) => `${r.invoiceNumber} (${r.customer}, due ${r.dueDate}, ${usd(Number(r.outstanding))} outstanding): sales rep ${r.owner}`)));
  });

  test("top 10 customers last quarter, from the sales totals per customer", () => {
    const s = session();
    timezone(s.call);
    const top = s.call("report-sales-totals", { rowsPer: "CUSTOMER", orderDatetime: lastQuarter }).rows.slice(0, 10);
    const notes = gradeRead("orders-top-customers", s, top.map((r: any, i: number) => `${i + 1}. ${r.name}: ${usd(Number(r.totalSales))}`).join("\n"));
    expect(notes).toEqual([]);
  });

  test("top 10 customers last quarter, adding up the orders of the sales order report", () => {
    const s = session();
    const orders = s.rows("report-sales-orders", { rowsPer: "ORDER", orderDatetime: lastQuarter, maxRowsLimit: 25 });
    const ranked = totalsBy(orders, (r) => r.customer, (r) => Number(r.total));
    const notes = gradeRead("orders-top-customers", s,
      `${table(["#", "Customer", "Revenue"], ranked.slice(0, 10).map(([c, total], i) => [i + 1, c, usd(total)]))}\n\n${ranked[10]![0]} came 11th with ${usd(ranked[10]![1])}.`);
    expect(notes).toEqual([]);
  });

  test("email the invoice of order 4512: the order, its invoice, the customer's buyer, then the email", () => {
    const s = session();
    const [order] = s.call("search-sales-orders", { search: "4512" }).items;
    const [invoice] = s.call("get-sales-order", { id: order.id, includeInvoices: true }).salesOrder.invoices;
    const buyer = s.call("get-company", { id: order.customer.id, includeContacts: true }).company.contacts.find((k: any) => k.title === "Buyer");
    s.call("email-pdf", { document: "INVOICE", id: invoice.id, emailAddresses: [buyer.email] });
    gradeWrite("orders-email-invoice", s);
  });
});

// ---------- purchasing ----------

describe("purchasing", () => {
  test("spend per vendor this year, from the purchase totals report", () => {
    const s = session();
    timezone(s.call);
    const r = s.call("report-purchase-totals", { rowsPer: "VENDOR", orderDatetime: { start: yearStart, end: TODAY } });
    gradeRead("purchasing-vendor-spend", s, bullets(r.rows.map((x: any) => `${x.name}: ${usd(Number(x.totalPurchases))}`)));
  });

  test("spend per vendor this year, adding up this year's purchase orders", () => {
    const s = session();
    const orders = s.all("search-purchase-orders", { orderDateAfter: yearStart, orderDateBefore: TODAY, limit: 7 });
    gradeRead("purchasing-vendor-spend", s, table(["Vendor", "Ordered this year"], totalsBy(orders, (o) => o.supplier.name, (o) => Number(o.total)).map(([v, t]) => [v, usd(t)])));
  });

  test("purchase orders not paid in full, filtered by payment status", () => {
    const s = session();
    const unpaid = s.all("search-purchase-orders", { paymentStatus: ["NOT_PAID", "PARTIALLY_PAID"], limit: 3 });
    gradeRead("purchasing-unpaid-pos", s, bullets(unpaid.map((po) => `${po.purchaseNumber} (${po.supplier.name}): ${po.paymentStatus}`)));
  });

  test("purchase orders not paid in full, from the purchase order history over all time", () => {
    const s = session();
    const history = s.rows("report-purchase-order-history", { orderDatetime: { start: "2020-01-01", end: TODAY } });
    const unpaid = history.filter((r) => Number(r.paid) < Number(r.amount));
    const overpaid = history.filter((r) => Number(r.paid) > Number(r.amount));
    gradeRead("purchasing-unpaid-pos", s,
      `${table(["Purchase order", "Vendor", "Amount", "Paid"], unpaid.map((r) => [r.purchaseNumber, r.vendor, usd(Number(r.amount)), usd(Number(r.paid))]))}\n\n${overpaid.map((r) => `${r.purchaseNumber} is overpaid, not underpaid.`).join(" ")}`);
  });

  test("$2,500 against PO-1182: the order and a payment method, then the payment", () => {
    const s = session();
    const [po] = s.call("search-purchase-orders", { search: "1182" }).items;
    expect(po.purchaseNumber).toBe("PO-1182");
    const [method] = s.call("search-lookups", { type: "PAYMENT_METHOD" }).items;
    s.call("create-purchase-payment", { purchaseId: po.id, amount: 2500, paymentMethodId: method.id });
    gradeWrite("purchasing-record-payment", s);
  });
});

test("every task has a flow", () => {
  const source = Bun.file(new URL(import.meta.url).pathname);
  return source.text().then((text) => {
    for (const t of tasks) expect(text.includes(`"${t.id}"`), t.id).toBe(true);
  });
});
