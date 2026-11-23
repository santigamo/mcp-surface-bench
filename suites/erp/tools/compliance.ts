// Metrc compliance: the company's licenses, and the packages, rooms, manifests and sync queue Distru keeps from Metrc.
import { addDays, bound, matches, normalizeId, normalizeIds, page, qty, sorted, within, type SortBy } from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import { PREFIX, type Id, type License, type MetrcActivity, type MetrcManifest, type MetrcPackage, type World } from "../world.ts";
import { find, stamp, userRef, type C } from "./shared.ts";

const licenseRef = (w: World, id: Id) => {
  const l = w.licenses.find((x) => x.id === id)!;
  return { id: l.id, licenseNumber: l.licenseNumber };
};

const byTime = (iso: string) => Date.parse(iso);

/** An activity type as the documentation names it: the world's MOVE_PACKAGE is Metrc's CHANGE_PACKAGE_LOCATION. */
const activityType = (a: MetrcActivity) => (a.type === "MOVE_PACKAGE" ? "CHANGE_PACKAGE_LOCATION" : a.type);

// ---------- licenses ----------

/** How far Distru's copy of Metrc has caught up: the call instant for every kind synced on a schedule. */
function pullStatus(c: C, l: License) {
  const now = stamp(c);
  const cultivation = l.kind === "CULTIVATION" ? now : null;
  return {
    cachesUpdatedUpUntil: {
      harvests: cultivation, items: now, locations: now, packages: now, plantAdditives: null, plantBatches: cultivation,
      plants: cultivation, processingJobs: now, salesReceipts: null, strains: now, transfers: now,
    },
    hasInProgressBackfills: false,
  };
}

/** The license's sync queue, from its Metrc activities. The world keeps one attempt per activity. */
function pushStatus(w: World, l: License) {
  const mine = w.metrcActivities.filter((a) => a.licenseId === l.id);
  const oldestFirst = [...mine].sort((a, b) => byTime(a.insertedAt) - byTime(b.insertedAt));
  const oldest = oldestFirst.find((a) => a.status !== "COMPLETED");
  return {
    queuedCount: mine.filter((a) => a.status === "QUEUED").length,
    failedCount: mine.filter((a) => a.status === "FAILED").length,
    lastCompletedActivityDatetime: oldestFirst.findLast((a) => a.status === "COMPLETED")?.insertedAt ?? null,
    oldestIncompleteActivity: oldest
      ? {
          title: oldest.title,
          type: activityType(oldest),
          status: oldest.status === "FAILED" ? "FAILED" : "PENDING",
          queuedDatetime: oldest.insertedAt,
          lastAttemptDatetime: oldest.insertedAt,
          errorCount: oldest.lastError ? 1 : 0,
          error: oldest.lastError,
          // The world's failures are all Metrc rejecting the change.
          errorType: oldest.lastError ? "EXTERNAL_VALIDATION" : null,
        }
      : null,
  };
}

// The world has no license dates; a year out keeps every license current.
const expiryDate = (w: World) => addDays(w.today, 365);

const licenseRow = (c: C, l: License) => ({
  id: l.id,
  licenseNumber: l.licenseNumber,
  licenseType: l.kind,
  complianceType: l.complianceType,
  active: l.active,
  hasCultivation: l.kind === "CULTIVATION",
  issueDate: null,
  expiryDate: expiryDate(c.world),
  metrcPullStatus: pullStatus(c, l),
  metrcPushStatus: pushStatus(c.world, l),
});

// ---------- rooms ----------

type Room = { id: string; name: string; licenseId: Id };

/**
 * The rooms Metrc holds: each Distru location is a room of its license's facility, and so is any other room name a
 * synced package is in. Metrc numbers rooms itself; here they are numbered in that order.
 */
function metrcRooms(w: World): Room[] {
  const rooms: Room[] = [];
  const add = (name: string, licenseId: Id) => {
    if (!rooms.some((r) => r.name === name && r.licenseId === licenseId)) rooms.push({ id: String(7101 + rooms.length), name, licenseId });
  };
  for (const l of w.locations) add(l.name, l.licenseId);
  for (const m of w.metrcPackages) add(m.metrcLocationName, m.licenseId);
  return rooms;
}

const roomOf = (rooms: Room[], m: MetrcPackage) => rooms.find((r) => r.name === m.metrcLocationName && r.licenseId === m.licenseId)!;

