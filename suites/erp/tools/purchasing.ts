// Purchase orders, the payments made against them, and the purchasing reports.
import {
  bound, closeness, dayIn, describeRanges, inList, instant, isoIn, lastDays, like, matches, money, normalizeId, normalizeIds, page, qty, ranked, report, sorted, within,
  type DateSpan as Range, type SortBy,
} from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import { lastChanged, newId, paymentUpdatedAt, PREFIX, purchaseMoney, type Id, type PurchaseOrder, type PurchasePayment, type World } from "../world.ts";
import { customFieldValues, find, named, productFilter, recordAction, recordUrl, reportCustomFields, serial, stamp, userName, userRef, type C } from "./shared.ts";

type Between = { min?: number; max?: number };

const supplierOf = (w: World, po: PurchaseOrder) => named(w.companies, po.vendorId);
/** A purchase order changes with its payments too: when one is recorded or voided. */
const purchaseUpdated = (w: World, po: PurchaseOrder) =>
  lastChanged(w, "PURCHASE", po.id, po.orderDatetime, ...w.purchasePayments.filter((p) => p.purchaseId === po.id).map(paymentUpdatedAt));
const between = (n: number, r: Between | undefined) => !r || ((r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max));

/** A dollar input sent as a string or a number. */
function dollars(value: string | number, field: string): number {
  const n = typeof value === "number" ? value : Number(value.trim());
  if ((typeof value === "string" && !value.trim()) || !Number.isFinite(n)) throw new ToolError(`${field} must be an amount in dollars, e.g. 2500 or "2500.00".`);
  return n;
}

// ---------- purchase orders ----------

function purchaseSummary(w: World, po: PurchaseOrder) {
  const { total, status } = purchaseMoney(w, po);
  return {
    id: po.id, customFields: customFieldValues(w, "PURCHASE_ORDER"), purchaseNumber: po.purchaseNumber, status: po.status, color: null, paymentStatus: status,
    // The world's purchases carry no charges, discounts or taxes.
    total: money(total), totalCharges: money(0),
    orderDate: po.orderDatetime, dueDate: po.dueDatetime, createdDate: po.orderDatetime, updatedDate: purchaseUpdated(w, po),
    url: recordUrl("purchaseOrder", po.id), qbBillId: null, qbSyncStatus: null, supplier: supplierOf(w, po), owner: userRef(w, po.ownerId),
    // Purchases are never matched to a compliance transfer in this world.
    complianceManifestNumber: null,
  };
}

function purchaseItems(w: World, po: PurchaseOrder) {
  // receivedQuantity is 0 until a purchase is received and its quantity once COMPLETED; the world does not track partial receipts.
  const received = (quantity: number) => (po.status === "COMPLETED" ? qty(quantity) : po.status === "PARTIALLY_RECEIVED" ? null : "0");
  return po.items.map((i) => {
    const p = find(w.products, i.productId, "product");
    return {
      id: i.id, quantity: qty(i.quantity), receivedQuantity: received(i.quantity), price: money(i.unitCost),
      product: { id: p.id, name: p.name, unitType: named(w.unitTypes, p.unitTypeId)! }, batch: null, location: named(w.locations, po.locationId), package: null,
    };
  });
}

type PurchaseSearch = {
  limit?: number; cursor?: string; ids?: string[]; search?: string; status?: PurchaseOrder["status"][]; paymentStatus?: string[]; supplierIds?: string[]; ownerIds?: string[]; productIds?: string[];
  orderDateAfter?: string; orderDateBefore?: string; dueDateAfter?: string; dueDateBefore?: string; totalGreaterThanOrEqualTo?: number; totalLessThanOrEqualTo?: number; sortBy?: SortBy;
};

