// The catalog: products, the named lists records point at (categories, tags, groups...), custom fields and price tiers.
import { instant, matches, money, normalizeId, normalizeIds, page, qty, sorted, type SortBy } from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import {
  activeQuantity, availableQuantity, belowMinimum, newId, PREFIX,
  type Action, type Category, type CustomField, type Id, type Named, type Product, type UnitType, type World,
} from "../world.ts";
import { find, named, recordAction, stamp, type C } from "./shared.ts";

type Change = Action["records"][number]["fields"][number];

/** Records without timestamps were numbered as they were created, so the number orders them by age. */
const seq = (x: { id: Id }) => Number(x.id.split("_")[1]);
const NAME_OR_AGE = { NAME: (x: Named) => x.name, INSERTED_AT: seq, UPDATED_AT: seq };
const RECENT: SortBy = { field: "UPDATED_AT", direction: "DESC" };
const A_TO_Z: SortBy = { field: "NAME", direction: "ASC" };

/** Finds a record by an id as the model sent it, or raises the error a wrong id gets. */
const refId = (items: { id: Id }[], value: string, prefix: string, what: string) => find(items, normalizeId(value, prefix), what).id;
const optRefId = (items: { id: Id }[], value: string | null, prefix: string, what: string) => (value === null ? null : refId(items, value, prefix, what));

const subcategoriesOf = (w: World) => w.categories.flatMap((c) => c.subcategories);

// ---------- products: what they hold beyond the stored record ----------

/** Units on purchase orders not yet received, drafts included. The world keeps no partial receipts, so an open order counts in full. */
const incomingQuantity = (w: World, p: Product) =>
  w.purchaseOrders.filter((o) => o.status !== "COMPLETED").flatMap((o) => o.items).filter((i) => i.productId === p.id).reduce((n, i) => n + i.quantity, 0);

/** The part of the active quantity in packages whose lab test passed; batch- and product-tracked products have none. */
const passedTesting = (w: World, p: Product) =>
  p.tracking === "PACKAGE"
    ? qty(w.packages.filter((k) => k.productId === p.id && k.status === "ACTIVE" && k.labTestingState === "TestPassed").reduce((n, k) => n + k.quantity, 0))
    : null;

/** The locations holding some of the product's active quantity. */
const quantitiesByLocation = (w: World, p: Product) =>
  w.locations
    .map((l) => ({ location: { id: l.id, name: l.name }, units: activeQuantity(w, p, l.id) }))
    .filter((r) => r.units !== 0)
    .map(({ location, units }) => ({ location, quantity: qty(units) }));

const menusOf = (w: World, p: Product) => w.menus.filter((m) => m.products.some((x) => x.productId === p.id)).map((m) => ({ id: m.id, name: m.name }));

const tagsOf = (w: World, p: Product) => p.tagIds.map((id) => named(w.tags, id)!);

/** Every custom field defined on products, each blank: the world stores no custom field values. */
const productCustomFields = (w: World) =>
  w.customFields.filter((f) => f.entityType === "PRODUCT").map((f) => ({ customField: { id: f.id, name: f.name, fieldType: f.fieldType }, value: null }));

const quantityOrNull = (n: number | null) => (n === null ? null : qty(n));

// ---------- products: renderers ----------

/** The fields search-products, get-product and mutate-product all print. */
function productCore(w: World, p: Product) {
  return {
    id: p.id,
    customFields: productCustomFields(w),
    name: p.name,
    sku: p.sku,
    upc: null,
    isInactive: !p.active,
    inventoryTrackingMethod: p.tracking,
    unitPrice: money(p.unitPrice),
    wholesaleUnitPrice: null,
    unitCost: money(p.unitCost),
    // Every unit in this world carries the product's default cost.
    activeQuantityCost: money(activeQuantity(w, p) * p.unitCost),
    unitsPerCase: null,
    quantityActive: qty(activeQuantity(w, p)),
    quantityActivePassedTesting: passedTesting(w, p),
    quantityAvailable: qty(availableQuantity(w, p)),
    quantityIncoming: qty(incomingQuantity(w, p)),
    quantityPendingOutput: "0",
    quantityReserved: qty(p.reserved),
    quantityAvailableThresholdMin: quantityOrNull(p.thresholdMin),
    quantityAvailableThresholdMax: quantityOrNull(p.thresholdMax),
    unitNetWeight: null,
    unitNetWeightAndServingSizeUnitType: null,
    totalThc: quantityOrNull(p.thcPercent),
    totalCbd: null,
    totalCannabinoidUnit: p.thcPercent === null ? null : "PERCENT",
    insertedAt: p.createdAt,
    updatedAt: p.updatedAt,
    category: named(w.categories, p.categoryId),
    subcategory: named(subcategoriesOf(w), p.subcategoryId),
    group: named(w.groups, p.groupId),
    unitType: named(w.unitTypes, p.unitTypeId)!,
    strain: named(w.strains, p.strainId),
    brand: named(w.companies, p.brandId),
    vendor: named(w.companies, p.vendorId),
    quickbooksSalesItem: null,
    quickbooksPurchaseItem: null,
  };
}

