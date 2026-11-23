// Sales orders, invoices and invoice payments, the sales and invoice reports, and the PDFs of those documents.
import { createHash } from "node:crypto";
import { addDays, bound, dayIn, isoIn, matches, money, normalizeId, normalizeIds, page, qty, report, sorted, within, type SortBy } from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import { PREFIX, invoiceMoney, orderCost, orderTotal, type Id, type Invoice, type InvoicePayment, type OrderStatus, type PaymentStatus, type Product, type SalesOrder, type World } from "../world.ts";
import { find, named, recordAction, stamp, userRef, type C } from "./shared.ts";

type Line = SalesOrder["items"][number];
type Span = { start?: string; end?: string };
type Range = { min?: number; max?: number };
type Paging = { limit?: number; cursor?: string };
type ReportPaging = { maxRowsLimit?: number; cursor?: string };

// ---------- reading the world ----------

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "Pending", PROCESSING: "Processing", READY_TO_SHIP: "Ready to ship", DELIVERING: "Delivering", DELIVERED: "Delivered", COMPLETED: "Completed", CANCELED: "Canceled",
};
const NOT_CANCELED: OrderStatus[] = ["PENDING", "PROCESSING", "READY_TO_SHIP", "DELIVERING", "DELIVERED", "COMPLETED"];

/** The sales order tools name payment states differently from the invoice tools and the invoice report. */
const ORDER_PAYMENT: Record<PaymentStatus, string> = { NOT_PAID: "NOT_PAID", PARTIALLY_PAID: "PAYING", PAID: "PAID", OVER_PAID: "OVERPAID" };
const REPORT_PAYMENT: Record<PaymentStatus, string> = { NOT_PAID: "NOT_PAID", PARTIALLY_PAID: "PARTIALLY_PAID", PAID: "FULLY_PAID", OVER_PAID: "OVER_PAID" };

const time = (iso: string) => Date.parse(iso);
const productOf = (w: World, id: Id) => w.products.find((p) => p.id === id)!;
const orderOf = (w: World, inv: Invoice) => w.salesOrders.find((o) => o.id === inv.salesOrderId)!;
const invoicesOf = (w: World, o: SalesOrder) => w.invoices.filter((i) => i.salesOrderId === o.id);
const customerName = (w: World, id: Id) => named(w.companies, id)?.name ?? null;
const userName = (w: World, id: Id | null) => userRef(w, id)?.profile.fullName ?? null;
const shipped = (o: SalesOrder) => o.deliveryDatetime !== null;

function licenseOf(w: World, o: SalesOrder) {
  const location = w.locations.find((l) => l.id === o.locationId);
  return w.licenses.find((l) => l.id === location?.licenseId);
}

/** The latest of a record's own instants and of the changes the activity log holds for it. */
function lastChange(w: World, id: Id, ...instants: (string | null)[]): string {
  const logged = w.actions.filter((a) => a.records.some((r) => r.id === id)).map((a) => a.changedAt);
  return [...instants, ...logged].filter((x): x is string => x !== null).reduce((a, b) => (time(b) > time(a) ? b : a));
}

const orderUpdated = (w: World, o: SalesOrder) => lastChange(w, o.id, o.orderDatetime, o.deliveryDatetime);
const invoiceUpdated = (w: World, inv: Invoice) =>
  lastChange(w, inv.id, inv.invoiceDatetime, ...w.invoicePayments.filter((p) => p.invoiceId === inv.id).map((p) => p.paymentDatetime));

/** What an order has been paid: its invoice's payments, or nothing before it is invoiced. */
function orderMoney(w: World, o: SalesOrder): { total: number; paid: number; status: PaymentStatus } {
  const inv = invoicesOf(w, o)[0];
  return inv ? invoiceMoney(w, inv) : { total: orderTotal(o), paid: 0, status: "NOT_PAID" };
}

/** API for an order the public API created; every other order was entered by a user. */
const orderSource = (w: World, o: SalesOrder) =>
  w.actions.some((a) => a.source === "PUBLIC_API" && a.records.some((r) => r.id === o.id && r.op === "INSERT")) ? "API" : "INTERNAL_USER";

function productFacts(w: World, p: Product) {
  const category = w.categories.find((c) => c.id === p.categoryId)!;
  return {
    category: category.name,
    subcategory: category.subcategories.find((s) => s.id === p.subcategoryId)?.name ?? null,
    group: named(w.groups, p.groupId)?.name ?? null,
    brand: named(w.companies, p.brandId)?.name ?? null,
    // Documented as always present; every product in this world has a vendor.
    vendor: named(w.companies, p.vendorId)?.name ?? "",
    vendorId: p.vendorId ?? "",
  };
}

// ---------- filters ----------

const oneOf = (wanted: readonly unknown[] | undefined, value: unknown) => !wanted || wanted.includes(value);
const between = (n: number, r: Range | undefined) => (r?.min === undefined || n >= r.min) && (r?.max === undefined || n <= r.max);
const inSpan = (w: World, iso: string | null, s: Span | undefined) => within(iso, bound(s?.start, "after", w.timezone), bound(s?.end, "before", w.timezone));

/** A dollar amount given as a number or a numeric string. */
function amount(value: string | number | undefined, input: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolError(`${input} must be a dollar amount, e.g. 250 or "250.00".`);
  return n;
}

/** A case-insensitive substring pattern where % matches any run of characters and _ any one character. */
function wildcard(term: string): RegExp {
  const source = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*").replaceAll("_", ".");
  return new RegExp(source, "i");
}

/** Order-level filters, resolved from whichever input names a tool uses. */
type OrderQuery = {
  ids?: Id[]; customerIds?: Id[]; excludeCustomerIds?: Id[]; customerGroupIds?: Id[]; ownerIds?: Id[]; menuIds?: Id[]; licenseIds?: Id[];
  /** Orders with any line of these products, batches or brands. */
  productIds?: Id[]; batchIds?: Id[]; brandIds?: Id[];
  statuses?: readonly string[];
  /** In the sales order vocabulary: NOT_PAID, PAYING, PAID, OVERPAID. */
  payment?: readonly string[];
  ordered?: Span; delivered?: Span; due?: Span; total?: Range;
  recordOnly?: boolean; matchedWithComplianceTransfer?: boolean; sources?: readonly string[];
  search?: (o: SalesOrder) => boolean;
};

/** True when no ids are given, or when a line of the order has one of them. */
const hasLine = (o: SalesOrder, ids: Id[] | undefined, of: (i: Line) => Id | null) => !ids || o.items.some((i) => oneOf(ids, of(i)));