// ---------- packages ----------

/** The Distru package imported from a Metrc label, if any. */
const distruPackage = (w: World, label: string) => w.packages.find((k) => k.metrcLabel === label);

/** The product the last Distru package imported from this Metrc item on this license was, while that product is active. */
function mappedProduct(w: World, licenseId: Id, itemName: string) {
  const imported = w.metrcPackages
    .filter((m) => m.licenseId === licenseId && m.itemName === itemName)
    .map((m) => distruPackage(w, m.label))
    .filter((k) => k !== undefined)
    .sort((a, b) => byTime(b.createdAt) - byTime(a.createdAt));
  const last = imported[0];
  const p = last && w.products.find((x) => x.id === last.productId);
  return p?.active ? { id: p.id, name: p.name } : null;
}

/** The Distru unit for a Metrc unit of measure. Metrc names units in the plural ("Grams"), Distru in the singular ("Gram"). */
function distruUnit(w: World, unitOfMeasure: string) {
  const u = w.unitTypes.find((x) => x.name === unitOfMeasure || `${x.name}s` === unitOfMeasure);
  return u ? { id: u.id, name: u.name } : null;
}

/** Metrc item ids: the world names items only, so each license's items are numbered in the order they first appear. */
function metrcItemIds(w: World): Map<string, string> {
  const ids = new Map<string, string>();
  for (const m of w.metrcPackages) {
    const key = `${m.licenseId}|${m.itemName}`;
    if (!ids.has(key)) ids.set(key, String(5201 + ids.size));
  }
  return ids;
}

const IMPORT_STATUS: Record<"IMPORTED" | "UNIMPORTED" | "IMPORTABLE", (m: MetrcPackage) => boolean> = {
  IMPORTED: (m) => m.importStatus === "IMPORTED",
  // The world has no packages ignored for import, so every package not in Distru is UNIMPORTED.
  UNIMPORTED: (m) => m.importStatus === "UNIMPORTED",
  IMPORTABLE: (m) => m.importStatus === "UNIMPORTED" && (m.status === "ACTIVE" || m.status === "ONHOLD") && m.quantity > 0,
};

function metrcPackageRow(w: World, m: MetrcPackage, rooms: Room[], itemIds: Map<string, string>) {
  const room = roomOf(rooms, m);
  const k = distruPackage(w, m.label);
  const product = k && w.products.find((p) => p.id === k.productId)!;
  const manifest = w.metrcManifests.find((x) => x.direction === "INCOMING" && x.licenseId === m.licenseId && x.packages.some((p) => p.label === m.label));
  return {
    metrcId: m.metrcId,
    label: m.label,
    status: m.status,
    quantity: qty(m.quantity),
    unitType: distruUnit(w, m.unitOfMeasure),
    metrcItem: { id: itemIds.get(`${m.licenseId}|${m.itemName}`)!, name: m.itemName, category: m.itemCategory },
    strainName: m.strainName,
    metrcLocation: { id: room.id, name: room.name },
    labTestingState: m.labTestingState,
    labTestingStateDate: null,
    productionBatchNumber: null,
    packagedDate: m.packagedDate,
    expirationDate: null,
    finishedDate: null,
    archivedDate: null,
    note: null,
    sourcePackageLabels: [],
    sourceHarvestNames: [],
    receivedFromManifestNumber: manifest?.manifestNumber ?? null,
    receivedFromLicenseNumber: manifest?.counterpartyLicense ?? null,
    // The world does not model sample or production-batch flags.
    isTestingSample: false,
    isTradeSample: false,
    isProductionBatch: false,
    isFinishedGood: false,
    lastModifiedDatetime: m.lastModified,
    package: k && product ? { id: k.id, metrcLabel: k.metrcLabel, product: { id: product.id, name: product.name } } : null,
    productMostRecentlyMappedToMetrcItem: mappedProduct(w, m.licenseId, m.itemName),
  };
}

type PackageArgs = {
  limit?: number;
  cursor?: string;
  licenseId: string;
  search?: string;
  labels?: string[];
  metrcIds?: number[];
  statuses?: MetrcPackage["status"][];
  importStatus?: keyof typeof IMPORT_STATUS;
  searchMetrcItem?: string;
  searchMetrcStrain?: string;
  searchMetrcCategory?: string;
  metrcLocationIds?: string[];
  labTestingStates?: string[];
  sortBy?: SortBy;
};