function searchPurchases(w: World, args: PurchaseSearch) {
  const ids = normalizeIds(args.ids, PREFIX.purchaseOrder), supplierIds = normalizeIds(args.supplierIds, PREFIX.company);
  const ownerIds = normalizeIds(args.ownerIds, PREFIX.user), productIds = normalizeIds(args.productIds, PREFIX.product);
  const tz = w.timezone;
  const ordered = [bound(args.orderDateAfter, "after", tz), bound(args.orderDateBefore, "before", tz)] as const;
  const due = [bound(args.dueDateAfter, "after", tz), bound(args.dueDateBefore, "before", tz)] as const;
  const total = { min: args.totalGreaterThanOrEqualTo, max: args.totalLessThanOrEqualTo };
  const hits = w.purchaseOrders.filter((po) =>
    (args.status ? args.status.includes(po.status) : po.status !== "DRAFT") &&
    inList(ids, po.id) && inList(supplierIds, po.vendorId) && inList(ownerIds, po.ownerId) &&
    (!productIds || po.items.some((i) => productIds.includes(i.productId))) &&
    (!args.paymentStatus || args.paymentStatus.includes(purchaseMoney(w, po).status)) &&
    within(po.orderDatetime, ...ordered) && within(po.dueDatetime, ...due) && between(purchaseMoney(w, po).total, total));
  if (args.search) return ranked(hits, (po) => closeness(args.search!, [po.purchaseNumber]));
  return sorted(hits, args.sortBy, {
    DUE_DATE: (po) => Date.parse(po.dueDatetime), INSERTED_AT: (po) => Date.parse(po.orderDatetime), ORDER_DATE: (po) => Date.parse(po.orderDatetime),
    PURCHASE_NUMBER: (po) => po.purchaseNumber, UPDATED_AT: (po) => Date.parse(purchaseUpdated(w, po)),
  }, { field: "UPDATED_AT", direction: "DESC" });
}

// ---------- purchase payments ----------

/** A payment as get-purchase-order lists it. */
const paymentView = (w: World, p: PurchasePayment) => ({
  id: p.id, paymentNumber: p.paymentNumber, paymentDate: p.paymentDatetime, status: p.voidedAt ? ("VOIDED" as const) : ("POSTED" as const),
  voidedAt: p.voidedAt, amount: money(p.amount), paymentMethod: named(w.paymentMethods, p.paymentMethodId), note: p.note,
  qbPaymentAccount: null, qbBillPaymentId: null, qbSyncStatus: null, insertedAt: p.recordedAt, updatedAt: paymentUpdatedAt(p),
});

/** A payment as the payment tools return it: with its purchase's balance and supplier. */
function paymentWithPurchase(w: World, p: PurchasePayment) {
  const po = find(w.purchaseOrders, p.purchaseId, "purchase order");
  const { total, paid, status } = purchaseMoney(w, po);
  return { ...paymentView(w, p), purchase: { id: po.id, purchaseNumber: po.purchaseNumber, paymentStatus: status, paid: money(paid), total: money(total) }, supplier: supplierOf(w, po) };
}

type PaymentSearch = {
  limit?: number; cursor?: string; amountMin?: string | number; amountMax?: string | number; paymentDateAfter?: string; paymentDateBefore?: string; paymentMethodIds?: string[];
  paymentNumber?: string; purchaseIds?: string[]; supplierIds?: string[]; search?: string; status?: "ALL" | "POSTED" | "VOIDED"; sortBy?: SortBy;
};

function searchPayments(w: World, args: PaymentSearch) {
  const methodIds = normalizeIds(args.paymentMethodIds, PREFIX.paymentMethod), purchaseIds = normalizeIds(args.purchaseIds, PREFIX.purchaseOrder);
  const supplierIds = normalizeIds(args.supplierIds, PREFIX.company);
  const amount = { min: args.amountMin === undefined ? undefined : dollars(args.amountMin, "amountMin"), max: args.amountMax === undefined ? undefined : dollars(args.amountMax, "amountMax") };
  const after = bound(args.paymentDateAfter, "after", w.timezone), before = bound(args.paymentDateBefore, "before", w.timezone);
  const status = args.status ?? "POSTED";
  const searched = (p: PurchasePayment, po: PurchaseOrder) => {
    const supplier = supplierOf(w, po)?.name ?? null;
    return like(args.search!, p.paymentNumber, p.note, po.purchaseNumber, supplier) || closeness(args.search!, [], [supplier]) !== undefined;
  };
  const hits = w.purchasePayments.filter((p) => {
    const po = find(w.purchaseOrders, p.purchaseId, "purchase order");
    return (status === "ALL" || (status === "VOIDED") === (p.voidedAt !== null)) &&
      inList(methodIds, p.paymentMethodId) && inList(purchaseIds, po.id) && inList(supplierIds, po.vendorId) &&
      between(p.amount, amount) && within(p.paymentDatetime, after, before) &&
      matches(args.paymentNumber, p.paymentNumber) &&
      (args.search === undefined || searched(p, po));
  });
  // search keeps the sortBy order.
  return sorted(hits, args.sortBy, {
    PAYMENT_DATE: (p) => Date.parse(p.paymentDatetime), INSERTED_AT: (p) => Date.parse(p.recordedAt), UPDATED_AT: (p) => Date.parse(paymentUpdatedAt(p)), PAYMENT_NUMBER: (p) => p.paymentNumber,
  }, { field: "PAYMENT_DATE", direction: "DESC" });
}