function orderMatches(w: World, o: SalesOrder, q: OrderQuery): boolean {
  return oneOf(q.ids, o.id) && oneOf(q.customerIds, o.customerId) && !q.excludeCustomerIds?.includes(o.customerId)
    && oneOf(q.customerGroupIds, w.companies.find((c) => c.id === o.customerId)?.groupId)
    && oneOf(q.ownerIds, o.ownerId) && oneOf(q.menuIds, o.menuId) && oneOf(q.licenseIds, licenseOf(w, o)?.id)
    && hasLine(o, q.productIds, (i) => i.productId) && hasLine(o, q.batchIds, (i) => i.batchId) && hasLine(o, q.brandIds, (i) => productOf(w, i.productId).brandId)
    && oneOf(q.statuses, o.status) && oneOf(q.payment, ORDER_PAYMENT[orderMoney(w, o).status])
    && inSpan(w, o.orderDatetime, q.ordered) && inSpan(w, o.deliveryDatetime, q.delivered) && inSpan(w, o.dueDatetime, q.due) && between(orderTotal(o), q.total)
    // No order in this world is record-only or matched to a Metrc transfer.
    && !q.recordOnly && !q.matchedWithComplianceTransfer
    && oneOf(q.sources, orderSource(w, o)) && (!q.search || q.search(o));
}

/** Order number or customer name, case-insensitive; the reports skip the name for terms under two characters. */
const orderSearch = (w: World, term: string | undefined, nameMinLength = 0) =>
  term === undefined ? undefined : (o: SalesOrder) => matches(term, o.orderNumber) || (term.length >= nameMinLength && matches(term, customerName(w, o.customerId)));

/** Line-level filters of the product and line item reports. */
type LineQuery = {
  categoryIds?: Id[]; subcategoryIds?: Id[]; tagIds?: Id[]; vendorIds?: Id[]; brandIds?: Id[]; groupIds?: Id[]; locationIds?: Id[];
  search?: string; sample?: "ONLY" | "EXCLUDE"; tradeSamplePackages?: "ONLY" | "EXCLUDE";
};

function lineMatches(w: World, o: SalesOrder, line: Line, q: LineQuery): boolean {
  const p = productOf(w, line.productId);
  return oneOf(q.categoryIds, p.categoryId) && oneOf(q.subcategoryIds, p.subcategoryId) && (!q.tagIds || p.tagIds.some((t) => q.tagIds!.includes(t)))
    && oneOf(q.vendorIds, p.vendorId) && oneOf(q.brandIds, p.brandId) && oneOf(q.groupIds, p.groupId) && oneOf(q.locationIds, o.locationId)
    && matches(q.search, p.name, p.sku)
    // No line is a sample and no package is a trade sample; a line with no package is dropped by either trade sample value.
    && q.sample !== "ONLY" && (!q.tradeSamplePackages || (q.tradeSamplePackages === "EXCLUDE" && line.packageId !== null));
}

/** Invoice filters shared by search-invoices and the invoice report, so the two always agree. */
type InvoiceQuery = {
  ids?: Id[]; customerIds?: Id[]; ownerIds?: Id[]; productIds?: Id[]; batchIds?: Id[]; licenseIds?: Id[];
  invoiced?: Span; due?: Span; paid?: Range; total?: Range;
  payment?: readonly PaymentStatus[]; orderStatuses?: readonly string[]; search?: string;
  voidStatus: "NOT_VOIDED" | "ANY" | "VOIDED";
};

function invoiceMatches(w: World, inv: Invoice, q: InvoiceQuery): boolean {
  const m = invoiceMoney(w, inv), o = orderOf(w, inv);
  return oneOf(q.ids, inv.id) && oneOf(q.customerIds, inv.customerId) && oneOf(q.ownerIds, inv.ownerId)
    && hasLine(o, q.productIds, (i) => i.productId) && hasLine(o, q.batchIds, (i) => i.batchId) && oneOf(q.licenseIds, licenseOf(w, o)?.id)
    && inSpan(w, inv.invoiceDatetime, q.invoiced) && inSpan(w, inv.dueDatetime, q.due) && between(m.paid, q.paid) && between(m.total, q.total)
    && oneOf(q.payment, m.status) && oneOf(q.orderStatuses, o.status) && matches(q.search, inv.invoiceNumber)
    && (q.voidStatus === "ANY" || (q.voidStatus === "VOIDED") === inv.voided);
}