/** A row of search-products. The world has no assemblies or bills of materials. */
const productRow = (w: World, p: Product) => ({
  ...productCore(w, p),
  quantityAssembling: "0",
  quantityPossible: null,
  activeQuantitiesByLocation: quantitiesByLocation(w, p),
  tags: tagsOf(w, p),
});

type ProductIncludes = {
  includeImages?: boolean;
  includeTags?: boolean;
  includeActiveQuantitiesByLocation?: boolean;
  includeActiveQuantityCostItems?: boolean;
  includeBillOfMaterials?: boolean;
};

/** A product as get-product prints it, and mutate-product with the tags. */
function productDetail(w: World, p: Product, inc: ProductIncludes) {
  const menus = menusOf(w, p);
  return {
    ...productCore(w, p),
    externalName: null,
    description: null,
    descriptionMarkdown: null,
    isFeatured: false,
    maxMenuBuyerOrderQuantity: null,
    msrp: null,
    unitServingSize: null,
    grossWeight: null,
    grossWeightUnitType: null,
    menuVisibility: menus.length ? "INCLUDE_IN_SELECT" : "DO_NOT_INCLUDE",
    menus,
    // No product in this world has an image.
    thumbnailImageUrl: "",
    url: `https://app.distru.com/products/${p.id}`,
    owner: null,
    ...(inc.includeImages ? { images: [] } : {}),
    ...(inc.includeTags ? { tags: tagsOf(w, p) } : {}),
    ...(inc.includeActiveQuantitiesByLocation ? { activeQuantitiesByLocation: quantitiesByLocation(w, p) } : {}),
    // No cost entries or bills of materials are recorded in this world.
    ...(inc.includeActiveQuantityCostItems ? { activeQuantityCostItems: null } : {}),
    ...(inc.includeBillOfMaterials ? { billOfMaterials: null } : {}),
  };
}

// ---------- products: search ----------

type ProductSearch = {
  limit?: number;
  cursor?: string;
  ids?: string[];
  search?: string;
  status?: "ACTIVE" | "ANY" | "INACTIVE";
  belowQuantityAvailableThresholdMin?: boolean;
  brandIds?: string[];
  menuIds?: string[];
  notOnMenuIds?: string[];
  productCategoryIds?: string[];
  productGroupIds?: string[];
  productSubcategoryIds?: string[];
  strainIds?: string[];
  tagIds?: string[];
  unitTypeCategories?: UnitType["category"][];
  vendorId?: string;
  sortBy?: SortBy;
};

/** True when no set is given, or when any of the values is in it. */
const anyIn = (set: Set<Id> | undefined, ...values: (Id | null)[]) => !set || values.some((v) => v !== null && set.has(v));

/** The test a product must pass to be listed by a search-products call. */
function productFilter(w: World, a: ProductSearch): (p: Product) => boolean {
  const set = (values: string[] | undefined, prefix: string) => values && new Set(normalizeIds(values, prefix));
  const onMenus = (values: string[] | undefined) => {
    const menus = set(values, PREFIX.menu);
    return menus && new Set(w.menus.filter((m) => menus.has(m.id)).flatMap((m) => m.products.map((x) => x.productId)));
  };
  const ids = set(a.ids, PREFIX.product), categories = set(a.productCategoryIds, PREFIX.category), subcategories = set(a.productSubcategoryIds, PREFIX.subcategory);
  const groups = set(a.productGroupIds, PREFIX.group), strains = set(a.strainIds, PREFIX.strain), tags = set(a.tagIds, PREFIX.tag), brands = set(a.brandIds, PREFIX.company);
  const vendors = set(a.vendorId === undefined ? undefined : [a.vendorId], PREFIX.company);
  const onMenu = onMenus(a.menuIds), offMenu = onMenus(a.notOnMenuIds);
  const status = a.status ?? "ACTIVE";
  const unitCategory = (p: Product) => w.unitTypes.find((u) => u.id === p.unitTypeId)!.category;
  return (p) =>
    (status === "ANY" || p.active === (status === "ACTIVE")) &&
    matches(a.search, p.name, p.sku) &&
    anyIn(ids, p.id) && anyIn(categories, p.categoryId) && anyIn(subcategories, p.subcategoryId) && anyIn(groups, p.groupId) &&
    anyIn(strains, p.strainId) && anyIn(tags, ...p.tagIds) && anyIn(brands, p.brandId) && anyIn(vendors, p.vendorId) &&
    anyIn(onMenu, p.id) && !offMenu?.has(p.id) &&
    (!a.unitTypeCategories || a.unitTypeCategories.includes(unitCategory(p))) &&
    (a.belowQuantityAvailableThresholdMin === undefined || belowMinimum(w, p) === a.belowQuantityAvailableThresholdMin);
}

