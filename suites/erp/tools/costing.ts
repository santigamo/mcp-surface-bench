// What stock is worth and what sold stock cost: the inventory valuation and cost of goods sold reports.
import { addDays, bound, matches, money, normalizeIds, qty, report, within } from "../../../src/core/kit.ts";
import { defineTool } from "../../../src/core/tool.ts";
import { activeQuantity, availableQuantity, PREFIX, type Id, type Product, type SalesOrder, type World } from "../world.ts";
import { named, stamp, type C } from "./shared.ts";
import { categoryOf, companyName, PRODUCT_FILTERS, productFilter, productOf, subcategoryOf, unitTypeOf, type ProductFilters } from "./inventory.ts";

const columns = (pairs: [string, string][]) => pairs.map(([key, label]) => ({ key, label }));
const sum = (ns: number[]) => ns.reduce((n, x) => n + x, 0);

// ---------- inventory valuation ----------

const VALUATION_COLUMNS = columns([
  ["name", "Name"], ["sku", "SKU"], ["vendor", "Vendor"], ["unitType", "Unit type"], ["category", "Category"], ["subcategory", "Subcategory"], ["group", "Group"], ["owner", "Owner"],
  ["activeQuantity", "Active quantity"], ["assemblingQuantity", "Assembling quantity"], ["reservedQuantity", "Reserved quantity"], ["availableQuantity", "Available quantity"],
  ["incomingQuantity", "Incoming quantity"], ["pendingOutputQuantity", "Pending output quantity"], ["unitCost", "Unit cost"], ["unitPrice", "Unit price"],
  ["inventoryThresholdMax", "Max threshold"], ["inventoryThresholdMin", "Min threshold"], ["activeValue", "Active value"], ["brand", "Brand"],
]);

/** A product's stock, counted at the given locations or everywhere. */
function stockOf(w: World, p: Product, locationIds: Id[] | undefined) {
  const active = locationIds ? sum(locationIds.map((l) => activeQuantity(w, p, l))) : activeQuantity(w, p);
  // Reservations are held per product, not per location, so a location filter still takes all of them off.
  const available = locationIds ? active - p.reserved : availableQuantity(w, p);
  const passedTesting = p.tracking === "PACKAGE"
    ? sum(w.packages.filter((k) => k.productId === p.id && k.status === "ACTIVE" && k.labTestingState === "TestPassed" && (!locationIds || locationIds.includes(k.locationId))).map((k) => k.quantity))
    : null;
  // A purchase order that is not COMPLETED counts in full: the world does not record partial receipts.
  const incoming = sum(w.purchaseOrders.filter((po) => po.status !== "COMPLETED" && (!locationIds || locationIds.includes(po.locationId)))
    .flatMap((po) => po.items).filter((i) => i.productId === p.id).map((i) => i.quantity));
  return { active, available, passedTesting, incoming };
}

function valuationRow(w: World, p: Product, stock: ReturnType<typeof stockOf>, method: "COST" | "PRICE") {
  return {
    name: p.name, productId: p.id, sku: p.sku, vendor: companyName(w, p.vendorId) ?? "", vendorId: p.vendorId ?? "", unitType: unitTypeOf(w, p).name,
    category: categoryOf(w, p), subcategory: subcategoryOf(w, p), group: named(w.groups, p.groupId)?.name ?? null, owner: null,
    activeQuantity: qty(stock.active), activeQuantityPassedTesting: stock.passedTesting === null ? null : qty(stock.passedTesting),
    assemblingQuantity: "0", reservedQuantity: qty(p.reserved), availableQuantity: qty(stock.available), incomingQuantity: qty(stock.incoming), pendingOutputQuantity: "0",
    unitCost: money(p.unitCost), unitPrice: money(p.unitPrice),
    inventoryThresholdMax: p.thresholdMax === null ? null : qty(p.thresholdMax), inventoryThresholdMin: p.thresholdMin === null ? null : qty(p.thresholdMin),
    activeValue: money(stock.active * (method === "PRICE" ? p.unitPrice : p.unitCost)),
    imageUrl: null, brand: companyName(w, p.brandId), brandId: p.brandId, customFields: [],
  };
}

// ---------- cost of goods sold ----------

const COGS_COLUMNS = columns([
  ["orderNumber", "Order"], ["finalInput", "Final input"], ["costOrigin", "Cost origin"], ["productName", "Product"], ["sku", "SKU"], ["productBrand", "Brand"],
  ["productCategory", "Category"], ["package", "Package"], ["batch", "Batch"], ["quantity", "Quantity"], ["unitType", "Unit type"], ["unitPrice", "Unit price"],
  ["totalPrice", "Total price"], ["unitCostActual", "Unit cost (actual)"], ["unitCostDefault", "Unit cost (default)"], ["totalCostActual", "Total cost (actual)"],
  ["totalCostDefault", "Total cost (default)"], ["totalProfitsActual", "Total profit (actual)"], ["totalProfitsDefault", "Total profit (default)"],
  ["profitUnitActual", "Profit per unit (actual)"], ["profitUnitDefault", "Profit per unit (default)"], ["marginActual", "Margin (actual)"], ["marginDefault", "Margin (default)"],
]);