/** Closest match first: the exact number, then numbers that contain the term (shortest first), then matches on other fields. */
function ranked<T>(items: T[], term: string, numberOf: (x: T) => string): T[] {
  const t = term.toLowerCase();
  const score = (x: T) => {
    const n = numberOf(x).toLowerCase();
    return n === t ? 0 : n.includes(t) ? 1 + n.length - t.length : Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort((a, b) => score(a) - score(b));
}

/** Refuses inputs that apply only to other values of rowsPer. */
function onlyFor(args: object, rowsPer: string, inputs: string[], grains: string[]): void {
  const used = inputs.find((k) => (args as Record<string, unknown>)[k] !== undefined);
  if (used && !grains.includes(rowsPer)) throw new ToolError(`${used} applies to rowsPer ${grains.join(" or ")} only.`);
}

// ---------- record renderers ----------

const batchRef = (w: World, id: Id | null) => {
  const b = id ? w.batches.find((x) => x.id === id) : undefined;
  return b ? { id: b.id, name: b.batchNumber } : null;
};
const packageRef = (w: World, id: Id | null) => {
  const k = id ? w.packages.find((x) => x.id === id) : undefined;
  return k ? { id: k.id, metrcLabel: k.metrcLabel } : null;
};

/** A sales order as search-sales-orders lists it; get-sales-order builds on it. */
function orderRow(w: World, o: SalesOrder) {
  return {
    id: o.id, customFields: [], orderNumber: o.orderNumber, status: STATUS_LABEL[o.status], recordOnly: false, color: null,
    total: money(orderTotal(o)), totalCharges: money(0), totalReturned: money(0),
    orderDate: o.orderDatetime, dueDate: o.dueDatetime, deliveryDate: o.deliveryDatetime, createdDate: o.orderDatetime, updatedDate: orderUpdated(w, o),
    url: `https://app.distru.com/sales-orders/${o.id.split("_")[1]}`,
    customer: named(w.companies, o.customerId), owner: userRef(w, o.ownerId), location: named(w.locations, o.locationId),
    // The world does not match orders to Metrc transfers.
    complianceManifestNumber: null,
  };
}

/** What an order line and an invoice line share. */
function lineRef(w: World, o: SalesOrder, i: Line) {
  return {
    id: i.id, price: money(i.unitPrice), priceBase: money(i.unitPrice), isSample: false, note: null,
    product: named(w.products, i.productId)!, batch: batchRef(w, i.batchId), location: named(w.locations, o.locationId),
  };
}

type OrderIncludes = {
  includeInvoices?: boolean; includeOrderItems?: boolean; includeOrderItemCostItems?: boolean; includeOrderItemPriceTiers?: boolean;
  includeOrderCharges?: boolean; includeOriginalOrders?: boolean;
};

function orderItems(w: World, o: SalesOrder, inc: OrderIncludes) {
  // Rows of one product, batch and price are one line. Every row here prices at its own price: the world has no tiers.
  const lines: string[] = [];
  return o.items.map((i) => {
    const key = `${i.productId}|${i.batchId}|${i.unitPrice}`;
    if (!lines.includes(key)) lines.push(key);
    const p = productOf(w, i.productId);
    return {
      ...lineRef(w, o, i), quantity: qty(i.quantity), metrcQuantity: null,
      product: { id: p.id, name: p.name, unitType: named(w.unitTypes, p.unitTypeId)! },
      cost: money(shipped(o) ? i.quantity * i.unitCost : 0), revenue: shipped(o) ? money(i.quantity * i.unitPrice) : null,
      package: packageRef(w, i.packageId), lineGroup: lines.indexOf(key) + 1,
      ...(inc.includeOrderItemPriceTiers ? { priceTierMode: "AUTO", priceTier: null } : {}),
      ...(inc.includeOrderItemCostItems ? { costItems: null } : {}),
    };
  });
}

function orderDetail(w: World, o: SalesOrder, inc: OrderIncludes) {
  const row = orderRow(w, o), license = licenseOf(w, o);
  return {
    ...row,
    // Locations carry no street address in this world, and customers have no saved shipping or billing locations.
    location: row.location && { ...row.location, address: "" }, shippingLocation: null, billingLocation: null,
    menu: named(w.menus, o.menuId), license: license ? { id: license.id, licenseNumber: license.licenseNumber } : null, combinedOrder: null,
    externalNotes: null, internalNotes: o.internalNotes,
    // Nothing fulfilled costs nothing yet; revenue is null until stock ships, as the page says.
    cost: money(shipped(o) ? orderCost(o) : 0), revenue: shipped(o) ? money(orderTotal(o)) : null,
    ...(inc.includeInvoices ? { invoices: invoicesOf(w, o).map((inv) => invoiceLink(w, inv)) } : {}),
    ...(inc.includeOrderItems || inc.includeOrderItemCostItems || inc.includeOrderItemPriceTiers ? { orderItems: orderItems(w, o, inc) } : {}),
    ...(inc.includeOrderCharges ? { orderCharges: [] } : {}),
    ...(inc.includeOriginalOrders ? { originalOrders: [] } : {}),
  };
}

/** An invoice as search-invoices lists it; get-invoice builds on it. */
function invoiceRow(w: World, inv: Invoice) {
  const m = invoiceMoney(w, inv), o = orderOf(w, inv), updated = invoiceUpdated(w, inv);
  return {
    id: inv.id, customFields: [], invoiceNumber: inv.invoiceNumber, paymentStatus: m.status, color: null,
    total: money(m.total), paid: money(m.paid), creditsApplied: null, remainingAmount: money(m.remaining),
    qbInvoiceId: null, qbSyncStatus: null,
    // The world keeps no void time; the void is the invoice's last change.
    voidedAt: inv.voided ? updated : null,
    invoiceDate: inv.invoiceDatetime, dueDate: inv.dueDatetime, createdDate: inv.invoiceDatetime, updatedDate: updated,
    customer: named(w.companies, inv.customerId), owner: userRef(w, inv.ownerId), salesOrder: { id: o.id, orderNumber: o.orderNumber }, billingLocation: null,
  };
}

function invoiceDetail(w: World, inv: Invoice, inc: { includeInvoiceItems?: boolean; includeInvoiceCharges?: boolean }) {
  const row = invoiceRow(w, inv), o = orderOf(w, inv);
  const customer = w.companies.find((c) => c.id === inv.customerId);
  return {
    ...row, subtotal: row.total, paymentsCollected: row.paid, externalNotes: null,
    paymentTermName: named(w.paymentTerms, customer?.paymentTermId ?? null)?.name ?? null,
    // An invoice line is its order line in this world, so it carries the order line's id.
    ...(inc.includeInvoiceItems ? { invoiceItems: o.items.map((i) => ({ id: i.id, quantity: qty(i.quantity), orderItem: lineRef(w, o, i) })) } : {}),
    ...(inc.includeInvoiceCharges ? { invoiceCharges: [] } : {}),
  };
}

const invoiceRef = (w: World, inv: Invoice) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, paymentStatus: invoiceMoney(w, inv).status });

function invoiceLink(w: World, inv: Invoice) {
  const m = invoiceMoney(w, inv);
  return { ...invoiceRef(w, inv), total: money(m.total), paid: money(m.paid), remainingAmount: money(m.remaining) };
}

/** Payments carry no number in the world; this one is derived from the id, so it is stable. */
const paymentNumber = (p: InvoicePayment) => `PAY-${p.id.split("_")[1]}`;
const paymentUpdated = (w: World, p: InvoicePayment) => lastChange(w, p.id, p.paymentDatetime);

function paymentRow(w: World, p: InvoicePayment) {
  const inv = w.invoices.find((i) => i.id === p.invoiceId)!, updated = paymentUpdated(w, p);
  return {
    id: p.id, paymentNumber: paymentNumber(p), paymentDate: p.paymentDatetime, status: p.voided ? "VOIDED" : "POSTED", voidedAt: p.voided ? updated : null,
    received: { amount: money(p.amount), paymentMethod: named(w.paymentMethods, p.paymentMethodId) },
    // The world has no customer credits, and an invoice's paid amount counts every posted payment in full.
    creditAmount: money(0), appliedAmount: money(p.amount), overpaidAmount: money(0), note: p.note,
    customer: named(w.companies, inv.customerId), invoice: invoiceRef(w, inv),
    qbDepositAccount: null, qbPaymentId: null, qbSyncStatus: null, insertedAt: p.paymentDatetime, updatedAt: updated,
  };
}

// ---------- report helpers ----------

const MAX_REPORT_ROWS = 5000;

function reportPage<R>(info: { report: string; dateRange: string; columns: Record<string, string> }, rows: R[], args: ReportPaging) {
  if (args.maxRowsLimit !== undefined && args.maxRowsLimit > MAX_REPORT_ROWS) throw new ToolError(`maxRowsLimit must be at most ${MAX_REPORT_ROWS}.`);
  const columns = Object.entries(info.columns).map(([key, label]) => ({ key, label }));
  return report({ ...info, columns }, rows, args);
}

/** The default range of the reports: the 30 calendar days ending today. */
const lastThirtyDays = (w: World): Span => ({ start: addDays(w.today, -29), end: w.today });

/** `orderDatetime 2026-07-01 to 2026-09-30; ...`, naming each date filter the report applied. */
function dateRange(ranges: [string, Span | undefined][]): string {
  const set = ranges.filter((r): r is [string, Span] => r[1] !== undefined);
  return set.map(([name, s]) => `${name} ${s.start ?? "any"} to ${s.end ?? "any"}`).join("; ") || "all dates";
}

/** Report timestamps: `YYYY-MM-DD HH:MM:SS.ffffff`, no offset, in company time or in UTC. */
const reportTime = (w: World, iso: string | null) => iso && `${isoIn(w.timezone, new Date(iso)).slice(0, 19).replace("T", " ")}.000000`;
const reportUtc = (iso: string | null) => iso && `${new Date(iso).toISOString().slice(0, 19).replace("T", " ")}.000000`;
const reportDay = (w: World, iso: string) => dayIn(w.timezone, new Date(iso));
const usDay = (ymd: string) => { const [y, m, d] = ymd.split("-"); return `${+m!}/${+d!}/${y}`; };