type NewPayment = { purchaseId: string; amount: string | number; paymentMethodId: string; paymentDate?: string; note?: string; qbPaymentAccount?: string };

function createPayment(c: C, args: NewPayment) {
  const w = c.world;
  const po = find(w.purchaseOrders, normalizeId(args.purchaseId, PREFIX.purchaseOrder), "purchase order");
  if (po.status === "DRAFT") throw new ToolError(`${po.purchaseNumber} is a draft; payments can only be recorded against a purchase that is not a DRAFT.`);
  const method = find(w.paymentMethods, normalizeId(args.paymentMethodId, PREFIX.paymentMethod), "payment method");
  const amount = dollars(args.amount, "amount");
  if (amount <= 0) throw new ToolError("amount must be more than $0.");
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) throw new ToolError("amount must be in whole cents, e.g. 2500.00.");
  if (args.qbPaymentAccount !== undefined) throw new ToolError("qbPaymentAccount is rejected: this company is not connected to QuickBooks. Leave it out to record the payment with no account.");
  const paymentDatetime = args.paymentDate === undefined ? stamp(c) : isoIn(w.timezone, instant(args.paymentDate));

  const id = newId(w, PREFIX.purchasePayment);
  const payment: PurchasePayment = {
    id, paymentNumber: `PMT-${serial(id)}`, purchaseId: po.id, amount, paymentDatetime, recordedAt: stamp(c), paymentMethodId: method.id, note: args.note?.trim() || null, voidedAt: null,
  };
  w.purchasePayments.push(payment);
  const field = (name: string, label: string, value: string | null) => ({ field: name, label, oldValue: null, newValue: value });
  // A payment is a line of its purchase order, so it shows in the order's history.
  recordAction(c, [{
    type: "PURCHASE", id: po.id, name: po.purchaseNumber, entity: "PURCHASE_PAYMENT", rowId: payment.id, op: "INSERT", rowLabel: payment.paymentNumber,
    fields: [field("amount", "Amount", money(amount)), field("paymentMethodId", "Payment method", method.name), field("paymentDatetime", "Payment date", paymentDatetime), field("note", "Note", payment.note)],
  }]);
  return { purchasePayment: paymentWithPurchase(w, payment) };
}

// ---------- reports ----------

/** A date range as the filter bounds it checks. */
const bounds = (w: World, r: Range | undefined) => ({ after: bound(r?.start, "after", w.timezone), before: bound(r?.end, "before", w.timezone) });

/** meta.columns for a report: every row key but customFields, each with its label. */
const columns = (labels: Record<string, string>) => Object.entries(labels).map(([key, label]) => ({ key, label }));

/** M/D/YYYY in the company timezone. */
function shortDate(w: World, iso: string): string {
  const [y, m, d] = dayIn(w.timezone, new Date(iso)).split("-");
  return `${+m!}/${+d!}/${y}`;
}