const productSorts = (w: World) => ({
  INSERTED_AT: (p: Product) => Date.parse(p.createdAt),
  NAME: (p: Product) => p.name,
  QUANTITY_ACTIVE: (p: Product) => activeQuantity(w, p),
  QUANTITY_AVAILABLE: (p: Product) => availableQuantity(w, p),
  QUANTITY_AVAILABLE_THRESHOLD_MIN_RATIO: (p: Product) => availableQuantity(w, p) / p.thresholdMin!,
  UNIT_PRICE: (p: Product) => p.unitPrice,
  UPDATED_AT: (p: Product) => Date.parse(p.updatedAt),
});

function sortProducts(w: World, products: Product[], sortBy: SortBy | undefined): Product[] {
  const fields = productSorts(w);
  if (sortBy?.field !== "QUANTITY_AVAILABLE_THRESHOLD_MIN_RATIO") return sorted(products, sortBy, fields, RECENT);
  // A product whose minimum is unset or 0 has no ratio and goes last in either direction.
  const rated = products.filter((p) => p.thresholdMin), unrated = products.filter((p) => !p.thresholdMin);
  return [...sorted(rated, sortBy, fields, RECENT), ...sorted(unrated, RECENT, fields, RECENT)];
}

// ---------- products: writes ----------

/** The product fields the catalog write tools change, as the world stores them. */
type Editable = "name" | "sku" | "active" | "categoryId" | "subcategoryId" | "vendorId" | "brandId" | "strainId" | "groupId" | "unitPrice" | "unitCost" | "thresholdMin" | "thresholdMax" | "tagIds";
type Patch = Partial<Pick<Product, Editable>>;

/** The inputs mutate-product and bulk-update-products share, plus the tag edits only the bulk tool has. */
type ProductEdit = {
  name?: string;
  sku?: string;
  isInactive?: boolean;
  categoryId?: string;
  subcategoryId?: string | null;
  vendorId?: string;
  brandId?: string | null;
  strainId?: string | null;
  groupId?: string | null;
  unitPrice?: string | number;
  unitCost?: string | number | null;
  quantityAvailableThresholdMin?: string | number | null;
  quantityAvailableThresholdMax?: string | number | null;
  tagIds?: string[];
  addTagIds?: string[];
  removeTagIds?: string[];
};

const nameOf = (items: (w: World) => Named[]) => (w: World, id: Id | null) => named(items(w), id)?.name ?? null;

/** How each patched field is logged in record history: the input it came from, its label and how its value prints. */
const LOGGED: { [K in Editable]: { field: string; label: string; show: (w: World, v: Product[K]) => string | null } } = {
  name: { field: "name", label: "Name", show: (_, v) => v },
  sku: { field: "sku", label: "SKU", show: (_, v) => v },
  active: { field: "isInactive", label: "Inactive", show: (_, v) => String(!v) },
  categoryId: { field: "categoryId", label: "Category", show: nameOf((w) => w.categories) },
  subcategoryId: { field: "subcategoryId", label: "Subcategory", show: nameOf(subcategoriesOf) },
  vendorId: { field: "vendorId", label: "Vendor", show: nameOf((w) => w.companies) },
  brandId: { field: "brandId", label: "Brand", show: nameOf((w) => w.companies) },
  strainId: { field: "strainId", label: "Strain", show: nameOf((w) => w.strains) },
  groupId: { field: "groupId", label: "Group", show: nameOf((w) => w.groups) },
  unitPrice: { field: "unitPrice", label: "Unit price", show: (_, v) => money(v) },
  unitCost: { field: "unitCost", label: "Unit cost", show: (_, v) => money(v) },
  thresholdMin: { field: "quantityAvailableThresholdMin", label: "Low-stock alert", show: (_, v) => quantityOrNull(v) },
  thresholdMax: { field: "quantityAvailableThresholdMax", label: "High-stock alert", show: (_, v) => quantityOrNull(v) },
  tagIds: { field: "tagIds", label: "Tags", show: (w, v) => v.map((id) => named(w.tags, id)!.name).join(", ") },
};

function amount(value: string | number, field: string): number {
  const n = typeof value === "number" ? value : value.trim() === "" ? NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ToolError(`${field} must be a number of at least 0, e.g. "12.50"; got ${JSON.stringify(value)}.`);
  return n;
}
const optAmount = (value: string | number | null, field: string) => (value === null ? null : amount(value, field));

function text(value: string, field: string): string {
  const t = value.trim();
  if (!t) throw new ToolError(`${field} cannot be blank.`);
  return t;
}