const orderDates = (w: World, o: SalesOrder) => ({
  orderDate: reportTime(w, o.orderDatetime)!, orderDateUtc: reportUtc(o.orderDatetime)!,
  deliveryDate: reportTime(w, o.deliveryDatetime), deliveryDateUtc: reportUtc(o.deliveryDatetime),
  dueDate: reportTime(w, o.dueDatetime), dueDateUtc: reportUtc(o.dueDatetime),
});

const sum = <T>(xs: T[], of: (x: T) => number) => xs.reduce((n, x) => n + of(x), 0);

// ---------- report rows ----------

const INVOICE_COLUMNS = {
  invoiceDate: "Invoice date", invoiceNumber: "Invoice #", invoiceId: "Invoice ID", dueDate: "Due date", salesOrder: "Sales order", salesOrderId: "Sales order ID",
  customer: "Customer", customerId: "Customer ID", status: "Payment status", paid: "Paid", outstanding: "Outstanding", lineItemSubtotal: "Line item subtotal",
  totalTaxes: "Total taxes", taxSummary: "Taxes", totalCharges: "Total charges", chargeSummary: "Charges", totalDiscounts: "Total discounts", discountSummary: "Discounts",
  total: "Total", owner: "Owner", invoiceOwnerId: "Owner ID",
};

function invoiceReportRow(w: World, inv: Invoice) {
  const m = invoiceMoney(w, inv), o = orderOf(w, inv);
  return {
    invoiceDate: reportDay(w, inv.invoiceDatetime), invoiceNumber: inv.invoiceNumber, invoiceId: inv.id, dueDate: reportDay(w, inv.dueDatetime),
    salesOrder: o.orderNumber, salesOrderId: o.id, customer: customerName(w, inv.customerId) ?? "", customerId: inv.customerId,
    status: REPORT_PAYMENT[m.status], paid: money(m.paid), outstanding: money(inv.voided ? 0 : m.total - m.paid),
    lineItemSubtotal: money(m.total), totalTaxes: money(0), taxSummary: null, totalCharges: money(0), chargeSummary: null, totalDiscounts: money(0), discountSummary: null,
    total: money(m.total), owner: userName(w, inv.ownerId), invoiceOwnerId: inv.ownerId, customFields: [],
  };
}

const ORDER_COLUMNS = {
  orderDate: "Order date", orderDateUtc: "Order date (UTC)", deliveryDate: "Delivery date", deliveryDateUtc: "Delivery date (UTC)", dueDate: "Due date", dueDateUtc: "Due date (UTC)",
  orderNumber: "Order #", salesOrderId: "Sales order ID", recordOnly: "Record only", customer: "Customer", customerId: "Customer ID", status: "Status",
  paid: "Paid", outstanding: "Outstanding", subtotal: "Subtotal", taxes: "Taxes", discountsTaxesNotIncluded: "Discounts (taxes not included)",
  chargesTaxesNotIncluded: "Charges (taxes not included)", returns: "Returns", total: "Total", owner: "Owner", salesOrderOwnerId: "Owner ID", orderSource: "Order source",
};

function orderReportRow(w: World, o: SalesOrder) {
  const m = orderMoney(w, o);
  return {
    ...orderDates(w, o), orderNumber: o.orderNumber, salesOrderId: o.id, recordOnly: false, customer: customerName(w, o.customerId), customerId: o.customerId, status: o.status,
    paid: money(m.paid), outstanding: money(o.status === "CANCELED" ? 0 : m.total - m.paid),
    subtotal: money(m.total), taxes: money(0), discountsTaxesNotIncluded: money(0), chargesTaxesNotIncluded: money(0), returns: money(0), total: money(m.total),
    owner: userName(w, o.ownerId), salesOrderOwnerId: o.ownerId, orderSource: orderSource(w, o), customFields: [],
  };
}

const LINE_COLUMNS = {
  lineItemId: "Line item ID", orderId: "Order ID", orderDate: "Order date", orderDateUtc: "Order date (UTC)", deliveryDate: "Delivery date", deliveryDateUtc: "Delivery date (UTC)",
  dueDate: "Due date", dueDateUtc: "Due date (UTC)", orderNumber: "Order #", status: "Status", product: "Product", productId: "Product ID", productSku: "SKU",
  defaultUnitCost: "Default unit cost", defaultUnitPrice: "Default unit price", defaultWholesalePrice: "Default wholesale price", brand: "Brand", brandId: "Brand ID",
  vendor: "Vendor", vendorId: "Vendor ID", orderItemPrice: "Price", priceBase: "Base price", priceTierMode: "Price tier mode", priceTier: "Price tier",
  returnedQuantity: "Returned quantity", quantity: "Quantity", category: "Category", subcategory: "Subcategory", group: "Group", customer: "Customer", customerId: "Customer ID",
  salesRep: "Sales rep", salesOrderOwnerId: "Sales rep ID", invoiceNumbers: "Invoices", upc: "UPC", batchNumber: "Batch #", batchId: "Batch ID", packageId: "Package ID",
  sourcePackage: "Source package",
};

function lineReportRow(w: World, o: SalesOrder, i: Line) {
  const p = productOf(w, i.productId), f = productFacts(w, p);
  return {
    lineItemId: i.id, orderId: o.id, ...orderDates(w, o), orderNumber: o.orderNumber, status: o.status, product: p.name, productId: p.id, productSku: p.sku,
    defaultUnitCost: money(p.unitCost), defaultUnitPrice: money(p.unitPrice), defaultWholesalePrice: null,
    brand: f.brand, brandId: p.brandId, vendor: f.vendor, vendorId: f.vendorId, orderItemPrice: money(i.unitPrice), priceBase: money(i.unitPrice),
    priceTierMode: "AUTO", priceTier: null, returnedQuantity: qty(0), quantity: qty(i.quantity), category: f.category, subcategory: f.subcategory, group: f.group,
    customer: customerName(w, o.customerId), customerId: o.customerId, salesRep: userName(w, o.ownerId), salesOrderOwnerId: o.ownerId,
    invoiceNumbers: invoicesOf(w, o).map((inv) => inv.invoiceNumber).join(", ") || null, upc: null,
    batchNumber: batchRef(w, i.batchId)?.name ?? null, batchId: i.batchId, packageId: i.packageId, sourcePackage: packageRef(w, i.packageId)?.metrcLabel ?? null, customFields: [],
  };
}

const TOTALS_COLUMNS: Record<string, Record<string, string>> = {
  CUSTOMER: {
    name: "Customer", customerId: "Customer ID", lastOrderDate: "Last order date", orderCount: "Orders", totalReceived: "Total received", totalSales: "Total sales",
    owner: "Owner", customerOwnerId: "Owner ID", category: "Category", relationshipType: "Relationship",
  },
  PRODUCT: {
    name: "Product", productId: "Product ID", sku: "SKU", quantitySold: "Quantity sold", totalSales: "Total sales", unitType: "Unit", category: "Category",
    subcategory: "Subcategory", group: "Group", vendor: "Vendor", vendorId: "Vendor ID", productOwner: "Product owner", unitCost: "Unit cost", salePrice: "Sale price",
    wholesalePrice: "Wholesale price", shippedFromLicense: "Shipped from license", upc: "UPC",
  },
  SALES_REP: { leaderboardRank: "Rank", user: "Sales rep", userId: "User ID", orderCount: "Orders", salesPreTax: "Sales pre-tax", totalSales: "Total sales" },
};

