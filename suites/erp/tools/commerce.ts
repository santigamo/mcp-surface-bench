// Wholesale menus: the menus themselves, their settings, and the products buyers see on them.
import { matches, money, normalizeId, normalizeIds, page, qty, sorted, type SortBy } from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import { availableQuantity, fullName, PREFIX, type Category, type Id, type Menu, type Product, type World } from "../world.ts";
import { find, named, recordAction, stamp, type C } from "./shared.ts";

type Status = "ACTIVE" | "ANY" | "INACTIVE";
const inStatus = (status: Status = "ACTIVE", active: boolean) => status === "ANY" || (status === "ACTIVE") === active;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The buyer-facing link: `/menu/<company slug>/<urlSuffix>`, as mutate-menu describes it. */
const primaryUrl = (w: World, m: Menu) => `https://app.distru.com/menu/${slugify(w.company.name)}/${m.urlSuffix}`;

const person = (w: World, id: Id | null) => {
  const u = id ? w.users.find((x) => x.id === id) : undefined;
  return u ? { id: u.id, fullName: fullName(u) } : null;
};

function menuById(w: World, id: string): Menu {
  return find(w.menus, normalizeId(id, PREFIX.menu), "menu");
}

// The world does not model the DistruCommerce Shop listing or selling by potency, so no menu is discoverable or sells by potency.
const NOT_MODELLED = { discoverable: false, allowSellingByPotency: false } as const;