function productName(value: string): string {
  const name = text(value, "name");
  if (/[:[\]]/.test(name)) throw new ToolError(`A product name cannot contain ":", "[" or "]": "${name}".`);
  return name;
}

/** The tag list a write leaves on a product: replaced by tagIds, or edited by addTagIds and removeTagIds. */
function readRetag(w: World, a: ProductEdit): ((current: Id[]) => Id[]) | undefined {
  const resolve = (values: string[] | undefined) => values?.map((v) => refId(w.tags, v, PREFIX.tag, "product tag"));
  const replace = resolve(a.tagIds), add = resolve(a.addTagIds), remove = resolve(a.removeTagIds);
  if (replace && (add || remove)) throw new ToolError("Send either tagIds, which replaces every tag, or addTagIds and removeTagIds, which keep the others; not both.");
  if (replace) return () => [...new Set(replace)];
  if (!add && !remove) return undefined;
  const both = add?.filter((t) => remove?.includes(t));
  if (both?.length) throw new ToolError(`${both.join(", ")} is in both addTagIds and removeTagIds.`);
  return (current) => [...new Set([...current, ...(add ?? [])])].filter((t) => !remove?.includes(t));
}

/** Reads and checks what a write asks for. Returns the patch each product gets, since tag edits keep each product's other tags. */
function readEdit(w: World, a: ProductEdit): (p: Product) => Patch {
  const patch: Patch = {};
  if (a.name !== undefined) patch.name = productName(a.name);
  if (a.sku !== undefined) patch.sku = text(a.sku, "sku");
  if (a.isInactive !== undefined) patch.active = !a.isInactive;
  if (a.categoryId !== undefined) patch.categoryId = refId(w.categories, a.categoryId, PREFIX.category, "product category");
  if (a.subcategoryId !== undefined) patch.subcategoryId = optRefId(subcategoriesOf(w), a.subcategoryId, PREFIX.subcategory, "product subcategory");
  if (a.vendorId !== undefined) patch.vendorId = refId(w.companies, a.vendorId, PREFIX.company, "company");
  if (a.brandId !== undefined) patch.brandId = optRefId(w.companies, a.brandId, PREFIX.company, "company");
  if (a.strainId !== undefined) patch.strainId = optRefId(w.strains, a.strainId, PREFIX.strain, "strain");
  if (a.groupId !== undefined) patch.groupId = optRefId(w.groups, a.groupId, PREFIX.group, "product group");
  if (a.unitPrice !== undefined) patch.unitPrice = amount(a.unitPrice, "unitPrice");
  if (a.unitCost === null) throw new ToolError("This benchmark world keeps a unit cost on every product: send the new cost instead of null.");
  if (a.unitCost !== undefined) patch.unitCost = amount(a.unitCost, "unitCost");
  if (a.quantityAvailableThresholdMin !== undefined) patch.thresholdMin = optAmount(a.quantityAvailableThresholdMin, "quantityAvailableThresholdMin");
  if (a.quantityAvailableThresholdMax !== undefined) patch.thresholdMax = optAmount(a.quantityAvailableThresholdMax, "quantityAvailableThresholdMax");
  const retag = readRetag(w, a);
  return (p) => (retag ? { ...patch, tagIds: retag(p.tagIds) } : patch);
}

/** What stops a patch from being saved on a product, or null. */
function problemWith(w: World, p: Product, patch: Patch): string | null {
  const next = { ...p, ...patch };
  const category = w.categories.find((c) => c.id === next.categoryId)!;
  if (next.subcategoryId !== null && !category.subcategories.some((s) => s.id === next.subcategoryId)) {
    return `its subcategory ${named(subcategoriesOf(w), next.subcategoryId)!.name} does not belong to category ${category.name}; send a subcategoryId of that category, or null`;
  }
  if (next.thresholdMin !== null && next.thresholdMax !== null && next.thresholdMin >= next.thresholdMax) {
    return `the low-stock alert (${qty(next.thresholdMin)}) must be below the high-stock alert (${qty(next.thresholdMax)})`;
  }
  const taken = (key: "name" | "sku") => patch[key] !== undefined && w.products.some((o) => o.id !== p.id && o[key].toLowerCase() === patch[key]!.toLowerCase());
  if (taken("name")) return `another product is already named "${patch.name}"`;
  if (taken("sku")) return `another product already has SKU "${patch.sku}"`;
  return null;
}

function logged<K extends Editable>(w: World, p: Product, patch: Patch, key: K): Change | null {
  const before = p[key], after = patch[key] as Product[K];
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  const { field, label, show } = LOGGED[key];
  return { field, label, oldValue: show(w, before), newValue: show(w, after) };
}