const TAX_COLUMNS = { taxType: "Tax", taxRate: "Rate", totalTax: "Total tax" };

/** One row per customer with a counted order, highest total sales first. */
function customerTotals(w: World, orders: SalesOrder[]) {
  const ids = [...new Set(orders.map((o) => o.customerId))];
  return ids
    .map((id) => { const own = orders.filter((o) => o.customerId === id); return { id, own, sales: sum(own, orderTotal) }; })
    .sort((a, b) => b.sales - a.sales)
    .map(({ id, own, sales }) => {
      const c = w.companies.find((x) => x.id === id)!;
      const latest = w.salesOrders.filter((o) => o.customerId === id && o.status !== "CANCELED").map((o) => o.orderDatetime).sort((a, b) => time(b) - time(a))[0];
      return {
        name: c.name, customerId: c.id, lastOrderDate: latest ? usDay(reportDay(w, latest)) : null, orderCount: String(own.length),
        totalReceived: money(sum(own, (o) => orderMoney(w, o).paid)), totalSales: money(sales),
        // Customers have no category in this world.
        owner: userName(w, c.ownerId), customerOwnerId: c.ownerId, category: null, relationshipType: c.relationship, customFields: [],
      };
    });
}

/** One row per product sold on a counted line, highest total sales first. */
function productTotals(w: World, orders: SalesOrder[], lq: LineQuery) {
  const lines = orders.flatMap((o) => o.items.filter((i) => lineMatches(w, o, i, lq)).map((i) => ({ o, i })));
  const ids = [...new Set(lines.map((l) => l.i.productId))];
  return ids
    .map((id) => { const own = lines.filter((l) => l.i.productId === id); return { id, own, sales: sum(own, (l) => l.i.quantity * l.i.unitPrice) }; })
    .sort((a, b) => b.sales - a.sales)
    .map(({ id, own, sales }) => {
      const p = productOf(w, id), f = productFacts(w, p);
      const licenses = [...new Set(own.map((l) => licenseOf(w, l.o)?.licenseNumber ?? null))];
      return {
        name: p.name, productId: p.id, sku: p.sku, quantitySold: qty(sum(own, (l) => l.i.quantity)), totalSales: money(sales), unitType: named(w.unitTypes, p.unitTypeId)!.name,
        category: f.category, subcategory: f.subcategory, group: f.group, vendor: f.vendor, vendorId: f.vendorId, productOwner: null,
        unitCost: money(p.unitCost), salePrice: money(p.unitPrice), wholesalePrice: null,
        // A product shipped from several licenses has no single one to name.
        shippedFromLicense: licenses.length === 1 ? licenses[0]! : null, upc: null, customFields: [],
      };
    });
}

/** Every rep, or the listed ones, ranked by total sales; reps without counted orders rank with 0s. */
function repTotals(w: World, orders: SalesOrder[], ownerIds: Id[] | undefined) {
  return w.users
    .filter((u) => oneOf(ownerIds, u.id))
    .map((u) => { const own = orders.filter((o) => o.ownerId === u.id); return { u, own, sales: sum(own, orderTotal) }; })
    .sort((a, b) => b.sales - a.sales || userName(w, a.u.id)!.localeCompare(userName(w, b.u.id)!))
    .map(({ u, own, sales }, rank) => ({
      leaderboardRank: String(rank + 1), user: userName(w, u.id), userId: u.id, orderCount: String(own.length),
      // The world has no taxes, so sales before and after tax are the same.
      salesPreTax: money(sales), totalSales: money(sales), customFields: [],
    }));
}

// ---------- PDFs ----------

/** The record a PDF is made from: `type` and `name` are how the activity log names it. */
type PdfSource = { type: string; id: string; name: string; filename: string };

const noLabResult = (what: string) => new ToolError(`No lab result file found for ${what}, so there is no COA to generate.`);

/** How each document resolves its id. Documents the world has no records or lab files for raise the error the real server would. */
const PDF_SOURCES: Record<string, (w: World, id: string) => PdfSource> = {
  INVOICE: (w, id) => {
    const inv = find(w.invoices, normalizeId(id, PREFIX.invoice), "invoice");
    return { type: "INVOICE", id: inv.id, name: inv.invoiceNumber, filename: `Invoice ${inv.invoiceNumber}.pdf` };
  },
  SALES_ORDER: (w, id) => {
    const o = find(w.salesOrders, normalizeId(id, PREFIX.salesOrder), "sales order");
    return { type: "SALES_ORDER", id: o.id, name: o.orderNumber, filename: `Order slip ${o.orderNumber}.pdf` };
  },
  PURCHASE_ORDER: (w, id) => {
    const po = find(w.purchaseOrders, normalizeId(id, PREFIX.purchaseOrder), "purchase order");
    if (po.status === "DRAFT") throw new ToolError(`${po.purchaseNumber} is a draft: draft purchase orders have no PDF.`);
    return { type: "PURCHASE_ORDER", id: po.id, name: po.purchaseNumber, filename: `Purchase order ${po.purchaseNumber}.pdf` };
  },
  METRC_MANIFEST: (w, id) => {
    const m = w.metrcManifests.find((x) => x.manifestNumber === id);
    if (!m) throw new ToolError(`No Metrc manifest found with number ${id}.`);
    return { type: "METRC_MANIFEST", id: m.manifestNumber, name: m.manifestNumber, filename: `Manifest ${m.manifestNumber}.pdf` };
  },
  INVOICE_COA: (w, id) => { throw noLabResult(`the line items of ${find(w.invoices, normalizeId(id, PREFIX.invoice), "invoice").invoiceNumber}`); },
  SALES_ORDER_COA: (w, id) => { throw noLabResult(`the line items of ${find(w.salesOrders, normalizeId(id, PREFIX.salesOrder), "sales order").orderNumber}`); },
  BATCH_COA: (w, id) => { throw noLabResult(`batch ${find(w.batches, normalizeId(id, PREFIX.batch), "batch").batchNumber}`); },
  PACKAGE_COA: (w, id) => { throw noLabResult(`package ${find(w.packages, normalizeId(id, PREFIX.package), "package").metrcLabel}`); },
  ASSEMBLY: (_w, id) => { throw new ToolError(`No assembly found with id ${id}.`); },
  TEST_RESULT_COA: (_w, id) => { throw new ToolError(`No test result found with id ${id}.`); },
};

const pdfSource = (w: World, document: string, id: string) => PDF_SOURCES[document]!(w, id);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- tools ----------

type SearchOrdersArgs = Paging & {
  ids?: string[]; customerIds?: string[]; ownerIds?: string[]; menuIds?: string[]; productIds?: string[]; batchIds?: string[];
  orderDateAfter?: string; orderDateBefore?: string; deliveryDateAfter?: string; deliveryDateBefore?: string; dueDateAfter?: string; dueDateBefore?: string;
  paymentStatus?: string[]; status?: string[]; totalGreaterThanOrEqualTo?: number; totalLessThanOrEqualTo?: number; recordOnly?: boolean; search?: string; sortBy?: SortBy;
};