/** A row of search-menus. */
const menuRow = (w: World, m: Menu) => ({
  id: m.id,
  name: m.name,
  externalName: m.externalName,
  menuTitle: null,
  active: m.active,
  ...NOT_MODELLED,
  visibility: m.visibility,
  primaryUrl: primaryUrl(w, m),
  sellByCaseOnly: m.sellByCaseOnly,
  showInventoryLevels: m.showInventoryLevels,
  minimumOrderLeadTimeDays: m.minimumOrderLeadTimeDays,
  minimumOrderSubtotal: m.minimumOrderSubtotal === null ? null : money(m.minimumOrderSubtotal),
  aiOrderIntakeEmail: null,
  insertedAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/** A menu as get-menu-settings and mutate-menu return it. Settings the world does not model carry the web form's defaults. */
const menuSettings = (w: World, m: Menu, includeCollections: boolean) => ({
  id: m.id,
  name: m.name,
  externalName: m.externalName,
  primaryUrl: primaryUrl(w, m),
  owner: person(w, m.ownerId),
  active: m.active,
  visibility: m.visibility,
  ...NOT_MODELLED,
  allowPartnerOrders: m.allowPartnerOrders,
  // Menus have no inventory sources of their own here: quantityAvailable counts stock at every location.
  locations: w.locations.map((l) => ({ id: l.id, name: l.name })),
  minimumOrderSubtotal: m.minimumOrderSubtotal === null ? null : money(m.minimumOrderSubtotal),
  minimumOrderLeadTimeDays: m.minimumOrderLeadTimeDays,
  availableDeliveryDays: [],
  buyerCanSelectDeliveryDate: false,
  sellByCaseOnly: m.sellByCaseOnly,
  allowCustomersToOverOrder: false,
  defaultOrderStatus: "Pending",
  buyerDefaultOrderOwnerMode: "DEFAULT",
  buyerDefaultOrderOwner: null,
  sellerDefaultOrderOwnerMode: "SALES_REP",
  sellerDefaultOrderOwner: null,
  allowSalesRepsToOverrideNetTerms: false,
  autoCreateInvoiceForSalesRepOrders: false,
  showInventoryLevels: m.showInventoryLevels,
  // search-menu-products lists a product with nothing available as sold out, so that is the mode every menu has.
  showProductsWithNoInventoryMode: "SHOW_AS_SOLD_OUT",
  hidePricesMode: m.hidePricesMode,
  hideOriginalPriceWhenPriceTierApplied: false,
  potencyOfficialProductCategoryIds: [],
  showCoa: false,
  showExpirationDate: false,
  showPackageDate: false,
  showTac: false,
  showTotalCbd: false,
  allowBuyersToRequestTradeSamples: false,
  restrictTradeSampleRequestToProductsInCart: false,
  sendInternalOrderNotifications: false,
  internalOrderNotificationRecipients: [],
  // The world has no collections, custom or official.
  ...(includeCollections ? { collections: [], officialCollections: [] } : {}),
});

// ---------- menu products ----------

type Listing = { product: Product; addedAt: string };

/** The products a menu lists, in the order they were added. An inactive product is not shown to buyers. */
const listings = (w: World, m: Menu): Listing[] =>
  m.products.map((x) => ({ product: w.products.find((p) => p.id === x.productId)!, addedAt: x.addedAt })).filter((x) => x.product.active);

const categoryOf = (w: World, p: Product) => w.categories.find((c) => c.id === p.categoryId)!;
const strainOf = (w: World, p: Product) => w.strains.find((s) => s.id === p.strainId) ?? null;

/** A product as a menu shows it. */
function menuProduct(w: World, m: Menu, p: Product) {
  const category = categoryOf(w, p);
  const strain = strainOf(w, p);
  const unit = w.unitTypes.find((u) => u.id === p.unitTypeId)!;
  const available = availableQuantity(w, p);
  return {
    id: p.id,
    name: p.name,
    unitsPerCase: null,
    maxMenuBuyerOrderQuantity: null,
    totalThc: p.thcPercent === null ? null : qty(p.thcPercent),
    totalCannabinoidUnit: p.thcPercent === null ? null : "PERCENT",
    brand: named(w.companies, p.brandId),
    category: { id: category.id, name: category.name, officialProductCategory: { id: category.official } },
    subcategory: named(category.subcategories, p.subcategoryId),
    strain: strain && { id: strain.id, name: strain.name, strainType: strain.strainType },
    unitType: { id: unit.id, name: unit.name, category: unit.category, qtyPerSiUnit: null },
    quantityAvailable: m.showInventoryLevels ? qty(available) : null,
    soldOut: available <= 0,
    unitPrice: m.hidePricesMode === "HIDE_FOR_EVERYONE" ? null : money(p.unitPrice),
    // Not sold by potency, and the world has no lab results to span.
    thcPercentageTotalLevels: [],
    thcPercentageTotalRange: null,
  };
}

type CategoryArgs = { officialProductCategories?: Category["official"][]; productCategoryIds?: string[]; productSubcategoryIds?: string[] };

function subcategoryParent(w: World, id: Id): Category {
  const parent = w.categories.find((c) => c.subcategories.some((s) => s.id === id));
  if (!parent) throw new ToolError(`No product subcategory found with id ${id}.`);
  return parent;
}

/**
 * The three category filters narrow level by level. A category narrows its own category type and a subcategory its
 * own category, and each brings in its parents, so FLOWER plus a Gummies subcategory returns all flower but only gummies.
 */
function categoryFilter(w: World, args: CategoryArgs): ((p: Product) => boolean) | undefined {
  const subIds = new Set(normalizeIds(args.productSubcategoryIds, PREFIX.subcategory));
  const catIds = new Set(normalizeIds(args.productCategoryIds, PREFIX.category)?.map((id) => find(w.categories, id, "product category").id));
  for (const id of subIds) catIds.add(subcategoryParent(w, id).id);
  const types = new Set([...(args.officialProductCategories ?? []), ...w.categories.filter((c) => catIds.has(c.id)).map((c) => c.official)]);
  if (!types.size) return undefined;
  return (p) => {
    const category = categoryOf(w, p);
    if (!types.has(category.official)) return false;
    const typeNarrowed = w.categories.some((c) => c.official === category.official && catIds.has(c.id));
    if (typeNarrowed && !catIds.has(category.id)) return false;
    const categoryNarrowed = category.subcategories.some((s) => subIds.has(s.id));
    return !categoryNarrowed || (p.subcategoryId !== null && subIds.has(p.subcategoryId));
  };
}

const OFFICIAL_NAMES: Record<Category["official"], string> = { FLOWER: "Flower", PREROLLS: "Pre-Rolls", EDIBLES: "Edibles", VAPES: "Vapes", CONCENTRATES: "Concentrates" };
const titleCase = (s: string) => s[0] + s.slice(1).toLowerCase();
const idName = (x: { id: Id; name: string }) => ({ id: x.id, name: x.name });

/** The values each filter can take on these products, keyed by the input they go in. */
function filterOptions(w: World, products: Product[]) {
  const has = (key: (p: Product) => Id | null) => new Set(products.map(key));
  const categories = w.categories.filter((c) => has((p) => p.categoryId).has(c.id));
  const subcategories = has((p) => p.subcategoryId);
  const strains = w.strains.filter((s) => has((p) => p.strainId).has(s.id));
  return {
    officialProductCategories: [...new Set(categories.map((c) => c.official))].map((type) => ({
      id: type,
      name: OFFICIAL_NAMES[type],
      productCategoryIds: categories.filter((c) => c.official === type).map((c) => ({ ...idName(c), productSubcategoryIds: c.subcategories.filter((s) => subcategories.has(s.id)).map(idName) })),
    })),
    strainTypes: [...new Set(strains.map((s) => s.strainType))].map((t) => ({ id: t, name: titleCase(t) })),
    strainIds: strains.map(idName),
    brandIds: w.companies.filter((c) => has((p) => p.brandId).has(c.id)).map(idName),
    productGroupIds: w.groups.filter((g) => has((p) => p.groupId).has(g.id)).map(idName),
  };
}

type MenuProductArgs = CategoryArgs & {
  menuId: string;
  search?: string;
  productIds?: string[];
  strainTypes?: string[];
  strainIds?: string[];
  brandIds?: string[];
  productGroupIds?: string[];
  includeFilterOptions?: boolean;
  sortBy?: SortBy;
  limit?: number;
  cursor?: string;
};

/** Every filter but productIds, which also bounds filterOptions. */
function productFilter(w: World, args: MenuProductArgs): (p: Product) => boolean {
  const byCategory = categoryFilter(w, args);
  const strainIds = normalizeIds(args.strainIds, PREFIX.strain);
  const brandIds = normalizeIds(args.brandIds, PREFIX.company);
  const groupIds = normalizeIds(args.productGroupIds, PREFIX.group);
  const oneOf = (wanted: string[] | undefined, value: string | null | undefined) => !wanted || (value != null && wanted.includes(value));
  return (p) =>
    (!byCategory || byCategory(p)) &&
    oneOf(args.strainTypes, strainOf(w, p)?.strainType) &&
    oneOf(strainIds, p.strainId) &&
    oneOf(brandIds, p.brandId) &&
    oneOf(groupIds, p.groupId) &&
    searchMatch(w, args.search, p) !== undefined;
}

/**
 * How well a product matches `search`: 0 for its name, 1 for any other searched field, undefined for no match.
 * Product groups are left out: the world does not model which menus allow filtering by group.
 */
function searchMatch(w: World, search: string | undefined, p: Product): number | undefined {
  if (!search || matches(search, p.name)) return 0;
  const category = categoryOf(w, p);
  const strain = strainOf(w, p);
  const others = [p.sku, strain?.name, strain?.strainType, named(w.companies, p.brandId)?.name, category.name, named(category.subcategories, p.subcategoryId)?.name, category.official];
  return matches(search, ...others) ? 1 : undefined;
}

// ---------- mutate-menu ----------

/** The menu fields UPDATE can change, with the label record history shows for each. */
const EDITABLE = {
  name: "Name",
  externalName: "External name",
  urlSuffix: "URL suffix",
  ownerId: "Owner",
  active: "Active",
  visibility: "Visibility",
  allowPartnerOrders: "Allow partner orders",
  minimumOrderSubtotal: "Minimum order subtotal",
  minimumOrderLeadTimeDays: "Minimum order lead time (days)",
  sellByCaseOnly: "Sell by case only",
  showInventoryLevels: "Show inventory levels",
  hidePricesMode: "Hide prices",
} as const;
type Editable = keyof typeof EDITABLE;
type MenuPatch = Partial<Pick<Menu, Editable>>;
type MutateArgs = { action: "CREATE" | "UPDATE"; id?: string } & { [K in Editable]?: K extends "minimumOrderSubtotal" ? string | number | null : Menu[K] };

/** The sent fields as the menu stores them. */
function readPatch(w: World, args: MutateArgs): MenuPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(EDITABLE) as Editable[]) if (key in args) patch[key] = args[key];
  if (args.ownerId) patch.ownerId = find(w.users, normalizeId(args.ownerId, PREFIX.user), "user").id;
  if (args.minimumOrderSubtotal != null) {
    const amount = Number(args.minimumOrderSubtotal);
    if (!Number.isFinite(amount) || amount < 0) throw new ToolError(`minimumOrderSubtotal must be an amount of 0 or more, not "${args.minimumOrderSubtotal}".`);
    patch.minimumOrderSubtotal = amount;
  }
  return patch as MenuPatch;
}

