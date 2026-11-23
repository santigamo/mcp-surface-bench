// What several areas render the same way: users, lookups by id, products and the filters on them, custom fields,
// record links, and how a write is logged. Derived values of the data (stock, totals, payment state) live in world.ts;
// conventions that are not about this company (paging, dates, search) in src/core/kit.ts.
import { anyInList, inList, isoIn, normalizeIds } from "../../../src/core/kit.ts";
import { ToolError, type Ctx } from "../../../src/core/tool.ts";
import { PREFIX, fullName, newId, type ActionRow, type Id, type Product, type User, type World } from "../world.ts";

export type C = Ctx<World>;

// ---------- users ----------

/** A user as most tools embed one: `{ id, profile: { fullName } }`. */
export const userRef = (w: World, id: Id | null) => {
  const u = id ? w.users.find((x) => x.id === id) : undefined;
  return u ? { id: u.id, profile: { fullName: fullName(u) } } : null;
};

/** A user's full name, or null. */
export const userName = (w: World, id: Id | null) => userRef(w, id)?.profile.fullName ?? null;

export const userProfile = (u: User) => ({ fullName: fullName(u), firstName: u.firstName, lastName: u.lastName, initials: `${u.firstName[0]}${u.lastName[0]}` });

// ---------- lookups ----------

/** `{ id, name }` of a record in a collection, or null. */
export const named = <T extends { id: Id; name: string }>(items: T[], id: Id | null) => {
  const x = id ? items.find((i) => i.id === id) : undefined;
  return x ? { id: x.id, name: x.name } : null;
};

/** Finds a record or raises the error a wrong id gets. `what` names the record for the message: "product". */
export function find<T extends { id: Id }>(items: T[], id: Id, what: string): T {
  const x = items.find((i) => i.id === id);
  if (!x) throw new ToolError(`No ${what} found with id ${id}.`);
  return x;
}

/** The number of an id: `prd_12` -> 12. Records without timestamps were numbered as they were created. */
export const serial = (id: Id) => Number(id.split("_")[1]);

// ---------- products ----------

export const productOf = (w: World, id: Id) => w.products.find((p) => p.id === id)!;
export const categoryOf = (w: World, p: Product) => w.categories.find((c) => c.id === p.categoryId)!;
export const subcategoryName = (w: World, p: Product) => categoryOf(w, p).subcategories.find((s) => s.id === p.subcategoryId)?.name ?? null;
export const unitTypeOf = (w: World, p: Product) => named(w.unitTypes, p.unitTypeId)!;
export const companyName = (w: World, id: Id | null) => named(w.companies, id)?.name ?? null;

/** The product filters the reports, search-batches and search-packages document in the same words, and search-products shares. */
export type ProductFilters = { productCategoryIds?: string[]; productSubcategoryIds?: string[]; productTagIds?: string[]; vendorIds?: string[]; brandIds?: string[]; productGroupIds?: string[] };
export const PRODUCT_FILTERS = ["productCategoryIds", "productSubcategoryIds", "productTagIds", "vendorIds", "brandIds", "productGroupIds"] as const;

/**
 * The test those filters set. Categories and subcategories are ORed, except that a listed subcategory narrows its own
 * category when both are listed; tags match any; vendor, brand and group match the product's own.
 */
export function productFilter(w: World, f: ProductFilters): (p: Product) => boolean {
  const categories = normalizeIds(f.productCategoryIds, PREFIX.category);
  const subcategories = normalizeIds(f.productSubcategoryIds, PREFIX.subcategory);
  const tags = normalizeIds(f.productTagIds, PREFIX.tag);
  const vendors = normalizeIds(f.vendorIds, PREFIX.company);
  const brands = normalizeIds(f.brandIds, PREFIX.company);
  const groups = normalizeIds(f.productGroupIds, PREFIX.group);
  const narrowed = new Set(w.categories.filter((c) => c.subcategories.some((s) => subcategories?.includes(s.id))).map((c) => c.id));
  const ofKind = (p: Product) => {
    if (!categories && !subcategories) return true;
    if (p.subcategoryId !== null && subcategories?.includes(p.subcategoryId)) return true;
    return !!categories?.includes(p.categoryId) && !narrowed.has(p.categoryId);
  };
  return (p) => ofKind(p) && anyInList(tags, p.tagIds) && inList(vendors, p.vendorId) && inList(brands, p.brandId) && inList(groups, p.groupId);
}

// ---------- custom fields and links ----------

/**
 * The custom fields a record of `entityType` carries, as records list them: every field defined for that type, each
 * unset, because the world stores no custom field values.
 */
export const customFieldValues = (w: World, entityType: string) =>
  w.customFields.filter((f) => f.entityType === entityType).map((f) => ({ customField: { id: f.id, name: f.name, fieldType: f.fieldType }, value: null }));

/** The same fields as a report row lists them: `{ key, label, value }`. */
export const reportCustomFields = (w: World, entityType: string) =>
  customFieldValues(w, entityType).map((f) => ({ key: f.customField.id, label: f.customField.name, value: f.value }));

const PAGES = { product: "products", batch: "inventory/batches", salesOrder: "sales-orders", purchaseOrder: "purchases" } as const;

/** A record's page in the Distru web app. URLs carry the bare number, which every id input also takes. */
export const recordUrl = (kind: keyof typeof PAGES, id: Id) => `https://app.distru.com/${PAGES[kind]}/${serial(id)}`;

// ---------- writes ----------

/** The instant of the call as the tools print instants: ISO 8601 with the company's UTC offset. */
export const stamp = (c: C) => isoIn(c.world.timezone, c.now);

/**
 * Logs what a write tool changed, as the signed-in user acting through MCP. Every write tool calls it once, with a
 * row per record or line it wrote, each filed under the record whose history it belongs to.
 */
export function recordAction(c: C, rows: ActionRow[]): void {
  const me = c.world.users.find((u) => u.id === c.world.me)!;
  c.world.actions.push({ id: newId(c.world, PREFIX.action), changedAt: stamp(c), actorId: me.id, actorName: fullName(me), source: "MCP", sourceDetail: null, records: rows });
}