function packageFilter(w: World, args: PackageArgs, rooms: Room[]): (m: MetrcPackage) => boolean {
  const licenseId = find(w.licenses, normalizeId(args.licenseId, PREFIX.license), "license").id;
  for (const id of args.metrcLocationIds ?? []) {
    if (!rooms.some((r) => r.id === id)) throw new ToolError(`No Metrc location with id ${id}: resolve Metrc location ids via distru-search-metrc-locations, not distru-search-locations.`);
  }
  const statuses: string[] = args.statuses ?? ["ACTIVE", "ONHOLD"];
  const labels = args.labels?.map((l) => l.toUpperCase());
  return (m) =>
    m.licenseId === licenseId &&
    statuses.includes(m.status) &&
    (!args.importStatus || IMPORT_STATUS[args.importStatus](m)) &&
    matches(args.search, m.label) &&
    (!labels || labels.includes(m.label.toUpperCase())) &&
    (!args.metrcIds || args.metrcIds.includes(m.metrcId)) &&
    matches(args.searchMetrcItem, m.itemName) &&
    matches(args.searchMetrcStrain, m.strainName) &&
    matches(args.searchMetrcCategory, m.itemCategory) &&
    (!args.metrcLocationIds || args.metrcLocationIds.includes(roomOf(rooms, m).id)) &&
    (!args.labTestingStates || args.labTestingStates.includes(m.labTestingState));
}

// ---------- activities ----------

function activityRow(w: World, a: MetrcActivity) {
  const k = a.packageId ? w.packages.find((x) => x.id === a.packageId) : undefined;
  return {
    id: a.id,
    type: activityType(a),
    title: a.title,
    description: a.description,
    status: a.status,
    lastError: a.lastError,
    insertedAt: a.insertedAt,
    // The world keeps one attempt per activity, so it last changed when it was queued.
    updatedAt: a.insertedAt,
    license: licenseRef(w, a.licenseId),
    creator: userRef(w, a.creatorId)!,
    package: k ? { id: k.id, metrcLabel: k.metrcLabel } : null,
    assembly: null,
  };
}

// ---------- manifests ----------

const received = (x: MetrcManifest) => x.receivedDate !== null;
const lastModified = (x: MetrcManifest) => x.receivedDate ?? x.createdDate;

/** The company's side of a manifest is its license; the other side is the counterparty. */
function parties(w: World, x: MetrcManifest) {
  const own = w.licenses.find((l) => l.id === x.licenseId)!;
  const ours = { name: own.name, licenseNumber: own.licenseNumber };
  const theirs = { name: x.counterpartyName, licenseNumber: x.counterpartyLicense };
  return x.direction === "INCOMING" ? { shipper: theirs, recipient: ours } : { shipper: ours, recipient: theirs };
}

const importable = (x: MetrcManifest) => x.packages.every((p) => p.labTestingState === "TestPassed");

/** A manifest as both manifest tools return it, without its deliveries. */
function manifestRow(c: C, x: MetrcManifest) {
  const { shipper, recipient } = parties(c.world, x);
  return {
    manifestNumber: x.manifestNumber,
    shipperName: shipper.name,
    shipperLicenseNumber: shipper.licenseNumber,
    transporterName: null,
    transporterLicenseNumber: null,
    recipients: [recipient],
    shipmentTypeName: null,
    packageCount: x.packages.length,
    // The world does not link manifests to orders or transfers, so none is imported.
    importStatus: "UNIMPORTED",
    isImportable: importable(x),
    importableDetails: importable(x) ? null : "Every package must have passed lab testing before the manifest can be imported.",
    license: licenseRef(c.world, x.licenseId),
    salesOrder: null,
    purchaseOrder: null,
    createdDatetime: x.createdDate,
    lastModifiedDatetime: lastModified(x),
    receivedDatetime: x.receivedDate,
    // The world has no canceled manifests.
    voided: false,
    // Transfers sync every 2 minutes, so this is the call instant.
    fetchedDatetime: stamp(c),
    direction: x.direction,
  };
}

