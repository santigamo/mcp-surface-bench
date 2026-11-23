import { expect, test } from "bun:test";
import { isoIn } from "../src/core/kit.ts";
import { erp } from "../suites/erp/index.ts";
import { availableQuantity, type World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

const menuId = (w: World, name: string) => w.menus.find((m) => m.name === name)!.id;
const names = (r: { items: { name: string }[] }) => r.items.map((x) => x.name);
const allProducts = (call: ReturnType<typeof bench>["call"], args: Record<string, unknown>) => call("search-menu-products", { limit: 100, ...args });

test("search-menus finds menus by either name, respects status and visibility, sorts and pages", () => {
  const { call, error } = bench();
  expect(names(call("search-menus"))).toEqual(["Bay Area Menu", "Spring Menu", "Main Wholesale Menu"]);
  expect(names(call("search-menus", { search: "main wholesale" }))).toEqual(["Main Wholesale Menu"]);
  expect(names(call("search-menus", { search: "SPRING DROP" }))).toEqual(["Spring Menu"]);
  expect(names(call("search-menus", { search: "holiday" }))).toEqual([]);
  expect(names(call("search-menus", { search: "holiday", status: "ANY" }))).toEqual(["Holiday Menu"]);
  expect(names(call("search-menus", { status: "INACTIVE" }))).toEqual(["Holiday Menu"]);
  expect(names(call("search-menus", { visibility: "PRIVATE" }))).toEqual(["Bay Area Menu"]);
  expect(names(call("search-menus", { ids: ["1", "men_2"], sortBy: { field: "NAME", direction: "ASC" } }))).toEqual(["Main Wholesale Menu", "Spring Menu"]);
  expect(names(call("search-menus", { status: "ANY", sortBy: { field: "INSERTED_AT", direction: "ASC" } }))[0]).toBe("Holiday Menu");

  const first = call("search-menus", { limit: 2 });
  expect(first.hasMore).toBe(true);
  const second = call("search-menus", { limit: 2, cursor: first.nextCursor });
  expect([...names(first), ...names(second)]).toEqual(names(call("search-menus")));
  expect(second.hasMore).toBe(false);

  const main = call("search-menus", { search: "main" }).items[0];
  expect(main).toMatchObject({ externalName: "Tidewater Wholesale", visibility: "PUBLIC", minimumOrderSubtotal: "500.00", aiOrderIntakeEmail: null });
  expect(main.primaryUrl).toEndWith("/menu/tidewater-cannabis-co/mainwholesalemenu");

  expect(error("search-menus", { ids: ["prd_1"] })).toContain("tool_error");
  expect(error("search-menus", { limit: 500 })).toContain("tool_error");
  expect(error("search-menus", { status: "LIVE" })).toContain("invalid_arguments");
});

test("get-menu-settings returns one menu, inactive ones included, with collections on request", () => {
  const { call, error, world } = bench();
  const bay = call("get-menu-settings", { id: menuId(world, "Bay Area Menu") }).menu;
  expect(bay).toMatchObject({ name: "Bay Area Menu", active: true, visibility: "PRIVATE", owner: { fullName: "Daniel Reyes" }, showProductsWithNoInventoryMode: "SHOW_AS_SOLD_OUT" });
  expect(bay.collections).toBeUndefined();
  expect(call("get-menu-settings", { id: menuId(world, "Holiday Menu") }).menu.active).toBe(false);
  const withCollections = call("get-menu-settings", { id: menuId(world, "Bay Area Menu"), includeCollections: true }).menu;
  expect(withCollections.collections).toEqual([]);
  expect(withCollections.officialCollections).toEqual([]);
  expect(call("get-menu-settings", { id: "men_99" }).menu).toBeNull();
  expect(error("get-menu-settings", { id: "com_1" })).toContain("tool_error");
  expect(error("get-menu-settings")).toContain("invalid_arguments");
});

test("the main wholesale menu lists 18 products, four of them sold out, in pages of 10", () => {
  const { call, world } = bench();
  const menu = menuId(world, "Main Wholesale Menu");
  const first = call("search-menu-products", { menuId: menu });
  expect(first.items).toHaveLength(10);
  expect(first.totalCount).toBe(18);
  expect(first.hasMore).toBe(true);
  const second = call("search-menu-products", { menuId: menu, cursor: first.nextCursor });
  expect(second.items).toHaveLength(8);
  expect(second.hasMore).toBe(false);

  const rows = [...first.items, ...second.items];
  expect(new Set(rows.map((r: any) => r.id)).size).toBe(18);
  expect(rows.filter((r: any) => r.soldOut).map((r: any) => r.name).sort()).toEqual(["Gelato 3.5g", "Mango Gummies 100mg", "OG Kush Cartridge 0.5g", "Sour Diesel 1g Pre-Roll"]);
  for (const r of rows) {
    const available = availableQuantity(world, world.products.find((p) => p.id === r.id)!);
    expect(r.quantityAvailable).toBe(String(available));
    expect(r.soldOut).toBe(available <= 0);
  }
  // On hand 110, of which open orders hold 45.
  expect(rows.find((r: any) => r.name === "Blue Dream Cartridge 1g").quantityAvailable).toBe("65");
  expect(rows.some((r: any) => r.name === "Jack Herer 14g")).toBe(false);

  const spring = allProducts(call, { menuId: menuId(world, "Spring Menu") });
  expect(spring.items.find((r: any) => r.name === "Jack Herer 14g").soldOut).toBe(true);
});

test("the spring menu shows total THC in percent on its five flower products", () => {
  const { call, world } = bench();
  const menu = menuId(world, "Spring Menu");
  expect(call("search-menu-products", { menuId: menu }).totalCount).toBe(9);
  const flower = allProducts(call, { menuId: menu, officialProductCategories: ["FLOWER"] });
  const thc = Object.fromEntries(flower.items.map((r: any) => [r.name, `${r.totalThc} ${r.totalCannabinoidUnit}`]));
  expect(thc).toEqual({ "Blue Dream 3.5g": "24.6 PERCENT", "Wedding Cake 3.5g": "27.1 PERCENT", "Sour Diesel 3.5g": "22.8 PERCENT", "OG Kush 3.5g": "25.3 PERCENT", "Jack Herer 14g": "19.4 PERCENT" });
  for (const r of flower.items) expect(r.category).toEqual({ id: "cat_1", name: "Flower", officialProductCategory: { id: "FLOWER" } });

  const gummies = allProducts(call, { menuId: menu, officialProductCategories: ["EDIBLES"] }).items[0];
  expect(gummies).toMatchObject({ name: "Sour Cherry Gummies 100mg", totalThc: null, totalCannabinoidUnit: null });
  expect(names(allProducts(call, { menuId: menu, productCategoryIds: ["1"] }))).toEqual(names(flower));
});

test("category filters narrow level by level", () => {
  const { call, world } = bench();
  const menu = menuId(world, "Main Wholesale Menu");
  const sub = (name: string) => world.categories.flatMap((c) => c.subcategories).find((s) => s.name === name)!.id;
  const flowerAndGummies = allProducts(call, { menuId: menu, officialProductCategories: ["FLOWER", "EDIBLES"], productSubcategoryIds: [sub("Gummies")] });
  expect(names(flowerAndGummies).sort()).toEqual(["Blue Dream 3.5g", "Blue Dream 7g", "Gelato 3.5g", "Mango Gummies 100mg", "OG Kush 3.5g", "Watermelon Gummies 100mg", "Wedding Cake 3.5g"]);
  expect(names(allProducts(call, { menuId: menu, productSubcategoryIds: [sub("Quarters")] }))).toEqual(["Blue Dream 7g"]);
  expect(names(allProducts(call, { menuId: menu, officialProductCategories: ["EDIBLES"], productCategoryIds: ["cat_3"] })).sort()).toEqual(["Dark Chocolate Bar 100mg", "Mango Gummies 100mg", "Watermelon Gummies 100mg"]);
});

test("search-menu-products honours every filter, the sort and filterOptions", () => {
  const { call, error, world } = bench();
  const menu = menuId(world, "Main Wholesale Menu");
  const product = (name: string) => world.products.find((p) => p.name === name)!;

  // Name matches rank by how closely the name matches: the shortest name holding the term first.
  expect(names(allProducts(call, { menuId: menu, search: "gelato" }))).toEqual(["Gelato 3.5g", "Gelato Cartridge 1g", "Gelato Live Resin 1g", "Gelato Infused Pre-Roll"]);
  // Search also reaches the strain type and the SKU.
  expect(names(allProducts(call, { menuId: menu, search: "indica" })).sort()).toEqual(["OG Kush 3.5g", "OG Kush Cartridge 0.5g", "Wedding Cake 1g Pre-Roll", "Wedding Cake 3.5g", "Wedding Cake Live Rosin 1g"]);
  expect(allProducts(call, { menuId: menu, search: "fl-" }).totalCount).toBe(5);
  expect(names(allProducts(call, { menuId: menu, productIds: [product("Gelato 3.5g").id, "2"] })).sort()).toEqual(["Blue Dream 7g", "Gelato 3.5g"]);
  expect(allProducts(call, { menuId: menu, strainTypes: ["SATIVA"] }).items.every((r: any) => r.strain.strainType === "SATIVA")).toBe(true);
  expect(names(allProducts(call, { menuId: menu, strainIds: ["str_6"] }))).toEqual([]);
  expect(allProducts(call, { menuId: menu, brandIds: ["com_1"] }).totalCount).toBe(0);
  const house = allProducts(call, { menuId: menu, productGroupIds: ["grp_1"] });
  expect(house.items.every((r: any) => product(r.name).groupId === "grp_1")).toBe(true);
  expect(house.totalCount).toBeGreaterThan(0);

  const byName = allProducts(call, { menuId: menu, sortBy: { field: "PRODUCT_NAME", direction: "ASC" } });
  expect(names(byName)).toEqual([...names(byName)].sort((a, b) => a.localeCompare(b)));
  expect(allProducts(call, { menuId: menu, sortBy: { field: "INSERTED_AT", direction: "ASC" } }).items[0].name).toBe("Blue Dream 3.5g");
  expect(allProducts(call, { menuId: menu }).items[0].name).toBe("Wedding Cake Live Rosin 1g");

  expect(call("search-menu-products", { menuId: menu }).filterOptions).toBeUndefined();
  const options = call("search-menu-products", { menuId: menu, includeFilterOptions: true, search: "gelato" }).filterOptions;
  expect(options.officialProductCategories.map((o: any) => o.id)).toEqual(["FLOWER", "PREROLLS", "EDIBLES", "VAPES", "CONCENTRATES"]);
  expect(options.strainIds).toHaveLength(5);
  expect(options.brandIds).toEqual([]);

  expect(error("search-menu-products")).toContain("invalid_arguments");
  expect(error("search-menu-products", { menuId: "men_99" })).toContain("tool_error");
  expect(error("search-menu-products", { menuId: menu, productCategoryIds: ["cat_99"] })).toContain("tool_error");
  expect(error("search-menu-products", { menuId: menu, productIds: ["men_1"] })).toContain("tool_error");
});

test("search-menu-products shows prices and stock only as the menu allows", () => {
  const { call, world } = bench();
  const menu = world.menus.find((m) => m.name === "Bay Area Menu")!;
  menu.hidePricesMode = "HIDE_FOR_EVERYONE";
  menu.showInventoryLevels = false;
  const row = call("search-menu-products", { menuId: menu.id }).items[0];
  expect(row.unitPrice).toBeNull();
  expect(row.quantityAvailable).toBeNull();
});

test("search-menu-collections lists no collections: the world has none", () => {
  const { call, error, world } = bench();
  const menu = menuId(world, "Spring Menu");
  expect(call("search-menu-collections", { menuId: menu })).toEqual({ items: [], hasMore: false, totalCount: 0 });
  const everything = { menuId: menu, customerId: "com_7", includeProducts: true, productLimit: 5, sortBy: { field: "POSITION", direction: "ASC" }, limit: 50 };
  expect(call("search-menu-collections", everything).items).toEqual([]);
  expect(error("search-menu-collections", { menuId: menu, collectionId: "1" })).toContain("tool_error");
  expect(error("search-menu-collections", { menuId: menu, productLimit: 0 })).toContain("tool_error");
  expect(error("search-menu-collections", { menuId: menu, customerId: "usr_1" })).toContain("tool_error");
  expect(error("search-menu-collections", { menuId: "men_99" })).toContain("tool_error");
});

test("turning off the Bay Area menu changes only that field and logs one action", () => {
  const { call, world } = bench();
  const menu = world.menus.find((m) => m.name === "Bay Area Menu")!;
  const before = structuredClone(menu);
  const actions = world.actions.length;

  const result = call("mutate-menu", { action: "UPDATE", id: menu.id, active: false });
  expect(result.menu).toEqual(call("get-menu-settings", { id: menu.id, includeCollections: true }).menu);
  expect(result.menu.active).toBe(false);

  const stamp = isoIn(world.timezone, erp.clock(TODAY));
  expect(menu).toEqual({ ...before, active: false, updatedAt: stamp });
  expect(world.actions).toHaveLength(actions + 1);
  expect(world.actions.at(-1)).toMatchObject({ source: "MCP", actorName: "Maya Okafor", changedAt: stamp, records: [{ type: "MENU", id: menu.id, op: "UPDATE", fields: [{ field: "active", oldValue: "true", newValue: "false" }] }] });
  expect(names(call("search-menus"))).not.toContain("Bay Area Menu");
});

test("mutate-menu UPDATE writes every field it supports", () => {
  const { call, world } = bench();
  const menu = world.menus.find((m) => m.name === "Spring Menu")!;
  const result = call("mutate-menu", {
    action: "UPDATE", id: "2", name: "Spring 2027", externalName: "Tidewater Spring 2027", urlSuffix: "spring-2027", ownerId: "usr_3", active: true, visibility: "PRIVATE",
    allowPartnerOrders: false, minimumOrderSubtotal: "750", minimumOrderLeadTimeDays: 0, sellByCaseOnly: true, showInventoryLevels: false, hidePricesMode: "HIDE_FOR_NON_LOGGED_IN_USERS",
  }).menu;
  expect(result).toMatchObject({ name: "Spring 2027", externalName: "Tidewater Spring 2027", owner: { id: "usr_3", fullName: "Priya Nair" }, visibility: "PRIVATE", allowPartnerOrders: false, minimumOrderSubtotal: "750.00", minimumOrderLeadTimeDays: 0, sellByCaseOnly: true, showInventoryLevels: false, hidePricesMode: "HIDE_FOR_NON_LOGGED_IN_USERS" });
  expect(result.primaryUrl).toEndWith("/spring-2027");
  // `active` was sent unchanged, so the action lists the other eleven fields.
  expect(world.actions.at(-1)!.records[0]!.fields.map((f) => f.field)).toHaveLength(11);
  expect(world.actions.at(-1)!.records[0]!.fields.find((f) => f.field === "ownerId")).toMatchObject({ oldValue: "Daniel Reyes", newValue: "Priya Nair" });

  expect(call("mutate-menu", { action: "UPDATE", id: menu.id, ownerId: null, minimumOrderSubtotal: null }).menu).toMatchObject({ owner: null, minimumOrderSubtotal: null });
  call("mutate-menu", { action: "UPDATE", id: menu.id, minimumOrderSubtotal: 300 });
  expect(call("mutate-menu", { action: "UPDATE", id: menu.id, hidePricesMode: "HIDE_FOR_EVERYONE" }).menu.minimumOrderSubtotal).toBeNull();
});

test("mutate-menu refuses what it cannot do and leaves the world untouched", () => {
  const { error, world } = bench();
  const bay = world.menus.find((m) => m.name === "Bay Area Menu")!;
  const before = structuredClone(world.menus);
  const actions = world.actions.length;

  expect(error("mutate-menu", { action: "CREATE", name: "Winter Menu" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", active: false })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: "men_99", active: false })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, name: "spring menu" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, urlSuffix: "springmenu" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, urlSuffix: "bay area" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, ownerId: "usr_99" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, minimumOrderSubtotal: "lots" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, minimumOrderLeadTimeDays: -1 })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, hidePricesMode: "HIDE_FOR_EVERYONE", minimumOrderSubtotal: 100 })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, visibility: "PASSCODE_PROTECTED" })).toContain("tool_error");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, active: false, passcode: "1234" })).toContain("unsupported_input");
  expect(error("mutate-menu", { action: "UPDATE", id: bay.id, locationIds: ["loc_1"] })).toContain("unsupported_input");
  expect(error("mutate-menu", { action: "DELETE", id: bay.id })).toContain("invalid_arguments");

  expect(world.menus).toEqual(before);
  expect(world.actions).toHaveLength(actions);
});