type SearchInvoicesArgs = Paging & {
  ids?: string[]; customerIds?: string[]; ownerIds?: string[]; productIds?: string[];
  invoiceDateAfter?: string; invoiceDateBefore?: string; dueDateAfter?: string; dueDateBefore?: string;
  paidGreaterThanOrEqualTo?: number; paidLessThanOrEqualTo?: number; totalGreaterThanOrEqualTo?: number; totalLessThanOrEqualTo?: number;
  paymentStatus?: PaymentStatus[]; salesOrderStatus?: string[]; search?: string; voidStatus?: InvoiceQuery["voidStatus"]; sortBy?: SortBy;
};

type SearchPaymentsArgs = Paging & {
  appliedAmountMin?: string | number; appliedAmountMax?: string | number; customerIds?: string[]; invoiceIds?: string[]; paymentMethodIds?: string[];
  paymentDateAfter?: string; paymentDateBefore?: string; paymentNumber?: string; search?: string; status?: "ALL" | "POSTED" | "VOIDED"; sortBy?: SortBy;
};

type InvoiceReportArgs = ReportPaging & {
  batchIds?: string[]; customerIds?: string[]; productIds?: string[]; shippedFromLicenseIds?: string[]; dueDatetime?: Span; invoiceDatetime?: Span;
  orderStatuses?: string[]; paid?: Range; total?: Range; search?: string; statuses?: string[]; voidStatus?: InvoiceQuery["voidStatus"];
};

type SalesTotalsArgs = ReportPaging & {
  rowsPer: "CUSTOMER" | "PRODUCT" | "SALES_REP"; orderDatetime?: Span; statuses?: string[]; ownerIds?: string[]; search?: string;
  customerGroupIds?: string[]; customerIds?: string[]; excludeCustomerIds?: string[]; locationIds?: string[]; shippedFromLicenseIds?: string[];
  productCategoryIds?: string[]; productSubcategoryIds?: string[]; productTagIds?: string[]; vendorIds?: string[]; brandIds?: string[]; productGroupIds?: string[];
};

type SalesOrdersReportArgs = ReportPaging & {
  rowsPer: "ORDER" | "LINE_ITEM" | "TAX_RATE"; orderDatetime?: Span; deliveryDatetime?: Span; dueDatetime?: Span;
  batchIds?: string[]; brandIds?: string[]; customerGroupIds?: string[]; customerIds?: string[]; menuIds?: string[]; productIds?: string[]; shippedFromLicenseIds?: string[];
  matchedWithComplianceTransfer?: boolean; orderSources?: string[]; paymentStatuses?: string[]; search?: string; statuses?: string[]; total?: Range;
  productGroupIds?: string[]; productCategoryIds?: string[]; productSubcategoryIds?: string[]; productTagIds?: string[]; vendorIds?: string[];
  sample?: "ONLY" | "EXCLUDE"; tradeSamplePackages?: "ONLY" | "EXCLUDE";
};

type PdfArgs = { document: string; id: string };

const LINE_ONLY = ["productGroupIds", "sample", "tradeSamplePackages", "productCategoryIds", "productSubcategoryIds", "productTagIds", "vendorIds"];
const PRODUCT_ONLY = ["customerIds", "excludeCustomerIds", "locationIds", "shippedFromLicenseIds", "productCategoryIds", "productSubcategoryIds", "productTagIds", "vendorIds", "brandIds", "productGroupIds"];