/** Refuses what the server refuses, before anything changes. */
function checkPatch(w: World, menu: Menu, patch: MenuPatch): void {
  const others = w.menus.filter((m) => m.id !== menu.id);
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new ToolError("name can't be blank.");
    if (others.some((m) => m.name.toLowerCase() === patch.name!.trim().toLowerCase())) throw new ToolError(`Another menu is already named "${patch.name}": menu names are unique in the company.`);
  }
  if (patch.externalName !== undefined && !patch.externalName.trim()) throw new ToolError("externalName can't be blank.");
  if (patch.urlSuffix !== undefined) {
    if (!/^[A-Za-z0-9-]+$/.test(patch.urlSuffix)) throw new ToolError(`urlSuffix "${patch.urlSuffix}" can only have letters, digits and dashes.`);
    if (others.some((m) => m.urlSuffix.toLowerCase() === patch.urlSuffix!.toLowerCase())) throw new ToolError(`Another menu already uses the urlSuffix "${patch.urlSuffix}".`);
  }
  if (patch.minimumOrderLeadTimeDays !== undefined && patch.minimumOrderLeadTimeDays < 0) throw new ToolError("minimumOrderLeadTimeDays can't be negative: 0 allows same-day delivery.");
  const hidePrices = patch.hidePricesMode ?? menu.hidePricesMode;
  if (hidePrices === "HIDE_FOR_EVERYONE" && patch.minimumOrderSubtotal != null) throw new ToolError("minimumOrderSubtotal can't be set while hidePricesMode is HIDE_FOR_EVERYONE.");
  if (patch.visibility === "PASSCODE_PROTECTED" && menu.visibility !== "PASSCODE_PROTECTED") {
    throw new ToolError("A menu turning PASSCODE_PROTECTED needs a passcode, which this benchmark world does not store: choose PUBLIC or PRIVATE.");
  }
}