/** The one delivery of a manifest: the world's manifests each go to a single recipient. */
function delivery(w: World, x: MetrcManifest) {
  const { recipient } = parties(w, x);
  return {
    recipientName: recipient.name,
    recipientLicenseNumber: recipient.licenseNumber,
    actualDepartureDatetime: null,
    actualArrivalDatetime: x.receivedDate,
    receivedDatetime: x.receivedDate,
    packages: x.packages.map((p) => {
      const unit = distruUnit(w, p.unitOfMeasure);
      const k = distruPackage(w, p.label);
      const product = k && w.products.find((q) => q.id === k.productId)!;
      return {
        label: p.label,
        itemName: p.itemName,
        itemCategoryName: p.itemCategory,
        // The world records whole manifests as received, never a package rejected or returned.
        status: received(x) ? "ACCEPTED" : "SHIPPED",
        isTestingSample: false,
        shippedQuantity: qty(p.quantity),
        shippedUnitType: unit,
        receivedQuantity: received(x) ? qty(p.quantity) : null,
        receivedUnitType: received(x) ? unit : null,
        wholesalePrice: null,
        // Distru packages carry no cost of their own here: cost lives on the product.
        package: k && product ? { id: k.id, metrcLabel: k.metrcLabel, hasCost: false, quantity: qty(k.quantity), quantityCost: null, product: { id: product.id, name: product.name } } : null,
        productMostRecentlyMappedToMetrcItem: mappedProduct(w, x.licenseId, p.itemName),
      };
    }),
  };
}

type ManifestArgs = {
  limit?: number;
  cursor?: string;
  search?: string;
  searchLicenseNumber?: string;
  direction?: MetrcManifest["direction"];
  licenseIds?: string[];
  packageLabel?: string;
  received?: boolean;
  voided?: boolean;
  sortBy?: SortBy;
};

function manifestFilter(w: World, args: ManifestArgs): (x: MetrcManifest) => boolean {
  const licenseIds = normalizeIds(args.licenseIds, PREFIX.license);
  return (x) => {
    const { shipper, recipient } = parties(w, x);
    return (
      (!args.search || x.manifestNumber.includes(args.search)) &&
      matches(args.searchLicenseNumber, shipper.licenseNumber, recipient.licenseNumber) &&
      (!args.direction || x.direction === args.direction) &&
      (!licenseIds || licenseIds.includes(x.licenseId)) &&
      (!args.packageLabel || x.packages.some((p) => p.label === args.packageLabel)) &&
      (args.received === undefined || received(x) === args.received) &&
      // No manifest is voided, so only voided: true leaves any out.
      args.voided !== true
    );
  };
}

// ---------- tools ----------

