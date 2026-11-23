// Where stock is held and how it moves: locations, batches, packages, stock transfers, and the stock-per-asset report.
import { bound, closeness, inList, inStatus, instant, isoIn, money, normalizeId, normalizeIds, page, qty, ranked, report, sorted, tiers, within, type SortBy, type Status } from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import { batchStock, newId, PREFIX, type Batch, type Id, type Location, type Package, type Product, type StockTransfer, type World } from "../world.ts";
import {
  categoryOf, companyName, customFieldValues, find, named, PRODUCT_FILTERS, productFilter, productOf, recordAction, recordUrl, reportCustomFields, serial, stamp,
  subcategoryName, unitTypeOf, type C, type ProductFilters,
} from "./shared.ts";

type StockRow = { locationId: Id; quantity: number };

// ---------- shared pieces of the records ----------

const sum = (rows: StockRow[]) => rows.reduce((n, r) => n + r.quantity, 0);
const at = (rows: StockRow[], locationId: Id) => rows.find((r) => r.locationId === locationId)?.quantity ?? 0;
const time = (iso: string) => Date.parse(iso);
const location = (w: World, id: Id) => named(w.locations, id)!;
const licenseOf = (w: World, l: Location) => w.licenses.find((x) => x.id === l.licenseId)!;
const quantitiesByLocation = (w: World, rows: StockRow[]) => rows.map((r) => ({ location: location(w, r.locationId), quantity: qty(r.quantity) }));

// ---------- locations ----------

function locationRow(w: World, l: Location) {
  const license = licenseOf(w, l);
  // The world keeps no addresses for its rooms, and no Metrc room ids.
  return {
    id: l.id, name: l.name, streetAddress: "", apt: null, city: "", state: w.company.state, zip: "", country: "US",
    license: { id: license.id, licenseNumber: license.licenseNumber }, metrcLocation: null,
  };
}

// ---------- batches ----------

/** A batch is named by its batch number: the world keeps no separate name. */
const batchRef = (b: Batch) => ({ id: b.id, name: b.batchNumber });

function batchHeader(w: World, b: Batch) {
  const quantity = sum(batchStock(w, b));
  return {
    ...batchRef(b), customFields: customFieldValues(w, "BATCH"), batchNumber: b.batchNumber, manufacturedDate: b.createdAt.slice(0, 10), harvestDate: null, expirationDate: null,
    quantity: qty(quantity), activeQuantityCost: money(quantity * productOf(w, b.productId).unitCost),
  };
}

function batchRow(w: World, b: Batch) {
  const p = productOf(w, b.productId);
  return {
    ...batchHeader(w, b),
    product: { id: p.id, name: p.name, sku: p.sku, inactive: !p.active, unitType: unitTypeOf(w, p) },
    activeQuantitiesByLocation: quantitiesByLocation(w, batchStock(w, b)),
    // The world records a THC figure on each batch but no lab test result to carry it.
    primaryTestResult: null,
  };
}

// ---------- packages ----------

const LAB_STATE = { TestPassed: "PASSED", NotSubmitted: "NOT_TESTED" } as const;
const SYNC_REASON: Record<World["metrcActivities"][0]["type"], string> = { ADJUST_PACKAGE: "STOCK_ADJUSTMENT", FINISH_PACKAGE: "FINISH_PACKAGE", CHANGE_PACKAGE_LOCATION: "UNKNOWN", CREATE_PACKAGE: "UNKNOWN" };

const metrcRecord = (w: World, k: Package) => w.metrcPackages.find((m) => m.label === k.metrcLabel);
/** The oldest change of a package not yet in Metrc, if any: one that failed is still not sent, and holds back those queued after it. */
const pendingSync = (w: World, k: Package) => w.metrcActivities.find((a) => a.packageId === k.id && a.status !== "COMPLETED");
const activeSalesOrder = (w: World, k: Package) => w.salesOrders.find((o) => o.status !== "CANCELED" && o.items.some((i) => i.packageId === k.id));

