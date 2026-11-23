// The benchmark company: every record the tools read and write. Plain JSON data, so a world can be saved
// after a run and compared with the world it started from.

export type Id = string;
export type Named = { id: Id; name: string };

export type User = { id: Id; firstName: string; lastName: string; email: string; role: string };
/** One of the company's own state licenses. `expiryDate` is YYYY-MM-DD. */
export type License = { id: Id; licenseNumber: string; name: string; kind: "DISTRIBUTION" | "CULTIVATION"; complianceType: "METRC"; active: boolean; expiryDate: string };
export type Location = { id: Id; name: string; licenseId: Id };

export type Category = Named & {
  /** The fixed category type menus and reports group by. */
  official: "FLOWER" | "PREROLLS" | "EDIBLES" | "VAPES" | "CONCENTRATES";
  subcategories: Named[];
};
export type Strain = Named & { strainType: "INDICA" | "SATIVA" | "HYBRID" };
export type UnitType = Named & { category: "COUNT" | "WEIGHT" | "VOLUME" };

export type CustomField = {
  id: Id;
  entityType: string;
  name: string;
  fieldType: "CHECKBOX" | "DATE" | "DROPDOWN" | "TEXT";
  description: string | null;
  required: boolean;
  options: string[];
};

export type Company = {
  id: Id;
  name: string;
  legalName: string;
  relationship: "CUSTOMER" | "VENDOR";
  /** The sales rep (customers) or buyer (vendors) responsible for the account. */
  ownerId: Id | null;
  invoiceEmail: string | null;
  phone: string | null;
  city: string;
  state: string;
  zip: string;
  licenseNumber: string | null;
  groupId: Id | null;
  paymentTermId: Id | null;
  createdAt: string;
};

export type Contact = {
  id: Id;
  companyId: Id;
  firstName: string;
  lastName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  ownerId: Id | null;
  createdAt: string;
};

export type Product = {
  id: Id;
  name: string;
  sku: string;
  active: boolean;
  categoryId: Id;
  subcategoryId: Id | null;
  strainId: Id | null;
  /** Brand and vendor are companies. */
  brandId: Id | null;
  vendorId: Id | null;
  groupId: Id | null;
  tagIds: Id[];
  unitTypeId: Id;
  /** How stock is held: in lots (batches), in tagged packages, or as a plain count per location. */
  tracking: "BATCH" | "PACKAGE" | "PRODUCT";
  unitPrice: number;
  unitCost: number;
  /** Low- and high-stock alerts on the available quantity. */
  thresholdMin: number | null;
  thresholdMax: number | null;
  /** Units held by open orders: on hand but not available. */
  reserved: number;
  /** Total THC as a percentage; null for products sold by milligrams. */
  thcPercent: number | null;
  /** Stock of a product-tracked product, per location. */
  stock: { locationId: Id; quantity: number }[];
  createdAt: string;
  updatedAt: string;
};

/**
 * A lot of a product. A batch-tracked product holds its stock in its batches' `stock`; a package-tracked product's
 * batch holds none itself, its stock is in the packages that point at it (see `batchStock`).
 */
export type Batch = {
  id: Id;
  productId: Id;
  batchNumber: string;
  thcPercent: number | null;
  stock: { locationId: Id; quantity: number }[];
  createdAt: string;
};

export type Package = {
  id: Id;
  productId: Id;
  batchId: Id;
  metrcLabel: string;
  quantity: number;
  locationId: Id;
  licenseId: Id;
  status: "ACTIVE" | "FINISHED";
  labTestingState: "TestPassed" | "NotSubmitted";
  createdAt: string;
};

export type StockTransfer = {
  id: Id;
  number: string;
  fromLocationId: Id;
  toLocationId: Id;
  items: { productId: Id; batchId: Id | null; quantity: number }[];
  description: string | null;
  /** The date the transfer shows, which the caller may set. */
  transferDatetime: string;
  /** When its stock arrived: transfers complete at once, when they are recorded. */
  completedAt: string;
};

export type OrderStatus = "PENDING" | "PROCESSING" | "READY_TO_SHIP" | "DELIVERING" | "DELIVERED" | "COMPLETED" | "CANCELED";