/** A stored value as record history prints it. */
function shown(w: World, key: Editable, value: unknown): string | null {
  if (value === null) return null;
  if (key === "ownerId") return person(w, value as Id)!.fullName;
  if (key === "minimumOrderSubtotal") return money(value as number);
  return String(value);
}

function updateMenu(c: C, args: MutateArgs) {
  const w = c.world;
  if (!args.id) throw new ToolError("UPDATE needs the id of the menu: resolve it via distru-search-menus.");
  const menu = menuById(w, args.id);
  const patch = readPatch(w, args);
  checkPatch(w, menu, patch);
  if ((patch.hidePricesMode ?? menu.hidePricesMode) === "HIDE_FOR_EVERYONE") patch.minimumOrderSubtotal = null;

  const changed = (Object.keys(patch) as Editable[]).filter((k) => patch[k] !== menu[k]);
  const fields = changed.map((k) => ({ field: k, label: EDITABLE[k], oldValue: shown(w, k, menu[k]), newValue: shown(w, k, patch[k]) }));
  Object.assign(menu, patch, { updatedAt: stamp(c) });
  recordAction(c, [{ type: "MENU", id: menu.id, name: menu.name, op: "UPDATE", rowLabel: null, fields }]);
  return { menu: menuSettings(w, menu, true) };
}

// ---------- tools ----------