/** Saves a checked patch on a product. Returns its history record, or null when the patch changes nothing. */
function save(c: C, p: Product, patch: Patch): Action["records"][number] | null {
  const fields = (Object.keys(patch) as Editable[]).map((k) => logged(c.world, p, patch, k)).filter((f) => f !== null);
  if (!fields.length) return null;
  Object.assign(p, patch, { updatedAt: stamp(c) });
  return { type: "PRODUCT", id: p.id, name: p.name, op: "UPDATE", rowLabel: null, fields };
}

// ---------- lookups ----------

type LookupType =
  | "COMPANY_GROUP" | "RELATIONSHIP_TYPE" | "PRODUCT_TAG" | "PRODUCT_GROUP" | "PRODUCT_CATEGORY" | "UNIT_TYPE" | "COST_TYPE"
  | "PAYMENT_METHOD" | "PAYMENT_TERM" | "TAX" | "CHARGE_PRESET" | "LICENSE_TYPE" | "COMPANY_CATEGORY" | "STRAIN";

/** One lookup value: what it prints beyond id and name, and what the filters read. */
type LookupRow = Named & { fields?: Record<string, unknown>; alsoNamed?: string[]; active?: boolean; unitCategory?: UnitType["category"] };

const plain = (x: Named): Named => ({ id: x.id, name: x.name });

/** The lookup types this world has values for, with the id prefix of each. The others list nothing. */
const LOOKUPS: { [T in LookupType]?: { prefix: string; rows: (w: World) => LookupRow[] } } = {
  COMPANY_GROUP: { prefix: PREFIX.companyGroup, rows: (w) => w.companyGroups.map(plain) },
  PRODUCT_TAG: { prefix: PREFIX.tag, rows: (w) => w.tags.map(plain) },
  PRODUCT_GROUP: { prefix: PREFIX.group, rows: (w) => w.groups.map(plain) },
  PRODUCT_CATEGORY: {
    prefix: PREFIX.category,
    rows: (w) => w.categories.map((c) => ({ ...plain(c), alsoNamed: c.subcategories.map((s) => s.name), fields: { subcategories: c.subcategories.map(plain) } })),
  },
  // The world's unit types are the standard ones: in use, and locked against edits.
  UNIT_TYPE: { prefix: PREFIX.unitType, rows: (w) => w.unitTypes.map((u) => ({ ...plain(u), active: true, unitCategory: u.category, fields: { category: u.category, active: true, locked: true } })) },
  PAYMENT_METHOD: { prefix: PREFIX.paymentMethod, rows: (w) => w.paymentMethods.map(plain) },
  PAYMENT_TERM: { prefix: PREFIX.paymentTerm, rows: (w) => w.paymentTerms.map((t) => ({ ...plain(t), fields: { days: t.days } })) },
  STRAIN: { prefix: PREFIX.strain, rows: (w) => w.strains.map((s) => ({ ...plain(s), fields: { strainType: s.strainType } })) },
};

/** The lookup inputs that apply to some types only. */
const APPLIES_TO: Record<string, (t: LookupType) => boolean> = {
  chargeTypes: (t) => t === "CHARGE_PRESET",
  ids: (t) => !["PAYMENT_METHOD", "LICENSE_TYPE", "COMPANY_CATEGORY"].includes(t),
  search: (t) => t !== "TAX",
  status: (t) => t === "COST_TYPE" || t === "UNIT_TYPE",
  unitTypeCategories: (t) => t === "UNIT_TYPE",
  sortBy: (t) => t !== "LICENSE_TYPE" && t !== "COMPANY_CATEGORY",
};

const NAMED_A_TO_Z: LookupType[] = ["PRODUCT_CATEGORY", "LICENSE_TYPE", "COMPANY_CATEGORY"];
const SORTED_WHILE_SEARCHING: LookupType[] = ["PAYMENT_METHOD", "CHARGE_PRESET", "STRAIN"];

type LookupSearch = {
  type: LookupType;
  limit?: number;
  cursor?: string;
  chargeTypes?: ("CHARGE" | "DISCOUNT")[];
  ids?: string[];
  search?: string;
  status?: "ACTIVE" | "ANY" | "INACTIVE";
  unitTypeCategories?: UnitType["category"][];
  sortBy?: SortBy;
};

function lookupRows(w: World, a: LookupSearch): LookupRow[] {
  const source = LOOKUPS[a.type];
  if (!source) return [];
  const ids = normalizeIds(a.ids, source.prefix);
  const status = a.status ?? "ACTIVE";
  const rows = source.rows(w).filter((r) =>
    (!ids || ids.includes(r.id)) &&
    matches(a.search, r.name, ...(r.alsoNamed ?? [])) &&
    (r.active === undefined || status === "ANY" || r.active === (status === "ACTIVE")) &&
    (!a.unitTypeCategories || (r.unitCategory !== undefined && a.unitTypeCategories.includes(r.unitCategory))));
  const fallback = NAMED_A_TO_Z.includes(a.type) ? A_TO_Z : RECENT;
  const sortBy = a.search && !SORTED_WHILE_SEARCHING.includes(a.type) ? undefined : a.sortBy;
  return sorted(rows, sortBy, NAME_OR_AGE, fallback);
}