/** YYYY-MM-DD HH:MM:SS.ffffff, the company's wall-clock time with no offset. */
const wallClock = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}.000000`;

const PRODUCT_ONLY = ["locationIds", "productCategoryIds", "productSubcategoryIds", "productTagIds", "vendorIds", "brandIds", "productGroupIds"] as const;

type TotalsArgs = { [K in (typeof PRODUCT_ONLY)[number]]?: string[] } & {
  rowsPer: "VENDOR" | "PRODUCT"; orderDatetime?: Range; ownerIds?: string[]; vendorGroupIds?: string[]; maxRowsLimit?: number; cursor?: string;
};

const VENDOR_COLUMNS = columns({
  name: "Vendor", vendorId: "Vendor ID", lastPurchaseDate: "Last purchase date", purchaseOrderCount: "Purchase orders", totalPurchases: "Total purchases",
  productOwner: "Owner", vendorOwnerId: "Owner ID", category: "Category", relationshipType: "Relationship type",
});

function totalsByVendor(w: World, purchases: PurchaseOrder[], args: TotalsArgs) {
  const groupIds = normalizeIds(args.vendorGroupIds, PREFIX.companyGroup);
  const counted = w.purchaseOrders.filter((po) => po.status !== "DRAFT");
  return w.companies
    .filter((v) => inList(groupIds, v.groupId))
    .map((v) => ({ v, mine: purchases.filter((po) => po.vendorId === v.id) }))
    .filter(({ mine }) => mine.length)
    .map(({ v, mine }) => {
      const spend = mine.reduce((n, po) => n + purchaseMoney(w, po).total, 0);
      const latest = counted.filter((po) => po.vendorId === v.id).map((po) => po.orderDatetime).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
      return {
        spend,
        row: {
          name: v.name, vendorId: v.id, lastPurchaseDate: shortDate(w, latest), purchaseOrderCount: String(mine.length), totalPurchases: money(spend),
          productOwner: userName(w, v.ownerId), vendorOwnerId: v.ownerId, category: null,
          relationshipType: v.relationship === "VENDOR" ? "Vendor" : "Customer", customFields: reportCustomFields(w, "COMPANY"),
        },
      };
    });
}

const PRODUCT_COLUMNS = columns({
  name: "Product", productId: "Product ID", sku: "SKU", quantityPurchased: "Quantity purchased", totalPurchased: "Total purchased", unitType: "Unit type", category: "Category",
  subcategory: "Subcategory", group: "Group", vendor: "Vendor", vendorId: "Vendor ID", owner: "Owner", unitCost: "Unit cost", salePrice: "Sale price", wholesalePrice: "Wholesale price",
});

function totalsByProduct(w: World, purchases: PurchaseOrder[], args: TotalsArgs) {
  const ofKind = productFilter(w, args);
  const bought = new Map<Id, { quantity: number; spend: number }>();
  for (const i of purchases.flatMap((po) => po.items)) {
    const sum = bought.get(i.productId) ?? { quantity: 0, spend: 0 };
    bought.set(i.productId, { quantity: sum.quantity + i.quantity, spend: sum.spend + i.quantity * i.unitCost });
  }
  return w.products
    .filter((p) => bought.has(p.id) && ofKind(p))
    .map((p) => {
      const { quantity, spend } = bought.get(p.id)!;
      const category = find(w.categories, p.categoryId, "category");
      const vendor = named(w.companies, p.vendorId);
      return {
        spend,
        row: {
          name: p.name, productId: p.id, sku: p.sku, quantityPurchased: qty(quantity), totalPurchased: money(spend), unitType: named(w.unitTypes, p.unitTypeId)!.name,
          category: category.name, subcategory: named(category.subcategories, p.subcategoryId)?.name ?? null, group: named(w.groups, p.groupId)?.name ?? null,
          vendor: vendor?.name ?? "", vendorId: vendor?.id ?? "",
          // Products have no owner in the world, and one price, their sale price.
          owner: null, unitCost: money(p.unitCost), salePrice: money(p.unitPrice), wholesalePrice: null, customFields: reportCustomFields(w, "PRODUCT"),
        },
      };
    });
}

function purchaseTotals(w: World, args: TotalsArgs) {
  const wrong = args.rowsPer === "VENDOR" ? PRODUCT_ONLY.filter((k) => args[k] !== undefined) : args.vendorGroupIds !== undefined ? ["vendorGroupIds"] : [];
  if (wrong.length) throw new ToolError(`${wrong.join(", ")} ${wrong.length > 1 ? "apply" : "applies"} only when rowsPer is ${args.rowsPer === "VENDOR" ? "PRODUCT" : "VENDOR"}.`);
  const ordered = args.orderDatetime ?? lastDays(w.today), range = bounds(w, ordered);
  const ownerIds = normalizeIds(args.ownerIds, PREFIX.user), locationIds = normalizeIds(args.locationIds, PREFIX.location);
  const purchases = w.purchaseOrders.filter((po) => po.status !== "DRAFT" && within(po.orderDatetime, range.after, range.before) && inList(ownerIds, po.ownerId) && inList(locationIds, po.locationId));
  const byVendor = args.rowsPer === "VENDOR";
  const rows = (byVendor ? totalsByVendor(w, purchases, args) : totalsByProduct(w, purchases, args)).sort((a, b) => b.spend - a.spend || a.row.name.localeCompare(b.row.name)).map((x) => x.row);
  return report({ report: byVendor ? "Purchase totals by vendor" : "Purchase totals by product", dateRange: describeRanges([["orderDatetime", ordered]]), columns: byVendor ? VENDOR_COLUMNS : PRODUCT_COLUMNS }, rows, args);
}

type HistoryArgs = {
  orderDatetime?: Range; dueDatetime?: Range; locationIds?: string[]; productIds?: string[]; vendorIds?: string[]; statuses?: PurchaseOrder["status"][]; search?: string;
  paid?: Between; total?: Between; maxRowsLimit?: number; cursor?: string;
};

const HISTORY_COLUMNS = columns({
  purchaseDate: "Purchase date", dueDate: "Due date", purchaseNumber: "Purchase number", purchaseOrderId: "Purchase order ID", vendor: "Vendor", vendorId: "Vendor ID",
  status: "Status", paid: "Paid", amount: "Amount", owner: "Owner", purchaseOrderOwnerId: "Owner ID",
});

function purchaseHistory(w: World, args: HistoryArgs) {
  const orderedSpan = args.orderDatetime ?? (args.dueDatetime === undefined ? lastDays(w.today) : undefined);
  const ordered = bounds(w, orderedSpan), due = bounds(w, args.dueDatetime);
  const locationIds = normalizeIds(args.locationIds, PREFIX.location), productIds = normalizeIds(args.productIds, PREFIX.product), vendorIds = normalizeIds(args.vendorIds, PREFIX.company);
  const hits = w.purchaseOrders.filter((po) => {
    const { total, paid } = purchaseMoney(w, po);
    return po.status !== "DRAFT" && (!args.statuses || args.statuses.includes(po.status)) &&
      within(po.orderDatetime, ordered.after, ordered.before) && within(po.dueDatetime, due.after, due.before) &&
      inList(locationIds, po.locationId) && inList(vendorIds, po.vendorId) && (!productIds || po.items.some((i) => productIds.includes(i.productId))) &&
      between(total, args.total) && between(paid, args.paid);
  });
  // Without a search the report lists the latest purchases first.
  const rows = args.search ? ranked(hits, (po) => closeness(args.search!, [po.purchaseNumber])) : sorted(hits, undefined, { ORDER_DATE: (po) => Date.parse(po.orderDatetime) }, { field: "ORDER_DATE", direction: "DESC" });
  const dateRange = describeRanges([["orderDatetime", orderedSpan], ["dueDatetime", args.dueDatetime]]);
  return report({ report: "Purchase order history", dateRange, columns: HISTORY_COLUMNS }, rows.map((po) => historyRow(w, po)), args);
}

function historyRow(w: World, po: PurchaseOrder) {
  const { total, paid } = purchaseMoney(w, po);
  const supplier = supplierOf(w, po)!;
  return {
    purchaseDate: wallClock(po.orderDatetime), dueDate: wallClock(po.dueDatetime), purchaseNumber: po.purchaseNumber, purchaseOrderId: po.id, vendor: supplier.name, vendorId: supplier.id,
    status: po.status, paid: money(paid), amount: money(total), owner: userName(w, po.ownerId), purchaseOrderOwnerId: po.ownerId, customFields: reportCustomFields(w, "PURCHASE_ORDER"),
  };
}

// ---------- tools ----------

export const tools = [
  defineTool<World>({
    name: "search-purchase-orders",
    supports: [
      "limit", "cursor", "ids", "search", "status", "paymentStatus", "supplierIds", "ownerIds", "productIds", "orderDateAfter", "orderDateBefore", "dueDateAfter", "dueDateBefore",
      "totalGreaterThanOrEqualTo", "totalLessThanOrEqualTo", "sortBy",
    ],
    run: (args: PurchaseSearch, { world: w }) => page(searchPurchases(w, args), args, (po) => ({ ...purchaseSummary(w, po), intakeLocation: named(w.locations, po.locationId) })),
  }),

  defineTool<World>({
    name: "get-purchase-order",
    supports: ["id", "includeOrderItems", "includeOrderCharges", "includePayments"],
    run(args: { id: string; includeOrderItems?: boolean; includeOrderCharges?: boolean; includePayments?: boolean }, { world: w }) {
      const po = w.purchaseOrders.find((p) => p.id === normalizeId(args.id, PREFIX.purchaseOrder));
      if (!po) return { purchaseOrder: null };
      const location = named(w.locations, po.locationId);
      const payments = w.purchasePayments.filter((p) => p.purchaseId === po.id && p.voidedAt === null).sort((a, b) => Date.parse(a.paymentDatetime) - Date.parse(b.paymentDatetime));
      return {
        purchaseOrder: {
          ...purchaseSummary(w, po), paid: money(purchaseMoney(w, po).paid), description: null,
          // Locations have no street address in the world, and purchases record no billing or supplier location.
          intakeLocation: location && { ...location, address: "" }, billingLocation: null, supplierLocation: null,
          ...(args.includeOrderItems ? { orderItems: purchaseItems(w, po) } : {}),
          ...(args.includeOrderCharges ? { orderCharges: [] } : {}),
          ...(args.includePayments ? { payments: payments.map((p) => paymentView(w, p)) } : {}),
        },
      };
    },
  }),

  defineTool<World>({
    name: "search-purchase-payments",
    supports: ["limit", "cursor", "amountMin", "amountMax", "paymentDateAfter", "paymentDateBefore", "paymentMethodIds", "paymentNumber", "purchaseIds", "supplierIds", "search", "status", "sortBy"],
    run: (args: PaymentSearch, { world: w }) => page(searchPayments(w, args), args, (p) => paymentWithPurchase(w, p)),
  }),

  defineTool<World>({
    name: "get-purchase-payment",
    supports: ["id"],
    run(args: { id: string }, { world: w }) {
      // The page answers an invoice payment's id with null rather than an error.
      if (args.id.startsWith(`${PREFIX.invoicePayment}_`)) return { purchasePayment: null };
      const p = w.purchasePayments.find((x) => x.id === normalizeId(args.id, PREFIX.purchasePayment));
      return { purchasePayment: p ? paymentWithPurchase(w, p) : null };
    },
  }),

  defineTool<World>({
    name: "create-purchase-payment",
    supports: ["purchaseId", "amount", "paymentMethodId", "paymentDate", "note", "qbPaymentAccount"],
    run: (args: NewPayment, c) => createPayment(c, args),
  }),

  defineTool<World>({
    name: "report-purchase-totals",
    supports: ["rowsPer", "orderDatetime", "ownerIds", "vendorGroupIds", ...PRODUCT_ONLY, "maxRowsLimit", "cursor"],
    run: (args: TotalsArgs, { world: w }) => purchaseTotals(w, args),
  }),

  defineTool<World>({
    name: "report-purchase-order-history",
    supports: ["orderDatetime", "dueDatetime", "locationIds", "productIds", "vendorIds", "statuses", "search", "paid", "total", "maxRowsLimit", "cursor"],
    run: (args: HistoryArgs, { world: w }) => purchaseHistory(w, args),
  }),
];