function packageRow(w: World, k: Package) {
  const p = productOf(w, k.productId), m = metrcRecord(w, k), l = w.locations.find((x) => x.id === k.locationId)!, license = w.licenses.find((x) => x.id === k.licenseId)!;
  const order = activeSalesOrder(w, k);
  return {
    id: k.id, customFields: customFieldValues(w, "PACKAGE"), metrcLabel: k.metrcLabel, complianceType: license.complianceType,
    metrcId: m?.metrcId ?? null, complianceProductName: m?.itemName ?? null, complianceStrainName: m?.strainName ?? null,
    distruStatus: k.status,
    // No package is hidden in Distru in this world.
    isActive: true,
    syncing: pendingSync(w, k) !== undefined,
    batchNumber: null, compliancePackagedDate: m?.packagedDate ?? null, harvestDate: null, expirationDate: null, finishedAt: null,
    insertedAt: k.createdAt, updatedAt: k.createdAt, isTestSample: false, isTradeSample: false, isFinishedGood: null,
    labTestingState: LAB_STATE[k.labTestingState], labTestingStateDate: null,
    quantity: qty(k.quantity), quantityActive: qty(k.status === "ACTIVE" ? k.quantity : 0), quantityAssembling: "0",
    quantityInMetrc: m ? qty(m.quantity) : null, quantityCost: k.quantity ? money(k.quantity * p.unitCost) : null,
    unitType: unitTypeOf(w, p), product: { id: p.id, name: p.name, sku: p.sku },
    batch: batchRef(w.batches.find((b) => b.id === k.batchId)!),
    location: { id: l.id, name: l.name }, license: { id: license.id, licenseNumber: license.licenseNumber },
    activeSalesOrder: order ? { id: order.id, orderNumber: order.orderNumber } : null,
    primaryTestResult: null,
  };
}

function packageDetail(w: World, k: Package, withCostItems: boolean) {
  const m = metrcRecord(w, k), sync = pendingSync(w, k);
  return {
    ...packageRow(w, k),
    metrcStatus: m?.status ?? null, metrcProductionBatchNumber: null, metrcSourcePackageLabels: null,
    syncingReason: sync ? SYNC_REASON[sync.type] : null, description: null,
    // The world records one cost per product and no cost entries, so there is no breakdown to show.
    ...(withCostItems ? { quantityCostItems: null } : {}),
  };
}

/** A Metrc tag in full: 16 or more letters and digits, no spaces. */
const isFullLabel = (search: string | undefined) => search !== undefined && /^[A-Za-z0-9]{16,}$/.test(search);

// ---------- stock transfers ----------

function transferRow(w: World, t: StockTransfer) {
  return {
    id: t.id, stockTransferNumber: t.number,
    // Every transfer completes when it is recorded.
    status: "COMPLETED", transferDatetime: t.transferDatetime, completedAt: t.completedAt,
    description: t.description, customFields: customFieldValues(w, "STOCK_TRANSFER"),
    fromLocation: location(w, t.fromLocationId), toLocation: location(w, t.toLocationId),
    items: t.items.map((i) => {
      const batch = i.batchId ? w.batches.find((b) => b.id === i.batchId)! : null;
      return { quantity: qty(i.quantity), product: named(w.products, i.productId)!, batch: batch && batchRef(batch), package: null };
    }),
  };
}

type MoveItem = { batchId?: string; productId?: string; quantity: string | number };
type MoveLine = { product: Product; batch: Batch | null; quantity: number };