type ReferenceType = "PRODUCT_SUBCATEGORY" | "COMPANY_GROUP" | "RELATIONSHIP_TYPE" | "PRODUCT_TAG" | "PRODUCT_GROUP" | "PRODUCT_CATEGORY" | "PAYMENT_METHOD";
type NewReference = {
  type: ReferenceType;
  name: string;
  paymentMethodType?: "BANK_REMITTANCE" | "BANK_TRANSFER" | "CASH" | "CHECK" | "CREDIT_CARD";
  officialProductCategoryId?: string;
  productCategoryId?: string;
};

/** The extra input each type requires and no other type takes. */
const EXTRA_INPUT: [ReferenceType, "paymentMethodType" | "officialProductCategoryId" | "productCategoryId"][] = [
  ["PAYMENT_METHOD", "paymentMethodType"], ["PRODUCT_CATEGORY", "officialProductCategoryId"], ["PRODUCT_SUBCATEGORY", "productCategoryId"],
];

const OFFICIAL_CATEGORIES: Category["official"][] = ["FLOWER", "PREROLLS", "EDIBLES", "VAPES", "CONCENTRATES"];

function checkReference(a: NewReference): string {
  for (const [type, input] of EXTRA_INPUT) {
    if (a.type === type && a[input] === undefined) throw new ToolError(`${input} is required for type ${type}.`);
    if (a.type !== type && a[input] !== undefined) throw new ToolError(`${input} is only taken by type ${type}, not ${a.type}.`);
  }
  const name = text(a.name, "name"), max = a.type === "PAYMENT_METHOD" ? 31 : 255;
  if (name.length > max) throw new ToolError(`name must be at most ${max} characters for type ${a.type}.`);
  return name;
}

/** Adds a value to a named list after checking its name is free, and logs it. */
function insert<T extends Named>(c: C, type: ReferenceType, list: T[], prefix: string, fields: Omit<T, "id">): T {
  // Only RELATIONSHIP_TYPE and COMPANY_GROUP tell "flower" from "Flower".
  const key = (s: string) => (type === "COMPANY_GROUP" ? s : s.toLowerCase());
  const clash = list.find((x) => key(x.name) === key(fields.name));
  if (clash) throw new ToolError(`A ${type.toLowerCase().replace("_", " ")} named "${clash.name}" already exists (${clash.id}): use it instead.`);
  const item = { id: newId(c.world, prefix), ...fields } as T;
  list.push(item);
  recordAction(c, [{ type, id: item.id, name: item.name, op: "INSERT", rowLabel: null, fields: [] }]);
  return item;
}

function createReference(c: C, a: NewReference, name: string) {
  const w = c.world;
  switch (a.type) {
    case "PRODUCT_TAG": return { tag: plain(insert(c, a.type, w.tags, PREFIX.tag, { name })) };
    case "PRODUCT_GROUP": return { productGroup: plain(insert(c, a.type, w.groups, PREFIX.group, { name })) };
    case "COMPANY_GROUP": return { companyGroup: plain(insert(c, a.type, w.companyGroups, PREFIX.companyGroup, { name })) };
    case "PAYMENT_METHOD":
      // The world keeps a payment method's name only; its type is echoed back, not stored.
      return { paymentMethod: { ...plain(insert(c, a.type, w.paymentMethods, PREFIX.paymentMethod, { name })), type: a.paymentMethodType! } };
    case "PRODUCT_CATEGORY": {
      const official = a.officialProductCategoryId as Category["official"];
      if (!OFFICIAL_CATEGORIES.includes(official)) throw new ToolError(`This benchmark world's categories use only these official categories: ${OFFICIAL_CATEGORIES.join(", ")}.`);
      const category = insert(c, a.type, w.categories, PREFIX.category, { name, official, subcategories: [] });
      return { productCategory: { ...plain(category), officialProductCategoryId: official } };
    }
    case "PRODUCT_SUBCATEGORY": {
      const category = find(w.categories, normalizeId(a.productCategoryId!, PREFIX.category), "product category");
      const sub = insert(c, a.type, category.subcategories, PREFIX.subcategory, { name });
      return { productSubcategory: { ...plain(sub), category: { id: category.id } } };
    }
    case "RELATIONSHIP_TYPE":
      throw new ToolError("This benchmark world has no relationship types to add to.");
  }
}

// ---------- custom fields ----------

const customFieldOut = (f: CustomField) => ({
  id: f.id,
  name: f.name,
  description: f.description,
  entityType: f.entityType,
  fieldType: f.fieldType,
  required: f.required,
  // The world does not model the public API's filter flag; no field is set up for it.
  filterable: false,
  options: f.options.map((name) => ({ name, disabled: false })),
});