export const tools = [
  defineTool<World>({
    name: "search-licenses",
    supports: ["limit", "cursor", "complianceType", "ids", "sortBy", "status"],
    run(args: { limit?: number; cursor?: string; complianceType?: string; ids?: string[]; sortBy?: SortBy; status?: "ACTIVE" | "ANY" | "INACTIVE" }, c) {
      const ids = normalizeIds(args.ids, PREFIX.license);
      const status = args.status ?? "ACTIVE";
      const licenses = c.world.licenses.filter(
        (l) => (!ids || ids.includes(l.id)) && (!args.complianceType || l.complianceType === args.complianceType) && (status === "ANY" || (status === "ACTIVE") === l.active),
      );
      // Licenses carry no timestamps here; their ids are in the order they were added, and none has changed since.
      const order = (l: License) => +l.id.split("_")[1]!;
      const ordered = sorted(licenses, args.sortBy, { EXPIRY_DATE: () => expiryDate(c.world), INSERTED_AT: order, LICENSE_NUMBER: (l) => l.licenseNumber, UPDATED_AT: order }, { field: "UPDATED_AT", direction: "DESC" });
      return page(ordered, args, (l) => licenseRow(c, l));
    },
  }),

  defineTool<World>({
    name: "search-metrc-packages",
    supports: [
      "limit", "cursor", "licenseId", "search", "labels", "metrcIds", "statuses", "importStatus", "searchMetrcItem", "searchMetrcStrain", "searchMetrcCategory",
      "metrcLocationIds", "labTestingStates", "sortBy",
    ],
    run(args: PackageArgs, { world: w }) {
      const rooms = metrcRooms(w);
      const keep = packageFilter(w, args, rooms);
      const ordered = sorted(w.metrcPackages.filter(keep), args.sortBy, {
        INSERTED_AT: (m) => Date.parse(m.packagedDate),
        UPDATED_AT: (m) => byTime(m.lastModified),
        LABEL: (m) => m.label,
      }, { field: "UPDATED_AT", direction: "DESC" });
      const itemIds = metrcItemIds(w);
      return page(ordered, args, (m) => metrcPackageRow(w, m, rooms, itemIds));
    },
  }),

  defineTool<World>({
    name: "search-metrc-activities",
    supports: ["limit", "cursor", "createdDateAfter", "createdDateBefore", "creatorIds", "ids", "licenseIds", "packageIds", "sortBy", "statuses"],
    run(
      args: {
        limit?: number; cursor?: string; createdDateAfter?: string; createdDateBefore?: string; creatorIds?: string[]; ids?: string[];
        licenseIds?: string[]; packageIds?: string[]; sortBy?: SortBy; statuses?: MetrcActivity["status"][];
      },
      { world: w },
    ) {
      const after = bound(args.createdDateAfter, "after", w.timezone);
      const before = bound(args.createdDateBefore, "before", w.timezone);
      const ids = normalizeIds(args.ids, PREFIX.metrcActivity);
      const creatorIds = normalizeIds(args.creatorIds, PREFIX.user);
      const licenseIds = normalizeIds(args.licenseIds, PREFIX.license);
      const packageIds = normalizeIds(args.packageIds, PREFIX.package);
      const found = w.metrcActivities.filter(
        (a) =>
          within(a.insertedAt, after, before) &&
          (!ids || ids.includes(a.id)) &&
          (!creatorIds || creatorIds.includes(a.creatorId)) &&
          (!licenseIds || licenseIds.includes(a.licenseId)) &&
          (!packageIds || (a.packageId !== null && packageIds.includes(a.packageId))) &&
          (!args.statuses || args.statuses.includes(a.status)),
      );
      const ordered = sorted(found, args.sortBy, { INSERTED_AT: (a) => byTime(a.insertedAt) }, { field: "INSERTED_AT", direction: "DESC" });
      return page(ordered, args, (a) => activityRow(w, a));
    },
  }),

  defineTool<World>({
    name: "search-metrc-manifests",
    supports: ["limit", "cursor", "search", "searchLicenseNumber", "direction", "licenseIds", "packageLabel", "received", "voided", "sortBy"],
    run(args: ManifestArgs, c) {
      const found = c.world.metrcManifests.filter(manifestFilter(c.world, args));
      // MANIFEST_NUMBER sorts like INSERTED_AT, as the documentation says.
      const created = (x: MetrcManifest) => byTime(x.createdDate);
      const ordered = sorted(found, args.sortBy, { INSERTED_AT: created, UPDATED_AT: (x) => byTime(lastModified(x)), MANIFEST_NUMBER: created }, { field: "UPDATED_AT", direction: "DESC" });
      return page(ordered, args, (x) => manifestRow(c, x));
    },
  }),

  defineTool<World>({
    name: "get-metrc-manifest",
    supports: ["manifestNumber", "direction", "includeDeliveries"],
    run(args: { manifestNumber: string; direction?: MetrcManifest["direction"]; includeDeliveries?: boolean }, c) {
      const sides = c.world.metrcManifests.filter((x) => x.manifestNumber === args.manifestNumber.trim());
      // A transfer between two of the company's licenses has both sides; OUTGOING is read unless direction says otherwise.
      const x = args.direction ? sides.find((s) => s.direction === args.direction) : (sides.find((s) => s.direction === "OUTGOING") ?? sides[0]);
      if (!x) return { manifest: null };
      return { manifest: { ...manifestRow(c, x), ...(args.includeDeliveries ? { deliveries: [delivery(c.world, x)] } : {}) } };
    },
  }),

  defineTool<World>({
    name: "search-metrc-locations",
    supports: ["limit", "cursor", "licenseId", "search"],
    run(args: { limit?: number; cursor?: string; licenseId?: string; search?: string }, { world: w }) {
      const licenseId = args.licenseId ? find(w.licenses, normalizeId(args.licenseId, PREFIX.license), "license").id : undefined;
      const rooms = metrcRooms(w).filter((r) => (!licenseId || r.licenseId === licenseId) && matches(args.search, r.name));
      return page(rooms.sort((a, b) => a.name.localeCompare(b.name)), args, (r) => ({ id: r.id, name: r.name, license: licenseRef(w, r.licenseId) }));
    },
  }),
];