export type SalesOrder = {
  id: Id;
  orderNumber: string;
  customerId: Id;
  ownerId: Id;
  status: OrderStatus;
  orderDatetime: string;
  dueDatetime: string;
  deliveryDatetime: string | null;
  locationId: Id;
  menuId: Id | null;
  /** `unitCost` is the cost of the units sold, fixed when the order shipped. */
  items: { id: Id; productId: Id; batchId: Id | null; packageId: Id | null; quantity: number; unitPrice: number; unitCost: number }[];
  internalNotes: string | null;
};

export type Invoice = {
  id: Id;
  invoiceNumber: string;
  salesOrderId: Id;
  customerId: Id;
  ownerId: Id;
  invoiceDatetime: string;
  dueDatetime: string;
  voided: boolean;
};

export type Payment = {
  id: Id;
  paymentNumber: string;
  amount: number;
  /** When the money was paid or received. */
  paymentDatetime: string;
  /** When the payment was entered in Distru. */
  recordedAt: string;
  paymentMethodId: Id;
  note: string | null;
  voidedAt: string | null;
};
export type InvoicePayment = Payment & { invoiceId: Id };
export type PurchasePayment = Payment & { purchaseId: Id };

export type PurchaseOrder = {
  id: Id;
  purchaseNumber: string;
  vendorId: Id;
  ownerId: Id;
  status: "DRAFT" | "PENDING" | "PROCESSING" | "DELIVERING" | "PARTIALLY_RECEIVED" | "COMPLETED";
  orderDatetime: string;
  dueDatetime: string;
  locationId: Id;
  items: { id: Id; productId: Id; quantity: number; unitCost: number }[];
};

export type Task = {
  id: Id;
  name: string;
  description: string | null;
  status: "ACTIVE" | "COMPLETED";
  dueDate: string;
  ownerId: Id | null;
  creatorId: Id;
  related: { type: "COMPANY" | "SALES_ORDER" | "PURCHASE_ORDER" | "INVOICE" | "PRODUCT"; id: Id } | null;
  createdAt: string;
};

export type Menu = {
  id: Id;
  name: string;
  /** The name buyers see. */
  externalName: string;
  urlSuffix: string;
  active: boolean;
  visibility: "PUBLIC" | "PRIVATE" | "PASSCODE_PROTECTED";
  ownerId: Id | null;
  allowPartnerOrders: boolean;
  hidePricesMode: "DO_NOT_HIDE" | "HIDE_FOR_EVERYONE" | "HIDE_FOR_NON_LOGGED_IN_USERS";
  minimumOrderSubtotal: number | null;
  minimumOrderLeadTimeDays: number;
  sellByCaseOnly: boolean;
  showInventoryLevels: boolean;
  /** Products listed on the menu, with when each was added. */
  products: { productId: Id; addedAt: string }[];
  createdAt: string;
  updatedAt: string;
};

export type MetrcPackage = {
  metrcId: number;
  label: string;
  licenseId: Id;
  itemName: string;
  itemCategory: string;
  strainName: string | null;
  quantity: number;
  unitOfMeasure: string;
  status: "ACTIVE" | "ONHOLD" | "FINISHED";
  /** Whether the package is in the company's inventory yet. */
  importStatus: "IMPORTED" | "UNIMPORTED";
  labTestingState: "TestPassed" | "NotSubmitted";
  metrcLocationName: string;
  packagedDate: string;
  lastModified: string;
};

export type MetrcActivity = {
  id: Id;
  type: "ADJUST_PACKAGE" | "CHANGE_PACKAGE_LOCATION" | "CREATE_PACKAGE" | "FINISH_PACKAGE";
  title: string;
  description: string;
  status: "QUEUED" | "FAILED" | "COMPLETED";
  lastError: string | null;
  licenseId: Id;
  creatorId: Id;
  packageId: Id | null;
  insertedAt: string;
};