function readOptions(fieldType: CustomField["fieldType"], options: string[] | undefined): string[] {
  if (fieldType !== "DROPDOWN" && fieldType !== "CHECKBOX") {
    if (options?.length) throw new ToolError(`options are only for DROPDOWN and CHECKBOX fields, not ${fieldType}.`);
    return [];
  }
  if (!options?.length) throw new ToolError(`A ${fieldType} field needs its choices in options.`);
  const names = options.map((o) => text(o, "An option"));
  const comma = names.find((o) => o.includes(","));
  if (comma) throw new ToolError(`Options cannot contain commas: "${comma}".`);
  const twice = names.find((o, i) => names.indexOf(o) !== i);
  if (twice) throw new ToolError(`"${twice}" is listed twice in options; each option must be unique.`);
  return names;
}

// ---------- price tiers ----------

/** The id prefix of each price-tier filter, so a wrong id is refused even though the company has no tiers. */
const TIER_FILTERS = {
  customerIds: PREFIX.company, customerGroupIds: PREFIX.companyGroup, productIds: PREFIX.product, productTagIds: PREFIX.tag,
  productCategoryIds: PREFIX.category, productSubcategoryIds: PREFIX.subcategory, productGroupIds: PREFIX.group,
  brandIds: PREFIX.company, menuIds: PREFIX.menu, ownerIds: PREFIX.user,
} as const;

type TierSearch = { limit?: number; cursor?: string; validAt?: string } & { [K in keyof typeof TIER_FILTERS]?: string[] };

// ---------- the tools ----------