function moveLine(w: World, item: MoveItem): MoveLine {
  if ((item.batchId === undefined) === (item.productId === undefined)) throw new ToolError("Send exactly one of batchId or productId on each item.");
  const quantity = Number(item.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new ToolError(`Each item's quantity must be a number greater than 0, not "${item.quantity}".`);
  if (item.batchId !== undefined) {
    const batch = find(w.batches, normalizeId(item.batchId, PREFIX.batch), "batch");
    return { product: productOf(w, batch.productId), batch, quantity };
  }
  const product = find(w.products, normalizeId(item.productId!, PREFIX.product), "product");
  if (product.tracking === "BATCH") throw new ToolError(`${product.name} is batch-tracked: send the batchId of the batch to move instead of productId. Resolve it via distru-search-batches.`);
  if (product.tracking === "PACKAGE") throw new ToolError(`${product.name} is package-tracked: it moves as whole packages with distru-move-packages.`);
  return { product, batch: null, quantity };
}

const stockOf = (line: MoveLine) => (line.batch ?? line.product).stock;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Refuses the move when the lines together take more from a batch or product than the source location holds. */
function checkStock(lines: MoveLine[], from: Location) {
  const wanted = new Map<StockRow[], number>();
  for (const line of lines) {
    const rows = stockOf(line), total = round4((wanted.get(rows) ?? 0) + line.quantity);
    wanted.set(rows, total);
    if (total > at(rows, from.id)) {
      const what = line.batch ? `${line.product.name} (batch ${line.batch.batchNumber})` : line.product.name;
      throw new ToolError(`Only ${qty(at(rows, from.id))} of ${what} is at ${from.name}, and this call moves ${qty(total)}. Send at most that quantity.`);
    }
  }
}

/** Changes a location's quantity in place, keeping no empty rows (the seed stores none). */
function shift(rows: StockRow[], locationId: Id, by: number) {
  const row = rows.find((r) => r.locationId === locationId);
  const quantity = round4((row?.quantity ?? 0) + by);
  if (!row) rows.push({ locationId, quantity });
  else if (quantity === 0) rows.splice(rows.indexOf(row), 1);
  else row.quantity = quantity;
}

// ---------- the stock-per-asset report ----------

/** One stock holding: a product at a location, in one batch or package when it is tracked that way. */
type Holding = { product: Product; locationId: Id; quantity: number; batch: Batch | null; pkg: Package | null };

function holdings(w: World, p: Product): Holding[] {
  const plain = (rows: StockRow[], batch: Batch | null) => rows.map((r) => ({ product: p, locationId: r.locationId, quantity: r.quantity, batch, pkg: null }));
  if (p.tracking === "PRODUCT") return plain(p.stock, null);
  if (p.tracking === "BATCH") return w.batches.filter((b) => b.productId === p.id).flatMap((b) => plain(b.stock, b));
  return w.packages.filter((k) => k.productId === p.id && k.status === "ACTIVE").map((k) => ({ product: p, locationId: k.locationId, quantity: k.quantity, batch: w.batches.find((b) => b.id === k.batchId)!, pkg: k }));
}

function assetRow(w: World, h: Holding) {
  const p = h.product, l = w.locations.find((x) => x.id === h.locationId)!, license = licenseOf(w, l);
  // The world keeps one cost per product, so the traced and the configured cost are the same figure.
  const unitCost = money(p.unitCost), totalCost = money(h.quantity * p.unitCost);
  return {
    product: p.active ? p.name : `${p.name} (INACTIVE)`, productId: p.id, license: license.name, licenseId: license.id, location: l.name, locationId: l.id,
    packageNumber: h.pkg?.metrcLabel ?? null, packageId: h.pkg?.id ?? null, batchNumber: h.batch?.batchNumber ?? null, batchId: h.batch?.id ?? null,
    sku: p.sku, vendor: companyName(w, p.vendorId) ?? "", vendorId: p.vendorId ?? "", owner: null, unitType: unitTypeOf(w, p).name,
    activeQuantity: qty(h.quantity), assemblingQuantity: "0", sellingQuantity: "0", category: categoryOf(w, p).name, subcategory: subcategoryName(w, p),
    unitPrice: money(p.unitPrice), unitCostActual: unitCost, unitCostDefault: unitCost, totalCostActual: totalCost, totalCostDefault: totalCost,
    expirationDate: null, trackingMethod: p.tracking, harvestDate: null, labTestingState: h.pkg ? LAB_STATE[h.pkg.labTestingState] : null,
    // An asset row is a batch or a package when the product is tracked that way, and a product otherwise.
    customFields: reportCustomFields(w, h.pkg ? "PACKAGE" : h.batch ? "BATCH" : "PRODUCT"),
  };
}

const ASSET_COLUMNS = [
  ["product", "Product"], ["license", "License"], ["location", "Location"], ["packageNumber", "Package"], ["batchNumber", "Batch"], ["sku", "SKU"], ["vendor", "Vendor"],
  ["owner", "Owner"], ["unitType", "Unit type"], ["activeQuantity", "Active quantity"], ["assemblingQuantity", "Assembling quantity"], ["sellingQuantity", "Selling quantity"],
  ["category", "Category"], ["subcategory", "Subcategory"], ["unitPrice", "Unit price"], ["unitCostActual", "Unit cost (actual)"], ["unitCostDefault", "Unit cost (default)"],
  ["totalCostActual", "Total cost (actual)"], ["totalCostDefault", "Total cost (default)"], ["expirationDate", "Expiration date"], ["trackingMethod", "Tracking method"],
  ["harvestDate", "Harvest date"], ["labTestingState", "Lab testing state"],
].map(([key, label]) => ({ key: key!, label: label! }));

// ---------- the tools ----------

type Paging = { limit?: number; cursor?: string; sortBy?: SortBy };

export const tools = [
  defineTool<World>({
    name: "search-locations",
    supports: ["limit", "cursor", "complianceType", "ids", "licenseId", "packageProductIds", "search", "sortBy"],
    run(args: Paging & { complianceType?: string; ids?: string[]; licenseId?: string; packageProductIds?: string[]; search?: string }, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.location), productIds = normalizeIds(args.packageProductIds, PREFIX.product);
      const licenseId = args.licenseId === undefined ? undefined : normalizeId(args.licenseId, PREFIX.license);
      const stocks = (l: Location) => w.packages.some((k) => k.locationId === l.id && k.status === "ACTIVE" && productIds!.includes(k.productId));
      let locations = w.locations.filter((l) => inList(ids, l.id) && (!licenseId || l.licenseId === licenseId) && (!args.complianceType || licenseOf(w, l).complianceType === args.complianceType)
        && (!productIds || stocks(l)));
      // With search, name similarity ranks; an explicit sortBy wins and similarity breaks its ties (the sort is stable).
      if (args.search) locations = ranked(locations, (l) => closeness(args.search!, [l.name]));
      // Locations carry no timestamps, so creation order stands in for both of them.
      if (!args.search || args.sortBy) locations = sorted(locations, args.sortBy, { INSERTED_AT: (l) => serial(l.id), UPDATED_AT: (l) => serial(l.id), NAME: (l) => l.name }, { field: "UPDATED_AT", direction: "DESC" });
      return page(locations, args, (l) => locationRow(w, l));
    },
  }),

  defineTool<World>({
    name: "search-batches",
    supports: ["limit", "cursor", "ids", "productIds", ...PRODUCT_FILTERS, "productStatus", "search", "sortBy"],
    run(args: Paging & ProductFilters & { ids?: string[]; productIds?: string[]; productStatus?: Status; search?: string }, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.batch), productIds = normalizeIds(args.productIds, PREFIX.product), ofKind = productFilter(w, args);
      const found = w.batches.filter((b) => {
        const p = productOf(w, b.productId);
        return p.tracking === "BATCH" && inList(ids, b.id) && inList(productIds, p.id) && ofKind(p) && inStatus(args.productStatus, p.active);
      });
      // A batch's name is its batch number here, so batch-name similarity ranks the batches whose number matches first.
      const batches = args.search
        ? ranked(found, (b) => { const p = productOf(w, b.productId); return tiers(closeness(args.search!, [b.batchNumber]), closeness(args.search!, [p.name, p.sku])); })
        // Batches are never edited after they are created, so creation time stands in for the update time.
        : sorted(found, args.sortBy, { BATCH_NUMBER: (b) => b.batchNumber, INSERTED_AT: (b) => time(b.createdAt), UPDATED_AT: (b) => time(b.createdAt) }, { field: "UPDATED_AT", direction: "DESC" });
      return page(batches, args, (b) => batchRow(w, b));
    },
  }),

  defineTool<World>({
    name: "get-batch",
    supports: ["id", "includeActiveQuantitiesByLocation", "includeActiveQuantityCostItems"],
    run(args: { id: string; includeActiveQuantitiesByLocation?: boolean; includeActiveQuantityCostItems?: boolean }, { world: w }) {
      const b = w.batches.find((x) => x.id === normalizeId(args.id, PREFIX.batch));
      if (!b) return { batch: null };
      const p = productOf(w, b.productId);
      return {
        batch: {
          ...batchHeader(w, b), description: null, thc: null, cbd: null, url: recordUrl("batch", b.id),
          product: { id: p.id, name: p.name }, owner: null, primaryTestResult: null,
          ...(args.includeActiveQuantitiesByLocation ? { activeQuantitiesByLocation: quantitiesByLocation(w, batchStock(w, b)) } : {}),
          // The world records one cost per product and no cost entries, so there is no breakdown to show.
          ...(args.includeActiveQuantityCostItems ? { activeQuantityCostItems: null } : {}),
        },
      };
    },
  }),

  defineTool<World>({
    name: "search-packages",
    supports: ["limit", "cursor", "ids", "licenseIds", "locationIds", "productIds", ...PRODUCT_FILTERS, "search", "status", "distruStatuses", "withQuantity", "labTestingStates", "syncing", "sortBy"],
    run(args: Paging & ProductFilters & {
      ids?: string[]; licenseIds?: string[]; locationIds?: string[]; productIds?: string[]; search?: string; status?: Status;
      distruStatuses?: string[]; withQuantity?: boolean; labTestingStates?: string[]; syncing?: boolean;
    }, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.package), licenseIds = normalizeIds(args.licenseIds, PREFIX.license);
      const locationIds = normalizeIds(args.locationIds, PREFIX.location), productIds = normalizeIds(args.productIds, PREFIX.product), ofKind = productFilter(w, args);
      const fullLabel = isFullLabel(args.search);
      const withQuantity = args.withQuantity ?? (ids || fullLabel ? undefined : true);
      // Every package is active in Distru (none is hidden), so only INACTIVE narrows anything.
      const shown = inStatus(args.status, true);
      const found = w.packages.filter((k) => {
        const p = productOf(w, k.productId);
        return p.active && shown && inList(ids, k.id) && inList(licenseIds, k.licenseId) && inList(locationIds, k.locationId) && inList(productIds, p.id) && ofKind(p)
          && inList(args.distruStatuses, k.status) && (withQuantity === undefined || (k.quantity > 0) === withQuantity)
          && inList(args.labTestingStates, LAB_STATE[k.labTestingState]) && (args.syncing === undefined || (pendingSync(w, k) !== undefined) === args.syncing);
      });
      // A full label is looked up exactly. Otherwise label matches rank first, then the product's name or SKU (its name also within a typo); sortBy is ignored.
      const score = (k: Package) => {
        if (fullLabel) return k.metrcLabel.toLowerCase() === args.search!.toLowerCase() ? 0 : undefined;
        const p = productOf(w, k.productId);
        return tiers(closeness(args.search!, [k.metrcLabel]), closeness(args.search!, [p.sku], [p.name]));
      };
      const packages = args.search
        ? ranked(found, score)
        : sorted(found, args.sortBy, { COMPLIANCE_LABEL: (k) => k.metrcLabel, INSERTED_AT: (k) => time(k.createdAt), QUANTITY: (k) => k.quantity, UPDATED_AT: (k) => time(k.createdAt) }, { field: "UPDATED_AT", direction: "DESC" });
      return page(packages, args, (k) => packageRow(w, k));
    },
  }),

  defineTool<World>({
    name: "get-package",
    supports: ["id", "includeQuantityCostItems"],
    run(args: { id: string; includeQuantityCostItems?: boolean }, { world: w }) {
      const k = w.packages.find((x) => x.id === normalizeId(args.id, PREFIX.package));
      return { package: k ? packageDetail(w, k, args.includeQuantityCostItems === true) : null };
    },
  }),

  defineTool<World>({
    name: "move-stock",
    supports: ["fromLocationId", "toLocationId", "items", "description", "transferDatetime"],
    run(args: { fromLocationId: string; toLocationId: string; items: MoveItem[]; description?: string; transferDatetime?: string }, c: C) {
      const w = c.world;
      const from = find(w.locations, normalizeId(args.fromLocationId, PREFIX.location), "location");
      const to = find(w.locations, normalizeId(args.toLocationId, PREFIX.location), "location");
      if (from === to) throw new ToolError("fromLocationId and toLocationId are the same location: send two different locations.");
      if (!args.items.length) throw new ToolError("Send at least one item to move.");
      const lines = args.items.map((item) => moveLine(w, item));
      checkStock(lines, from);
      const transferDatetime = args.transferDatetime === undefined ? stamp(c) : isoIn(w.timezone, instant(args.transferDatetime));

      for (const line of lines) {
        shift(stockOf(line), from.id, -line.quantity);
        shift(stockOf(line), to.id, line.quantity);
      }
      const id = newId(w, PREFIX.stockTransfer);
      const transfer: StockTransfer = {
        id, number: `ST-${serial(id)}`, fromLocationId: from.id, toLocationId: to.id, description: args.description ?? null, transferDatetime, completedAt: stamp(c),
        items: lines.map((l) => ({ productId: l.product.id, batchId: l.batch?.id ?? null, quantity: l.quantity })),
      };
      w.stockTransfers.push(transfer);
      const head = { type: "STOCK_TRANSFER" as const, id: transfer.id, name: transfer.number };
      recordAction(c, [
        { ...head, entity: "STOCK_TRANSFER", rowId: transfer.id, op: "INSERT", rowLabel: null, fields: [
          { field: "fromLocationId", label: "From", oldValue: null, newValue: from.name }, { field: "toLocationId", label: "To", oldValue: null, newValue: to.name },
        ] },
        // The world gives a transfer's lines no id.
        ...lines.map((l) => ({ ...head, entity: "STOCK_TRANSFER_ITEM" as const, rowId: null, op: "INSERT" as const, rowLabel: l.product.name, fields: [{ field: "quantity", label: "Quantity", oldValue: null, newValue: qty(l.quantity) }] })),
      ]);
      return { stockTransfer: transferRow(w, transfer) };
    },
  }),

  defineTool<World>({
    name: "search-stock-transfers",
    supports: ["limit", "cursor", "ids", "search", "statuses", "fromLocationIds", "toLocationIds", "productIds", "batchIds", "packageIds",
      "transferDatetimeAfter", "transferDatetimeBefore", "completedAtAfter", "completedAtBefore", "sortBy"],
    run(args: Paging & {
      ids?: string[]; search?: string; statuses?: string[]; fromLocationIds?: string[]; toLocationIds?: string[]; productIds?: string[]; batchIds?: string[]; packageIds?: string[];
      transferDatetimeAfter?: string; transferDatetimeBefore?: string; completedAtAfter?: string; completedAtBefore?: string;
    }, { world: w }) {
      const tz = w.timezone, ids = normalizeIds(args.ids, PREFIX.stockTransfer);
      const from = normalizeIds(args.fromLocationIds, PREFIX.location), to = normalizeIds(args.toLocationIds, PREFIX.location);
      const productIds = normalizeIds(args.productIds, PREFIX.product), batchIds = normalizeIds(args.batchIds, PREFIX.batch);
      const packageIds = normalizeIds(args.packageIds, PREFIX.package);
      const initiated = [bound(args.transferDatetimeAfter, "after", tz), bound(args.transferDatetimeBefore, "before", tz)] as const;
      const completed = [bound(args.completedAtAfter, "after", tz), bound(args.completedAtBefore, "before", tz)] as const;
      let transfers = w.stockTransfers.filter((t) => inList(ids, t.id) && (!args.statuses || args.statuses.includes("COMPLETED")) && inList(from, t.fromLocationId) && inList(to, t.toLocationId)
        && (!productIds || t.items.some((i) => productIds.includes(i.productId))) && (!batchIds || t.items.some((i) => inList(batchIds, i.batchId)))
        // Lines in this world never carry a package: stock moved by package goes through distru-move-packages.
        && !packageIds
        && within(t.transferDatetime, ...initiated) && within(t.completedAt, ...completed));
      // With search, closeness to the number ranks and sortBy is ignored.
      transfers = args.search
        ? ranked(transfers, (t) => closeness(args.search!, [t.number]))
        : sorted(transfers, args.sortBy, {
          // Transfers are never edited after they complete, so the order they were recorded in is the order they last changed.
          COMPLETED_AT: (t) => time(t.completedAt), INITIATED_AT: (t) => time(t.transferDatetime), INSERTED_AT: (t) => serial(t.id), STOCK_TRANSFER_NUMBER: (t) => serial(t.id), UPDATED_AT: (t) => serial(t.id),
        }, { field: "UPDATED_AT", direction: "DESC" });
      return page(transfers, args, (t) => transferRow(w, t));
    },
  }),

  defineTool<World>({
    name: "report-inventory-assets",
    supports: ["cursor", "locationId", ...PRODUCT_FILTERS, "maxRowsLimit"],
    run(args: ProductFilters & { cursor?: string; locationId?: string; maxRowsLimit?: number }, c: C) {
      const w = c.world, ofKind = productFilter(w, args);
      const locationId = args.locationId === undefined ? undefined : normalizeId(args.locationId, PREFIX.location);
      const rows = w.products.filter(ofKind).flatMap((p) => holdings(w, p)).filter((h) => h.quantity !== 0 && (!locationId || h.locationId === locationId)).map((h) => assetRow(w, h));
      return report({ report: "Inventory assets", dateRange: `as of ${stamp(c)}`, columns: ASSET_COLUMNS }, rows, args);
    },
  }),
];