export type MetrcManifest = {
  manifestNumber: string;
  direction: "INCOMING" | "OUTGOING";
  licenseId: Id;
  /** The other party: shipper of an incoming manifest, recipient of an outgoing one. */
  counterpartyName: string;
  counterpartyLicense: string;
  createdDate: string;
  estimatedArrival: string;
  receivedDate: string | null;
  packages: { label: string; itemName: string; itemCategory: string; quantity: number; unitOfMeasure: string; labTestingState: string }[];
};

/** A plant group (Metrc plant batch). Whether it is active is derived from its plants: see `plantGroupActive`. */
export type PlantGroup = { id: Id; name: string; strainName: string; licenseId: Id; locationId: Id; plantedAt: string };
export type Plant = {
  id: Id;
  metrcLabel: string;
  plantGroupId: Id;
  status: "IMMATURE" | "VEGETATIVE" | "FLOWERING" | "HARVESTED" | "DESTROYED";
  plantedAt: string;
  floweredAt: string | null;
  harvestedAt: string | null;
  isMother: boolean;
};
export type Harvest = {
  id: Id;
  name: string;
  strainName: string;
  licenseId: Id;
  locationId: Id;
  status: "DRYING" | "PACKAGING" | "FINISHED";
  harvestedAt: string;
  finishedDate: string | null;
  /** Grams. */
  wetWeight: number;
  plantCount: number;
};

/**
 * The records the world logs changes to, by the documented type (`records[].type` of search-activity; all but
 * CUSTOM_FIELD are also `recordType`s of get-record-history).
 */
export type RecordType =
  | "COMPANY" | "COMPANY_GROUP" | "COMPLIANCE_TRANSFER" | "CUSTOM_FIELD" | "INVOICE" | "MENU" | "PAYMENT_METHOD" | "PRODUCT" | "PRODUCT_CATEGORY"
  | "PRODUCT_GROUP" | "PURCHASE" | "SALES_ORDER" | "STOCK_TRANSFER" | "TAG";

/** What a logged row is (`rows[].entity` of get-record-history): the record itself, or one of its lines. */
export type RowEntity = RecordType | "CONTACT" | "INVOICE_RECIPIENT_EMAIL" | "ORDER_ITEM" | "PRODUCT_SUBCATEGORY" | "PRODUCT_TAG" | "PURCHASE_PAYMENT" | "STOCK_TRANSFER_ITEM";

/** One row an action wrote: a row of the record `type`/`id` (its own, or one of its lines), which shows in that record's history. */
export type ActionRow = {
  type: RecordType;
  id: Id;
  /** The record's name when the action ran. */
  name: string;
  entity: RowEntity;
  /** The row's own id, when the world has one: the record's id for its own row, the line's id for a line. */
  rowId: Id | null;
  op: "INSERT" | "UPDATE" | "DELETE";
  /** What a line is (a product, a contact's name); null on the record's own row. */
  rowLabel: string | null;
  fields: { field: string; label: string; oldValue: string | null; newValue: string | null }[];
};

/** One thing somebody (or some system) did, with the rows it wrote. Feeds record history and the activity feed. */
export type Action = {
  id: Id;
  changedAt: string;
  /** A user of the company, or null when a system acted. */
  actorId: Id | null;
  actorName: string;
  source: "WEB" | "PUBLIC_API" | "MCP" | "AUTOMATION" | "METRC" | "QUICKBOOKS" | "MOBILE";
  sourceDetail: string | null;
  records: ActionRow[];
};

export type SentEmail = { document: string; recordId: Id; emailAddresses: string[]; sentAt: string };