export const tools = [
  defineTool<World>({
    name: "search-products",
    supports: [
      "limit", "cursor", "belowQuantityAvailableThresholdMin", "brandIds", "ids", "menuIds", "notOnMenuIds", "productCategoryIds", "productGroupIds",
      "productSubcategoryIds", "search", "status", "strainIds", "tagIds", "unitTypeCategories", "vendorId", "sortBy",
    ],
    run(a: ProductSearch, { world: w }) {
      const found = w.products.filter(productFilter(w, a));
      // With `search` the documentation ranks by closeness; a substring match in stored order is the closest this world gets.
      return page(a.search ? found : sortProducts(w, found, a.sortBy), a, (p) => productRow(w, p));
    },
  }),

  defineTool<World>({
    name: "get-product",
    supports: ["id", "includeImages", "includeTags", "includeActiveQuantitiesByLocation", "includeActiveQuantityCostItems", "includeBillOfMaterials"],
    run(a: { id: string } & ProductIncludes, { world: w }) {
      const id = normalizeId(a.id, PREFIX.product);
      const p = w.products.find((x) => x.id === id);
      return { product: p ? productDetail(w, p, a) : null };
    },
  }),

  defineTool<World>({
    name: "mutate-product",
    supports: [
      "action", "id", "name", "sku", "categoryId", "subcategoryId", "vendorId", "brandId", "strainId", "groupId",
      "unitPrice", "unitCost", "quantityAvailableThresholdMin", "quantityAvailableThresholdMax", "tagIds", "isInactive",
    ],
    run(a: Omit<ProductEdit, "addTagIds" | "removeTagIds"> & { action: "CREATE" | "UPDATE" | "DELETE"; id?: string }, c) {
      if (a.action !== "UPDATE") throw new ToolError(`This benchmark world does not ${a.action.toLowerCase()} products: only UPDATE is available. To retire a product, UPDATE isInactive.`);
      if (a.id === undefined) throw new ToolError("id is required for UPDATE. Resolve it via distru-search-products.");
      const p = find(c.world.products, normalizeId(a.id, PREFIX.product), "product");
      const patch = readEdit(c.world, a)(p);
      const problem = problemWith(c.world, p, patch);
      if (problem) throw new ToolError(`${p.name} was not saved: ${problem}.`);
      const record = save(c, p, patch);
      if (record) recordAction(c, [record]);
      return { product: productDetail(c.world, p, { includeTags: true }) };
    },
  }),

  defineTool<World>({
    name: "bulk-update-products",
    supports: [
      "ids", "includeInactive", "vendorId", "categoryId", "subcategoryId", "unitPrice", "brandId", "groupId", "strainId", "unitCost",
      "quantityAvailableThresholdMin", "quantityAvailableThresholdMax", "tagIds", "addTagIds", "removeTagIds",
    ],
    run(a: Omit<ProductEdit, "name" | "sku" | "isInactive"> & { ids: string[]; includeInactive?: boolean }, c) {
      const w = c.world;
      if (!a.ids.length) throw new ToolError("ids must list at least one product.");
      if ((a.categoryId === undefined) !== (a.subcategoryId === undefined)) {
        throw new ToolError("categoryId and subcategoryId go together: send the subcategoryId of the new category (null to clear it) in the same call.");
      }
      const ids = [...new Set(normalizeIds(a.ids, PREFIX.product))];
      const unknown = ids.filter((id) => !w.products.some((p) => p.id === id));
      if (unknown.length) throw new ToolError(`No product found with id ${unknown.join(", ")}. Nothing was saved.`);
      const products = ids.map((id) => w.products.find((p) => p.id === id)!);
      const edit = readEdit(w, a);
      const failures = products.flatMap((p) => {
        const problem = !p.active && !a.includeInactive ? "it is inactive; leave it out of ids unless the user asked to change inactive products" : problemWith(w, p, edit(p));
        return problem ? [`${p.name} (${p.id}): ${problem}`] : [];
      });
      if (failures.length) throw new ToolError(`Nothing was saved. ${failures.join(". ")}.`);
      const records = products.map((p) => save(c, p, edit(p))).filter((r) => r !== null);
      if (records.length) recordAction(c, records);
      return { products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, updatedAt: p.updatedAt })) };
    },
  }),

  defineTool<World>({
    name: "search-lookups",
    supports: ["limit", "cursor", "chargeTypes", "ids", "search", "status", "unitTypeCategories", "sortBy", "type"],
    run(a: LookupSearch, { world: w }) {
      for (const input of Object.keys(a)) {
        if (APPLIES_TO[input] && !APPLIES_TO[input](a.type)) throw new ToolError(`${input} does not apply to type ${a.type}.`);
      }
      const limit = a.limit ?? (NAMED_A_TO_Z.includes(a.type) ? 100 : 10);
      return page(lookupRows(w, a), { limit, cursor: a.cursor }, (r) => ({ id: r.id, name: r.name, ...r.fields }));
    },
  }),

  defineTool<World>({
    name: "create-reference-type",
    supports: ["type", "name", "paymentMethodType", "officialProductCategoryId", "productCategoryId"],
    run(a: NewReference, c) {
      return createReference(c, a, checkReference(a));
    },
  }),

  defineTool<World>({
    name: "search-custom-fields",
    supports: ["limit", "cursor", "ids", "search", "entityType", "sortBy"],
    run(a: { limit?: number; cursor?: string; ids?: string[]; search?: string; entityType?: string; sortBy?: SortBy }, { world: w }) {
      const ids = normalizeIds(a.ids, PREFIX.customField);
      const found = w.customFields.filter((f) => (!ids || ids.includes(f.id)) && (!a.entityType || f.entityType === a.entityType) && matches(a.search, f.name, f.description));
      // With `search` the documentation ranks by similarity; a substring match in stored order is the closest this world gets.
      return page(a.search ? found : sorted(found, a.sortBy, NAME_OR_AGE, RECENT), a, customFieldOut);
    },
  }),

  defineTool<World>({
    name: "create-custom-field",
    supports: ["entityType", "name", "fieldType", "description", "required", "options"],
    run(a: { entityType: string; name: string; fieldType: CustomField["fieldType"]; description?: string; required?: boolean; options?: string[] }, c) {
      const w = c.world;
      const name = text(a.name, "name");
      if (name.length > 70) throw new ToolError("name must be at most 70 characters.");
      if (a.description !== undefined && a.description.length > 100) throw new ToolError("description must be at most 100 characters.");
      const clash = w.customFields.find((f) => f.entityType === a.entityType && f.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new ToolError(`${a.entityType} already has a custom field named "${clash.name}" (${clash.id}); change it with distru-update-custom-field instead.`);
      const options = readOptions(a.fieldType, a.options);
      const field: CustomField = {
        id: newId(w, PREFIX.customField), entityType: a.entityType, name, fieldType: a.fieldType,
        description: a.description?.trim() || null, required: a.required ?? false, options,
      };
      w.customFields.push(field);
      recordAction(c, [{ type: "CUSTOM_FIELD", id: field.id, name, op: "INSERT", rowLabel: null, fields: [] }]);
      return { customField: customFieldOut(field) };
    },
  }),

  defineTool<World>({
    name: "search-price-tiers",
    supports: [
      "limit", "cursor", "ids", "search", "customerIds", "customerGroupIds", "productIds", "productTagIds", "productCategoryIds",
      "productSubcategoryIds", "productGroupIds", "brandIds", "menuIds", "validAt", "pricingType", "ownerIds", "includeDeleted", "sortBy",
    ],
    run(a: TierSearch) {
      for (const [input, prefix] of Object.entries(TIER_FILTERS)) normalizeIds(a[input as keyof typeof TIER_FILTERS], prefix);
      if (a.validAt !== undefined) instant(a.validAt);
      // The company has set up no price tiers, so every filter matches nothing.
      return page([], a, (tier: never) => tier);
    },
  }),
];