type Range = { start?: string; end?: string };
type Item = SalesOrder["items"][0];

/** Cost, profit and margin of a line at one unit cost. */
function figures(item: Item, unitCost: number) {
  const totalPrice = item.quantity * item.unitPrice, totalCost = item.quantity * unitCost;
  return {
    unitCost: money(unitCost), totalCost: money(totalCost), totalProfits: money(totalPrice - totalCost), profitUnit: money(item.unitPrice - unitCost),
    margin: totalPrice ? qty((totalPrice - totalCost) / totalPrice) : null,
  };
}

function cogsRow(w: World, o: SalesOrder, item: Item) {
  const p = productOf(w, item.productId);
  const pkg = item.packageId ? w.packages.find((k) => k.id === item.packageId)! : null;
  const batch = item.batchId ? w.batches.find((b) => b.id === item.batchId)! : null;
  // Actual is the cost fixed on the line when the order shipped; Default is the product's configured unit cost today.
  const actual = figures(item, item.unitCost), standard = figures(item, p.unitCost);
  return {
    orderNumber: o.orderNumber, salesOrderId: o.id, finalInput: "Final", costOrigin: null,
    productName: p.name, productId: p.id, sku: p.sku, productBrand: companyName(w, p.brandId), brandId: p.brandId, productCategory: categoryOf(w, p),
    package: pkg?.metrcLabel ?? null, packageId: pkg?.id ?? null,
    // A batch's name is its batch number in this world, so the number is not repeated in parentheses.
    batch: batch?.batchNumber ?? null, batchId: batch?.id ?? null,
    quantity: qty(item.quantity), unitType: unitTypeOf(w, p).name, unitPrice: money(item.unitPrice), totalPrice: money(item.quantity * item.unitPrice),
    unitCostActual: actual.unitCost, unitCostDefault: standard.unitCost, totalCostActual: actual.totalCost, totalCostDefault: standard.totalCost,
    totalProfitsActual: actual.totalProfits, totalProfitsDefault: standard.totalProfits, profitUnitActual: actual.profitUnit, profitUnitDefault: standard.profitUnit,
    marginActual: actual.margin, marginDefault: standard.margin, customFields: [],
  };
}

const span = (what: string, r: Range | undefined) => (r ? `${what} ${r.start ?? "any time"} to ${r.end ?? "now"}` : null);

// ---------- the tools ----------

export const tools = [
  defineTool<World>({
    name: "report-inventory-valuation",
    supports: ["cursor", "calculationMethod", "locationIds", "search", ...PRODUCT_FILTERS, "maxRowsLimit"],
    run(args: ProductFilters & { cursor?: string; calculationMethod?: "COST" | "PRICE"; locationIds?: string[]; search?: string; maxRowsLimit?: number }, c: C) {
      const w = c.world, locationIds = normalizeIds(args.locationIds, PREFIX.location), ofKind = productFilter(w, args);
      const rows = w.products.filter((p) => p.active && ofKind(p) && matches(args.search, p.name, p.sku))
        .map((p) => ({ p, stock: stockOf(w, p, locationIds) }))
        .sort((a, b) => b.stock.available - a.stock.available)
        .map(({ p, stock }) => valuationRow(w, p, stock, args.calculationMethod ?? "PRICE"));
      return report({ report: "Inventory valuation", dateRange: `as of ${stamp(c)}`, columns: VALUATION_COLUMNS }, rows, args);
    },
  }),

  defineTool<World>({
    name: "report-cogs",
    supports: ["cursor", "deliveryDatetime", "orderDatetime", ...PRODUCT_FILTERS, "maxRowsLimit"],
    run(args: ProductFilters & { cursor?: string; deliveryDatetime?: Range; orderDatetime?: Range; maxRowsLimit?: number }, { world: w }) {
      const tz = w.timezone, ofKind = productFilter(w, args);
      // The last 30 days, today included, unless a delivery range is sent.
      const ordered = args.orderDatetime ?? (args.deliveryDatetime ? undefined : { start: addDays(w.today, -29), end: w.today });
      const orderedIn = [bound(ordered?.start, "after", tz), bound(ordered?.end, "before", tz)] as const;
      const deliveredIn = [bound(args.deliveryDatetime?.start, "after", tz), bound(args.deliveryDatetime?.end, "before", tz)] as const;
      const rows = w.salesOrders
        .filter((o) => o.status === "COMPLETED" && within(o.orderDatetime, ...orderedIn) && within(o.deliveryDatetime, ...deliveredIn))
        .sort((a, b) => Date.parse(a.orderDatetime) - Date.parse(b.orderDatetime))
        .flatMap((o) => o.items.filter((i) => ofKind(productOf(w, i.productId))).map((i) => cogsRow(w, o, i)));
      const dateRange = [span("ordered", ordered), span("delivered", args.deliveryDatetime)].filter((s) => s !== null).join("; ");
      return report({ report: "Cost of goods sold", dateRange, columns: COGS_COLUMNS }, rows, args);
    },
  }),
];