export type World = {
  /** The day the run happens, YYYY-MM-DD in the company timezone. */
  today: string;
  timezone: string;
  company: { id: Id; name: string; legalName: string; state: string; complianceSystem: "METRC" };
  /** The signed-in user. */
  me: Id;
  users: User[];
  licenses: License[];
  locations: Location[];
  categories: Category[];
  tags: Named[];
  groups: Named[];
  strains: Strain[];
  unitTypes: UnitType[];
  paymentMethods: Named[];
  paymentTerms: (Named & { days: number })[];
  companyGroups: Named[];
  customFields: CustomField[];
  companies: Company[];
  contacts: Contact[];
  products: Product[];
  batches: Batch[];
  packages: Package[];
  stockTransfers: StockTransfer[];
  salesOrders: SalesOrder[];
  invoices: Invoice[];
  invoicePayments: InvoicePayment[];
  purchaseOrders: PurchaseOrder[];
  purchasePayments: PurchasePayment[];
  tasks: Task[];
  menus: Menu[];
  metrcPackages: MetrcPackage[];
  metrcActivities: MetrcActivity[];
  metrcManifests: MetrcManifest[];
  plantGroups: PlantGroup[];
  plants: Plant[];
  harvests: Harvest[];
  actions: Action[];
  /** Emails the tools have sent. */
  outbox: SentEmail[];
  /** Next number for each id prefix, so new records get fresh ids. */
  nextId: Record<string, number>;
};

// ---------- derived values: one definition, used by the tools and by the graders ----------

export const fullName = (u: { firstName: string; lastName: string | null }) => (u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName);

type StockRow = { locationId: Id; quantity: number };
const at = (rows: StockRow[], locationId?: Id) => rows.filter((r) => !locationId || r.locationId === locationId).reduce((n, r) => n + r.quantity, 0);

/** Stock rows per location: the same location's rows added up, in the order the locations first appear. */
function perLocation(rows: StockRow[]): StockRow[] {
  const out: StockRow[] = [];
  for (const r of rows) {
    const row = out.find((x) => x.locationId === r.locationId);
    if (row) row.quantity += r.quantity;
    else out.push({ locationId: r.locationId, quantity: r.quantity });
  }
  return out;
}

const productOfBatch = (w: World, b: Batch) => w.products.find((p) => p.id === b.productId)!;

/** A batch's stock per location: its own rows for a batch-tracked product, its active packages' for a package-tracked one. */
export function batchStock(w: World, b: Batch): StockRow[] {
  if (productOfBatch(w, b).tracking !== "PACKAGE") return b.stock;
  return perLocation(w.packages.filter((k) => k.batchId === b.id && k.status === "ACTIVE"));
}

/** Units on hand, across locations or at one. A package-tracked product counts its packages, never its batches' rows. */
export function activeQuantity(w: World, p: Product, locationId?: Id): number {
  if (p.tracking === "PRODUCT") return at(p.stock, locationId);
  if (p.tracking === "BATCH") return w.batches.filter((b) => b.productId === p.id).reduce((n, b) => n + at(b.stock, locationId), 0);
  return at(w.packages.filter((k) => k.productId === p.id && k.status === "ACTIVE"), locationId);
}

/** The part of the active quantity held in packages whose lab test passed; null for batch- and product-tracked products. */
export function passedTestingQuantity(w: World, p: Product, locationIds?: Id[]): number | null {
  if (p.tracking !== "PACKAGE") return null;
  return w.packages
    .filter((k) => k.productId === p.id && k.status === "ACTIVE" && k.labTestingState === "TestPassed" && (!locationIds || locationIds.includes(k.locationId)))
    .reduce((n, k) => n + k.quantity, 0);
}

/**
 * Units on purchase orders not yet received, drafts included, for the orders received at `locationIds` or anywhere.
 * The world keeps no partial receipts, so every order that is not COMPLETED counts in full.
 */
export const incomingQuantity = (w: World, p: Product, locationIds?: Id[]) =>
  w.purchaseOrders
    .filter((o) => o.status !== "COMPLETED" && (!locationIds || locationIds.includes(o.locationId)))
    .flatMap((o) => o.items).filter((i) => i.productId === p.id).reduce((n, i) => n + i.quantity, 0);

/** Units that can still be sold: on hand minus what open orders hold. */
export const availableQuantity = (w: World, p: Product) => activeQuantity(w, p) - p.reserved;

export const belowMinimum = (w: World, p: Product) => p.thresholdMin !== null && availableQuantity(w, p) < p.thresholdMin;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const orderTotal = (o: SalesOrder) => round2(o.items.reduce((n, i) => n + i.quantity * i.unitPrice, 0));
export const orderCost = (o: SalesOrder) => round2(o.items.reduce((n, i) => n + i.quantity * i.unitCost, 0));
export const purchaseTotal = (p: PurchaseOrder) => round2(p.items.reduce((n, i) => n + i.quantity * i.unitCost, 0));

