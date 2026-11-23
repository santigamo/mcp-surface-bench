// The benchmark company: every record the tools read and write. Plain JSON data, so a world can be saved
// after a run and compared with the world it started from.

export type Id = string;
export type Named = { id: Id; name: string };

export type User = { id: Id; firstName: string; lastName: string; email: string; role: string };
export type License = { id: Id; licenseNumber: string; name: string; kind: "DISTRIBUTION" | "CULTIVATION"; complianceType: "METRC"; active: boolean };
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
  transferDatetime: string;
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

export type Payment = { id: Id; amount: number; paymentDatetime: string; paymentMethodId: Id; note: string | null; voided: boolean };
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
  type: "ADJUST_PACKAGE" | "MOVE_PACKAGE" | "CREATE_PACKAGE" | "FINISH_PACKAGE";
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

export type PlantGroup = { id: Id; name: string; strainName: string; licenseId: Id; locationId: Id; active: boolean; plantedAt: string };
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

/** One thing somebody (or some system) did, with the records it touched. Feeds record history and the activity feed. */
export type Action = {
  id: Id;
  changedAt: string;
  /** A user of the company, or null when a system acted. */
  actorId: Id | null;
  actorName: string;
  source: "WEB" | "PUBLIC_API" | "MCP" | "AUTOMATION" | "METRC" | "QUICKBOOKS" | "MOBILE";
  sourceDetail: string | null;
  records: {
    /** `SALES_ORDER`, `PRODUCT`, `COMPANY`, ... */
    type: string;
    id: Id;
    name: string;
    op: "INSERT" | "UPDATE" | "DELETE";
    /** For an order item or other child row: what the row is. */
    rowLabel: string | null;
    fields: { field: string; label: string; oldValue: string | null; newValue: string | null }[];
  }[];
};

export type SentEmail = { document: string; recordId: Id; emailAddresses: string[]; sentAt: string };

export type World = {
  /** The day the run happens, YYYY-MM-DD in the company timezone. */
  today: string;
  timezone: string;
  company: { id: Id; name: string; state: string; complianceSystem: "METRC" };
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

/** Units on hand, across locations. */
export function activeQuantity(w: World, p: Product, locationId?: Id): number {
  const at = (rows: { locationId: Id; quantity: number }[]) => rows.filter((r) => !locationId || r.locationId === locationId).reduce((n, r) => n + r.quantity, 0);
  if (p.tracking === "PRODUCT") return at(p.stock);
  if (p.tracking === "BATCH") return w.batches.filter((b) => b.productId === p.id).reduce((n, b) => n + at(b.stock), 0);
  return at(w.packages.filter((k) => k.productId === p.id && k.status === "ACTIVE"));
}

/** Units that can still be sold: on hand minus what open orders hold. */
export const availableQuantity = (w: World, p: Product) => activeQuantity(w, p) - p.reserved;

export const belowMinimum = (w: World, p: Product) => p.thresholdMin !== null && availableQuantity(w, p) < p.thresholdMin;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const orderTotal = (o: SalesOrder) => round2(o.items.reduce((n, i) => n + i.quantity * i.unitPrice, 0));
export const orderCost = (o: SalesOrder) => round2(o.items.reduce((n, i) => n + i.quantity * i.unitCost, 0));
export const purchaseTotal = (p: PurchaseOrder) => round2(p.items.reduce((n, i) => n + i.quantity * i.unitCost, 0));

export type PaymentStatus = "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVER_PAID";
const statusOf = (total: number, paid: number): PaymentStatus => (paid <= 0 ? "NOT_PAID" : paid < total - 0.005 ? "PARTIALLY_PAID" : paid > total + 0.005 ? "OVER_PAID" : "PAID");

export function invoiceMoney(w: World, inv: Invoice) {
  const order = w.salesOrders.find((o) => o.id === inv.salesOrderId)!;
  const total = orderTotal(order);
  const paid = round2(w.invoicePayments.filter((p) => p.invoiceId === inv.id && !p.voided).reduce((n, p) => n + p.amount, 0));
  // A voided invoice owes nothing.
  const remaining = inv.voided ? 0 : round2(Math.max(0, total - paid));
  return { total, paid, remaining, status: statusOf(total, paid) };
}

export function purchaseMoney(w: World, po: PurchaseOrder) {
  const total = purchaseTotal(po);
  const paid = round2(w.purchasePayments.filter((p) => p.purchaseId === po.id && !p.voided).reduce((n, p) => n + p.amount, 0));
  return { total, paid, remaining: round2(Math.max(0, total - paid)), status: statusOf(total, paid) };
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