export const tools = [
  defineTool<World>({
    name: "search-menus",
    supports: ["limit", "cursor", "ids", "search", "status", "visibility", "sortBy"],
    run(args: { limit?: number; cursor?: string; ids?: string[]; search?: string; status?: Status; visibility?: Menu["visibility"]; sortBy?: SortBy }, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.menu);
      const menus = w.menus.filter(
        (m) => (!ids || ids.includes(m.id)) && inStatus(args.status, m.active) && (!args.visibility || m.visibility === args.visibility) && matches(args.search, m.name, m.externalName),
      );
      // With `search`, the closest names first: those the search covers more of.
      const closeness = (m: Menu) => Math.max(...[m.name, m.externalName].filter((n) => matches(args.search, n)).map((n) => args.search!.length / n.length));
      const ordered = args.search
        ? [...menus].sort((a, b) => closeness(b) - closeness(a))
        : sorted(menus, args.sortBy, { INSERTED_AT: (m) => Date.parse(m.createdAt), NAME: (m) => m.name, UPDATED_AT: (m) => Date.parse(m.updatedAt) }, { field: "UPDATED_AT", direction: "DESC" });
      return page(ordered, args, (m) => menuRow(w, m));
    },
  }),

  defineTool<World>({
    name: "get-menu-settings",
    supports: ["id", "includeCollections"],
    run(args: { id: string; includeCollections?: boolean }, { world: w }) {
      const id = normalizeId(args.id, PREFIX.menu);
      const menu = w.menus.find((m) => m.id === id);
      return { menu: menu ? menuSettings(w, menu, args.includeCollections ?? false) : null };
    },
  }),

  defineTool<World>({
    name: "search-menu-products",
    supports: [
      "menuId", "search", "productIds", "officialProductCategories", "productCategoryIds", "productSubcategoryIds", "strainTypes", "strainIds", "brandIds",
      "productGroupIds", "includeFilterOptions", "sortBy", "limit", "cursor",
    ],
    run(args: MenuProductArgs, { world: w }) {
      const menu = menuById(w, args.menuId);
      const productIds = normalizeIds(args.productIds, PREFIX.product);
      const scope = listings(w, menu).filter((x) => !productIds || productIds.includes(x.product.id));
      const keep = productFilter(w, args);
      const found = scope.filter((x) => keep(x.product));
      // UPDATED_AT is when the listing last changed; a listing here changes only when the product is added.
      const ordered = args.search
        ? [...found].sort((a, b) => searchMatch(w, args.search, a.product)! - searchMatch(w, args.search, b.product)!)
        : sorted(found, args.sortBy, { INSERTED_AT: (x) => Date.parse(x.addedAt), UPDATED_AT: (x) => Date.parse(x.addedAt), PRODUCT_NAME: (x) => x.product.name }, { field: "UPDATED_AT", direction: "DESC" });
      return {
        ...page(ordered, args, (x) => menuProduct(w, menu, x.product)),
        ...(args.includeFilterOptions ? { filterOptions: filterOptions(w, scope.map((x) => x.product)) } : {}),
      };
    },
  }),

  defineTool<World>({
    name: "search-menu-collections",
    supports: ["menuId", "customerId", "collectionId", "includeProducts", "productLimit", "sortBy", "limit", "cursor"],
    run(args: { menuId: string; customerId?: string; collectionId?: string; productLimit?: number; limit?: number; cursor?: string }, { world: w }) {
      menuById(w, args.menuId);
      if (args.customerId) find(w.companies, normalizeId(args.customerId, PREFIX.company), "company");
      if (args.productLimit !== undefined && args.productLimit < 1) throw new ToolError("productLimit must be at least 1.");
      if (args.collectionId) throw new ToolError(`No collection found with id ${args.collectionId}: this menu has no collections.`);
      // The world has no collections, custom or official, so every menu lists none: sortBy and includeProducts have nothing to act on.
      return page([], args, () => ({}));
    },
  }),

  defineTool<World>({
    name: "mutate-menu",
    supports: ["action", "id", ...Object.keys(EDITABLE)],
    run(args: MutateArgs, c) {
      if (args.action === "CREATE") throw new ToolError("This benchmark world cannot create menus: UPDATE an existing one, found via distru-search-menus.");
      return updateMenu(c, args);
    },
  }),
];