export type PaymentStatus = "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVER_PAID";
const statusOf = (total: number, paid: number): PaymentStatus => (paid <= 0 ? "NOT_PAID" : paid < total - 0.005 ? "PARTIALLY_PAID" : paid > total + 0.005 ? "OVER_PAID" : "PAID");

/** The sum of the payments that are not voided. */
const posted = (payments: Payment[]) => round2(payments.filter((p) => p.voidedAt === null).reduce((n, p) => n + p.amount, 0));

export type Money = { total: number; paid: number; remaining: number; status: PaymentStatus };

export function invoiceMoney(w: World, inv: Invoice): Money {
  const order = w.salesOrders.find((o) => o.id === inv.salesOrderId)!;
  const total = orderTotal(order);
  const paid = posted(w.invoicePayments.filter((p) => p.invoiceId === inv.id));
  // A voided invoice owes nothing.
  const remaining = inv.voided ? 0 : round2(Math.max(0, total - paid));
  return { total, paid, remaining, status: statusOf(total, paid) };
}

/** What an order has been paid: its invoice's payments, or nothing before it is invoiced. */
export function orderMoney(w: World, o: SalesOrder): Money {
  const inv = w.invoices.find((i) => i.salesOrderId === o.id);
  if (inv) return invoiceMoney(w, inv);
  const total = orderTotal(o);
  return { total, paid: 0, remaining: o.status === "CANCELED" ? 0 : total, status: "NOT_PAID" };
}

export function purchaseMoney(w: World, po: PurchaseOrder): Money {
  const total = purchaseTotal(po);
  const paid = posted(w.purchasePayments.filter((p) => p.purchaseId === po.id));
  return { total, paid, remaining: round2(Math.max(0, total - paid)), status: statusOf(total, paid) };
}

/** A payment's last change: when it was voided, else when it was recorded. Payments are not edited otherwise. */
export const paymentUpdatedAt = (p: Payment) => p.voidedAt ?? p.recordedAt;

/** A plant group is active while it has immature plants, as the documentation defines it. */
export const plantGroupActive = (w: World, g: PlantGroup) => w.plants.some((p) => p.plantGroupId === g.id && p.status === "IMMATURE");

/**
 * When a record or a line last changed: the latest of its own instants and of the actions that wrote a row of it.
 * A record is named by its type (a SALES_ORDER and its lines), a line by its entity and row id (a CONTACT).
 */
export function lastChanged(w: World, type: RowEntity, id: Id, ...instants: (string | null)[]): string {
  const logged = w.actions.filter((a) => a.records.some((r) => (r.type === type && r.id === id) || (r.entity === type && r.rowId === id))).map((a) => a.changedAt);
  return [...instants, ...logged].filter((x): x is string => x !== null).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** A fresh id for a new record, e.g. `con_31`. */
export function newId(w: World, prefix: string): Id {
  const n = (w.nextId[prefix] ??= 1);
  w.nextId[prefix] = n + 1;
  return `${prefix}_${n}`;
}

/** The id prefix of each kind of record. Only `com_` and `inv_` appear in the vendor's documentation; the rest follow the same pattern. */
export const PREFIX = {
  user: "usr", license: "lic", location: "loc", category: "cat", subcategory: "sub", tag: "tag", group: "grp", strain: "str", unitType: "unt",
  paymentMethod: "pmm", paymentTerm: "ptm", companyGroup: "cgr", customField: "cf", company: "com", contact: "con", product: "prd", batch: "bat",
  package: "pkg", stockTransfer: "stt", salesOrder: "so", orderItem: "soi", invoice: "inv", invoicePayment: "ipy", purchaseOrder: "po",
  purchaseItem: "poi", purchasePayment: "ppy", task: "tsk", menu: "men", metrcActivity: "mta", plantGroup: "plg", plant: "plt", harvest: "hrv", action: "act",
} as const;