export const tools = [
  defineTool<World>({
    name: "search-sales-orders",
    supports: [
      "limit", "cursor", "batchIds", "customerIds", "deliveryDateAfter", "deliveryDateBefore", "dueDateAfter", "dueDateBefore", "ids", "menuIds",
      "orderDateAfter", "orderDateBefore", "ownerIds", "paymentStatus", "productIds", "search", "status", "totalGreaterThanOrEqualTo", "totalLessThanOrEqualTo",
      "recordOnly", "sortBy",
    ],
    run(args: SearchOrdersArgs, { world: w }) {
      const found = w.salesOrders.filter((o) => orderMatches(w, o, {
        ids: normalizeIds(args.ids, PREFIX.salesOrder), customerIds: normalizeIds(args.customerIds, PREFIX.company), ownerIds: normalizeIds(args.ownerIds, PREFIX.user),
        menuIds: normalizeIds(args.menuIds, PREFIX.menu), productIds: normalizeIds(args.productIds, PREFIX.product), batchIds: normalizeIds(args.batchIds, PREFIX.batch),
        ordered: { start: args.orderDateAfter, end: args.orderDateBefore }, delivered: { start: args.deliveryDateAfter, end: args.deliveryDateBefore },
        due: { start: args.dueDateAfter, end: args.dueDateBefore }, total: { min: args.totalGreaterThanOrEqualTo, max: args.totalLessThanOrEqualTo },
        statuses: args.status, payment: args.paymentStatus, recordOnly: args.recordOnly, search: orderSearch(w, args.search),
      }));
      const order = args.search
        ? ranked(found, args.search, (o) => o.orderNumber)
        : sorted(found, args.sortBy, {
          DUE_DATE: (o) => time(o.dueDatetime), INSERTED_AT: (o) => time(o.orderDatetime), ORDER_DATE: (o) => time(o.orderDatetime),
          ORDER_NUMBER: (o) => o.orderNumber, TOTAL: orderTotal, UPDATED_AT: (o) => time(orderUpdated(w, o)),
        }, { field: "UPDATED_AT", direction: "DESC" });
      return page(order, args, (o) => orderRow(w, o));
    },
  }),

  defineTool<World>({
    name: "get-sales-order",
    supports: ["id", "includeInvoices", "includeOrderItems", "includeOrderItemCostItems", "includeOrderItemPriceTiers", "includeOrderCharges", "includeOriginalOrders"],
    run(args: OrderIncludes & { id: string }, { world: w }) {
      const id = normalizeId(args.id, PREFIX.salesOrder);
      const o = w.salesOrders.find((x) => x.id === id);
      return { salesOrder: o ? orderDetail(w, o, args) : null };
    },
  }),

  defineTool<World>({
    name: "search-invoices",
    supports: [
      "limit", "cursor", "customerIds", "dueDateAfter", "dueDateBefore", "ids", "invoiceDateAfter", "invoiceDateBefore", "ownerIds",
      "paidGreaterThanOrEqualTo", "paidLessThanOrEqualTo", "paymentStatus", "productIds", "salesOrderStatus", "search",
      "totalGreaterThanOrEqualTo", "totalLessThanOrEqualTo", "voidStatus", "sortBy",
    ],
    run(args: SearchInvoicesArgs, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.invoice);
      const found = w.invoices.filter((inv) => invoiceMatches(w, inv, {
        ids, customerIds: normalizeIds(args.customerIds, PREFIX.company), ownerIds: normalizeIds(args.ownerIds, PREFIX.user), productIds: normalizeIds(args.productIds, PREFIX.product),
        invoiced: { start: args.invoiceDateAfter, end: args.invoiceDateBefore }, due: { start: args.dueDateAfter, end: args.dueDateBefore },
        paid: { min: args.paidGreaterThanOrEqualTo, max: args.paidLessThanOrEqualTo }, total: { min: args.totalGreaterThanOrEqualTo, max: args.totalLessThanOrEqualTo },
        payment: args.paymentStatus, orderStatuses: args.salesOrderStatus, search: args.search, voidStatus: args.voidStatus ?? (ids ? "ANY" : "NOT_VOIDED"),
      }));
      const order = args.search
        ? ranked(found, args.search, (inv) => inv.invoiceNumber)
        : sorted(found, args.sortBy, {
          DUE_DATE: (inv) => time(inv.dueDatetime), INSERTED_AT: (inv) => time(inv.invoiceDatetime), INVOICE_DATE: (inv) => time(inv.invoiceDatetime),
          INVOICE_NUMBER: (inv) => inv.invoiceNumber, REMAINING_AMOUNT: (inv) => invoiceMoney(w, inv).remaining, TOTAL: (inv) => invoiceMoney(w, inv).total,
          UPDATED_AT: (inv) => time(invoiceUpdated(w, inv)),
        }, { field: "UPDATED_AT", direction: "DESC" });
      return page(order, args, (inv) => invoiceRow(w, inv));
    },
  }),

  defineTool<World>({
    name: "get-invoice",
    supports: ["id", "includeInvoiceItems", "includeInvoiceCharges"],
    run(args: { id: string; includeInvoiceItems?: boolean; includeInvoiceCharges?: boolean }, { world: w }) {
      const id = normalizeId(args.id, PREFIX.invoice);
      const inv = w.invoices.find((x) => x.id === id);
      return { invoice: inv ? invoiceDetail(w, inv, args) : null };
    },
  }),

  defineTool<World>({
    name: "search-invoice-payments",
    supports: [
      "limit", "cursor", "appliedAmountMax", "appliedAmountMin", "customerIds", "invoiceIds", "paymentDateAfter", "paymentDateBefore",
      "paymentMethodIds", "paymentNumber", "search", "status", "sortBy",
    ],
    run(args: SearchPaymentsArgs, { world: w }) {
      const invoiceIds = normalizeIds(args.invoiceIds, PREFIX.invoice), customerIds = normalizeIds(args.customerIds, PREFIX.company);
      const methodIds = normalizeIds(args.paymentMethodIds, PREFIX.paymentMethod);
      const applied = { min: amount(args.appliedAmountMin, "appliedAmountMin"), max: amount(args.appliedAmountMax, "appliedAmountMax") };
      const status = args.status ?? "POSTED";
      const like = args.search === undefined ? undefined : wildcard(args.search);
      const found = w.invoicePayments.filter((p) => {
        const inv = w.invoices.find((i) => i.id === p.invoiceId)!;
        return oneOf(invoiceIds, p.invoiceId) && oneOf(customerIds, inv.customerId) && oneOf(methodIds, p.paymentMethodId)
          && inSpan(w, p.paymentDatetime, { start: args.paymentDateAfter, end: args.paymentDateBefore }) && between(p.amount, applied)
          && matches(args.paymentNumber, paymentNumber(p)) && (status === "ALL" || (status === "VOIDED") === p.voided)
          && (!like || [paymentNumber(p), p.note, inv.invoiceNumber, customerName(w, inv.customerId)].some((f) => f !== null && like.test(f)));
      });
      const order = sorted(found, args.sortBy, {
        INSERTED_AT: (p) => time(p.paymentDatetime), PAYMENT_DATE: (p) => time(p.paymentDatetime), PAYMENT_NUMBER: paymentNumber, UPDATED_AT: (p) => time(paymentUpdated(w, p)),
      }, { field: "PAYMENT_DATE", direction: "DESC" });
      return page(order, args, (p) => paymentRow(w, p));
    },
  }),

  defineTool<World>({
    name: "get-invoice-payment",
    supports: ["id"],
    run(args: { id: string }, { world: w }) {
      // The page says a purchase payment's id is not found here, rather than refused as the wrong kind of id.
      if (args.id.startsWith(`${PREFIX.purchasePayment}_`)) return { invoicePayment: null };
      const id = normalizeId(args.id, PREFIX.invoicePayment);
      const p = w.invoicePayments.find((x) => x.id === id);
      return { invoicePayment: p ? { ...paymentRow(w, p), creditUses: [], overpaymentCredits: [] } : null };
    },
  }),

  defineTool<World>({
    name: "report-invoice-history",
    supports: [
      "cursor", "batchIds", "customerIds", "dueDatetime", "invoiceDatetime", "orderStatuses", "paid", "productIds", "search",
      "shippedFromLicenseIds", "statuses", "total", "voidStatus", "maxRowsLimit",
    ],
    run(args: InvoiceReportArgs, { world: w }) {
      const invoiced = args.invoiceDatetime ?? (args.dueDatetime ? undefined : lastThirtyDays(w));
      const found = w.invoices.filter((inv) => invoiceMatches(w, inv, {
        customerIds: normalizeIds(args.customerIds, PREFIX.company), productIds: normalizeIds(args.productIds, PREFIX.product),
        batchIds: normalizeIds(args.batchIds, PREFIX.batch), licenseIds: normalizeIds(args.shippedFromLicenseIds, PREFIX.license),
        invoiced, due: args.dueDatetime, paid: args.paid, total: args.total, orderStatuses: args.orderStatuses, search: args.search,
        payment: args.statuses?.map((s) => (s === "FULLY_PAID" ? "PAID" : s) as PaymentStatus), voidStatus: args.voidStatus ?? "NOT_VOIDED",
      }));
      const order = args.search
        ? ranked(found, args.search, (inv) => inv.invoiceNumber)
        : [...found].sort((a, b) => b.invoiceNumber.localeCompare(a.invoiceNumber, undefined, { numeric: true }));
      const info = { report: "Invoice history", dateRange: dateRange([["invoiceDatetime", invoiced], ["dueDatetime", args.dueDatetime]]), columns: INVOICE_COLUMNS };
      return reportPage(info, order.map((inv) => invoiceReportRow(w, inv)), args);
    },
  }),

  defineTool<World>({
    name: "report-sales-totals",
    supports: [
      "cursor", "customerGroupIds", "customerIds", "excludeCustomerIds", "locationIds", "orderDatetime", "ownerIds", "search", "shippedFromLicenseIds",
      "statuses", "productCategoryIds", "productSubcategoryIds", "productTagIds", "vendorIds", "brandIds", "productGroupIds", "maxRowsLimit", "rowsPer",
    ],
    run(args: SalesTotalsArgs, { world: w }) {
      onlyFor(args, args.rowsPer, ["customerGroupIds"], ["CUSTOMER"]);
      onlyFor(args, args.rowsPer, ["search"], ["PRODUCT", "SALES_REP"]);
      onlyFor(args, args.rowsPer, PRODUCT_ONLY, ["PRODUCT"]);
      const ordered = args.orderDatetime ?? lastThirtyDays(w);
      const ownerIds = normalizeIds(args.ownerIds, PREFIX.user);
      const orders = w.salesOrders.filter((o) => orderMatches(w, o, {
        ordered, statuses: args.statuses ?? NOT_CANCELED, ownerIds,
        customerIds: normalizeIds(args.customerIds, PREFIX.company), excludeCustomerIds: normalizeIds(args.excludeCustomerIds, PREFIX.company),
        customerGroupIds: normalizeIds(args.customerGroupIds, PREFIX.companyGroup), licenseIds: normalizeIds(args.shippedFromLicenseIds, PREFIX.license),
        search: args.rowsPer === "SALES_REP" ? orderSearch(w, args.search, 2) : undefined,
      }));
      const rows: object[] = args.rowsPer === "CUSTOMER" ? customerTotals(w, orders)
        : args.rowsPer === "SALES_REP" ? repTotals(w, orders, ownerIds)
        : productTotals(w, orders, {
          categoryIds: normalizeIds(args.productCategoryIds, PREFIX.category), subcategoryIds: normalizeIds(args.productSubcategoryIds, PREFIX.subcategory),
          tagIds: normalizeIds(args.productTagIds, PREFIX.tag), vendorIds: normalizeIds(args.vendorIds, PREFIX.company), brandIds: normalizeIds(args.brandIds, PREFIX.company),
          groupIds: normalizeIds(args.productGroupIds, PREFIX.group), locationIds: normalizeIds(args.locationIds, PREFIX.location), search: args.search,
        });
      const info = { report: `Sales totals per ${args.rowsPer.toLowerCase().replace("_", " ")}`, dateRange: dateRange([["orderDatetime", ordered]]), columns: TOTALS_COLUMNS[args.rowsPer]! };
      return reportPage(info, rows, args);
    },
  }),

  defineTool<World>({
    name: "report-sales-orders",
    supports: [
      "cursor", "batchIds", "brandIds", "customerGroupIds", "customerIds", "deliveryDatetime", "dueDatetime", "matchedWithComplianceTransfer", "menuIds",
      "orderDatetime", "orderSources", "paymentStatuses", "productGroupIds", "productIds", "sample", "search", "shippedFromLicenseIds", "statuses", "total",
      "tradeSamplePackages", "productCategoryIds", "productSubcategoryIds", "productTagIds", "vendorIds", "maxRowsLimit", "rowsPer",
    ],
    run(args: SalesOrdersReportArgs, { world: w }) {
      onlyFor(args, args.rowsPer, LINE_ONLY, ["LINE_ITEM"]);
      const ordered = args.orderDatetime ?? (args.deliveryDatetime || args.dueDatetime ? undefined : lastThirtyDays(w));
      const brandIds = normalizeIds(args.brandIds, PREFIX.company);
      const orders = w.salesOrders.filter((o) => orderMatches(w, o, {
        ordered, delivered: args.deliveryDatetime, due: args.dueDatetime, statuses: args.statuses ?? NOT_CANCELED, payment: args.paymentStatuses,
        customerIds: normalizeIds(args.customerIds, PREFIX.company), customerGroupIds: normalizeIds(args.customerGroupIds, PREFIX.companyGroup),
        menuIds: normalizeIds(args.menuIds, PREFIX.menu), licenseIds: normalizeIds(args.shippedFromLicenseIds, PREFIX.license),
        productIds: normalizeIds(args.productIds, PREFIX.product), batchIds: normalizeIds(args.batchIds, PREFIX.batch),
        // On LINE_ITEM the brand picks lines, not orders.
        brandIds: args.rowsPer === "LINE_ITEM" ? undefined : brandIds,
        total: args.total, matchedWithComplianceTransfer: args.matchedWithComplianceTransfer, sources: args.orderSources, search: orderSearch(w, args.search, 2),
      })).sort((a, b) => time(b.orderDatetime) - time(a.orderDatetime));
      const lq: LineQuery = {
        brandIds, groupIds: normalizeIds(args.productGroupIds, PREFIX.group), categoryIds: normalizeIds(args.productCategoryIds, PREFIX.category),
        subcategoryIds: normalizeIds(args.productSubcategoryIds, PREFIX.subcategory), tagIds: normalizeIds(args.productTagIds, PREFIX.tag),
        vendorIds: normalizeIds(args.vendorIds, PREFIX.company), sample: args.sample, tradeSamplePackages: args.tradeSamplePackages,
      };
      const dates = dateRange([["orderDatetime", ordered], ["deliveryDatetime", args.deliveryDatetime], ["dueDatetime", args.dueDatetime]]);
      switch (args.rowsPer) {
        case "ORDER":
          return reportPage({ report: "Sales orders", dateRange: dates, columns: ORDER_COLUMNS }, orders.map((o) => orderReportRow(w, o)), args);
        case "LINE_ITEM": {
          const rows = orders.flatMap((o) => o.items.filter((i) => lineMatches(w, o, i, lq)).map((i) => lineReportRow(w, o, i)));
          return reportPage({ report: "Sales order line items", dateRange: dates, columns: LINE_COLUMNS }, rows, args);
        }
        case "TAX_RATE":
          // The world charges no taxes.
          return reportPage({ report: "Sales order taxes", dateRange: dates, columns: TAX_COLUMNS }, [], args);
      }
    },
  }),

  defineTool<World>({
    name: "download-pdf",
    supports: ["document", "id"],
    run(args: PdfArgs, { world: w, now }) {
      const source = pdfSource(w, args.document, args.id);
      const expires = new Date(now.getTime() + 60 * 60 * 1000);
      const signature = createHash("sha256").update(`${args.document}:${source.id}:${expires.getTime()}`).digest("hex").slice(0, 32);
      return {
        url: `https://files.distru.com/pdf/${args.document.toLowerCase()}/${encodeURIComponent(source.id)}.pdf?expires=${expires.getTime() / 1000}&signature=${signature}`,
        expiresDatetime: isoIn(w.timezone, expires),
        filename: source.filename,
      };
    },
  }),

  defineTool<World>({
    name: "email-pdf",
    supports: ["document", "id", "emailAddresses"],
    run(args: PdfArgs & { emailAddresses: string[] }, c: C) {
      const source = pdfSource(c.world, args.document, args.id);
      if (!args.emailAddresses.length) {
        throw new ToolError("emailAddresses is empty. The tool never picks an address: for an invoice, distru-search-companies returns the customer's invoiceEmail; otherwise ask the user.");
      }
      const bad = args.emailAddresses.filter((a) => !EMAIL.test(a));
      if (bad.length) throw new ToolError(`Not an email address: ${bad.join(", ")}.`);
      c.world.outbox.push({ document: args.document, recordId: source.id, emailAddresses: args.emailAddresses, sentAt: stamp(c) });
      recordAction(c, [{
        type: source.type, id: source.id, name: source.name, op: "UPDATE", rowLabel: null,
        fields: [{ field: "emailedTo", label: "Emailed to", oldValue: null, newValue: args.emailAddresses.join(", ") }],
      }]);
      return { emailedTo: args.emailAddresses };
    },
  }),
];

