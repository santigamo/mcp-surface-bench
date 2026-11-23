import { describe, expect, test } from "bun:test";
import { belowMinimum } from "../suites/erp/world.ts";
import { bench } from "./helpers.ts";

const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name);

describe("search-products", () => {
  test("lists active products, most recently updated first, and pages", () => {
    const { call, world } = bench();
    const first = call("search-products");
    expect(first.items).toHaveLength(10);
    expect(first.totalCount).toBe(world.products.filter((p) => p.active).length);
    expect(first.items[0].name).toBe("Blue Dream Badder 1g");
    const second = call("search-products", { cursor: first.nextCursor });
    expect(second.items[0].name).not.toBe(first.items[0].name);
    expect(call("search-products", { status: "INACTIVE" }).items.map((p: any) => [p.name, p.isInactive])).toEqual([["Sour Diesel Pre-Roll 5-Pack", true]]);
    expect(call("search-products", { status: "ANY" }).totalCount).toBe(world.products.length);
  });

  test("lists the 13 active pre-rolls across a page boundary", () => {
    const { call } = bench();
    const first = call("search-products", { productCategoryIds: ["cat_2"] });
    expect(first).toMatchObject({ hasMore: true, totalCount: 13 });
    const second = call("search-products", { productCategoryIds: ["2"], cursor: first.nextCursor });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    const all = [...names(first), ...names(second)];
    expect(new Set(all).size).toBe(13);
    expect(all).not.toContain("Sour Diesel Pre-Roll 5-Pack");
    expect(call("search-products", { productCategoryIds: ["cat_2"], status: "ANY" }).totalCount).toBe(14);
    expect(call("search-products", { search: "pre-roll", limit: 100 }).totalCount).toBe(13);
  });

  test("finds Blue Dream 3.5g by name or SKU among the other Blue Dream products", () => {
    const { call } = bench();
    expect(names(call("search-products", { search: "blue dream 3.5g" }))).toEqual(["Blue Dream 3.5g"]);
    expect(names(call("search-products", { search: "FL-1001" }))).toEqual(["Blue Dream 3.5g"]);
    expect(call("search-products", { search: "Blue Dream" }).totalCount).toBe(6);
  });

  test("lists the products below their minimum, counting reserved units out", () => {
    const { call, world } = bench();
    const below = call("search-products", { belowQuantityAvailableThresholdMin: true, sortBy: { field: "QUANTITY_AVAILABLE_THRESHOLD_MIN_RATIO", direction: "ASC" } });
    expect(names(below)).toEqual(["Gelato 3.5g", "Wedding Cake 7g", "Dark Chocolate Bar 100mg", "Blue Dream Cartridge 1g"]);
    expect(names(below).sort()).toEqual(world.products.filter((p) => p.active && belowMinimum(world, p)).map((p) => p.name).sort());
    const cartridge = below.items.at(-1);
    expect(cartridge).toMatchObject({ quantityActive: "110", quantityReserved: "45", quantityAvailable: "65", quantityAvailableThresholdMin: "80" });
    const rest = call("search-products", { belowQuantityAvailableThresholdMin: false, limit: 100 });
    expect(rest.totalCount).toBe(world.products.filter((p) => p.active).length - 4);
    expect(names(rest)).toContain("Milk Chocolate Bar 100mg"); // low stock, but no minimum set
  });

  test("puts products without a minimum last when sorting by the minimum ratio", () => {
    const { call, world } = bench();
    for (const direction of ["ASC", "DESC"]) {
      const items = call("search-products", { limit: 100, sortBy: { field: "QUANTITY_AVAILABLE_THRESHOLD_MIN_RATIO", direction } }).items;
      const withMin = items.filter((p: any) => p.quantityAvailableThresholdMin !== null).length;
      expect(items.slice(withMin).every((p: any) => p.quantityAvailableThresholdMin === null)).toBe(true);
      const ratios = items.slice(0, withMin).map((p: any) => Number(p.quantityAvailable) / Number(p.quantityAvailableThresholdMin));
      expect(ratios).toEqual([...ratios].sort((a, b) => (direction === "ASC" ? a - b : b - a)));
      expect(items).toHaveLength(world.products.filter((p) => p.active).length);
    }
  });

  test("sorts by every documented field the world can order by", () => {
    const { call } = bench();
    const order = (field: string, direction = "ASC") => call("search-products", { limit: 100, sortBy: { field, direction } }).items;
    expect(order("NAME")[0].name).toBe("Blue Dream 1g Pre-Roll");
    expect(order("UNIT_PRICE", "DESC")[0].name).toBe("Jack Herer 14g");
    expect(order("QUANTITY_ACTIVE", "DESC")[0].name).toBe("Jack Herer Pre-Roll 10-Pack");
    expect(order("QUANTITY_AVAILABLE")[0].quantityAvailable).toBe("0");
    expect(order("INSERTED_AT")[0].name).toBe("Blue Dream 3.5g");
    expect(order("UPDATED_AT")[0].name).toBe("Blue Dream 3.5g");
  });

  test("filters by menus, tags, strains, groups, subcategories, vendor, brand and unit type", () => {
    const { call, world } = bench();
    const main = world.menus.find((m) => m.name === "Main Wholesale Menu")!;
    const onMain = call("search-products", { menuIds: [main.id], status: "ANY", limit: 100 });
    expect(onMain.totalCount).toBe(main.products.length);
    const offMain = call("search-products", { notOnMenuIds: [main.id], status: "ANY", limit: 100 });
    expect(offMain.totalCount).toBe(world.products.length - main.products.length);
    expect(names(call("search-products", { tagIds: ["tag_3"] })).sort()).toEqual(["Blue Dream Pre-Roll 5-Pack", "Mango Gummies 100mg"]);
    expect(call("search-products", { strainIds: ["str_1"] }).totalCount).toBe(6);
    expect(call("search-products", { productGroupIds: ["grp_1"], status: "ANY" }).totalCount).toBe(19);
    expect(names(call("search-products", { productSubcategoryIds: ["sub_6"] })).sort()).toEqual(["Gelato Infused Pre-Roll", "OG Kush Infused Pre-Roll", "Sour Diesel Infused Pre-Roll"]);
    const vendor = world.companies.find((c) => c.name === "Sweet Leaf Confections")!;
    expect(call("search-products", { vendorId: vendor.id }).totalCount).toBe(6);
    expect(call("search-products", { brandIds: [vendor.id] }).totalCount).toBe(0);
    expect(call("search-products", { unitTypeCategories: ["COUNT"] }).totalCount).toBe(37);
    expect(call("search-products", { unitTypeCategories: ["WEIGHT"] }).totalCount).toBe(0);
    expect(names(call("search-products", { ids: ["prd_1", "9"] })).sort()).toEqual(["Blue Dream 1g Pre-Roll", "Blue Dream 3.5g"]);
  });

  test("prints quantities, potency and classification from the world", () => {
    const { call } = bench();
    const [p] = call("search-products", { search: "Blue Dream 3.5g" }).items;
    expect(p).toMatchObject({
      quantityActive: "70", quantityAvailable: "70", quantityReserved: "0", quantityActivePassedTesting: null, inventoryTrackingMethod: "BATCH",
      totalThc: "24.6", totalCannabinoidUnit: "PERCENT", category: { id: "cat_1", name: "Flower" }, subcategory: { id: "sub_1", name: "Eighths" },
      strain: { id: "str_1", name: "Blue Dream" }, tags: [{ id: "tag_1", name: "Best seller" }], unitPrice: "22.00",
    });
    expect(p.activeQuantitiesByLocation).toEqual([{ location: { id: "loc_1", name: "Vault" }, quantity: "60" }, { location: { id: "loc_2", name: "Shipping Room" }, quantity: "10" }]);
    expect(p.customFields).toEqual([{ customField: { id: "cf_1", name: "Shelf life", fieldType: "TEXT" }, value: null }]);
    const [packaged] = call("search-products", { search: "Blue Dream 7g" }).items;
    expect(packaged.quantityActivePassedTesting).toBe(packaged.quantityActive);
    const [gummies] = call("search-products", { search: "Mango Gummies" }).items;
    expect(gummies).toMatchObject({ totalThc: null, totalCannabinoidUnit: null, quantityActive: "0", activeQuantitiesByLocation: [] });
  });

  test("refuses wrong ids and inputs the world does not implement", () => {
    const { error } = bench();
    expect(error("search-products", { productCategoryIds: ["tag_2"] })).toContain("tool_error");
    expect(error("search-products", { limit: 500 })).toContain("tool_error");
    expect(error("search-products", { cursor: "nope!" })).toContain("tool_error");
    expect(error("search-products", { customFields: [{ customFieldId: "cf_1", contains: "x" }] })).toContain("unsupported_input");
    expect(error("search-products", { hasBillOfMaterials: true })).toContain("unsupported_input");
  });
});

describe("get-product", () => {
  test("returns one product, with each include switch adding its part", () => {
    const { call, world } = bench();
    const bare = call("get-product", { id: "prd_1" }).product;
    expect(bare).toMatchObject({ name: "Blue Dream 3.5g", quantityActive: "70", menuVisibility: "INCLUDE_IN_SELECT" });
    expect(bare.tags).toBeUndefined();
    expect(bare.activeQuantitiesByLocation).toBeUndefined();
    expect(bare.menus.map((m: any) => m.id).sort()).toEqual(world.menus.filter((m) => m.products.some((x) => x.productId === "prd_1")).map((m) => m.id).sort());
    const full = call("get-product", {
      id: "1", includeImages: true, includeTags: true, includeActiveQuantitiesByLocation: true, includeActiveQuantityCostItems: true, includeBillOfMaterials: true,
    }).product;
    expect(full).toMatchObject({ images: [], tags: [{ id: "tag_1", name: "Best seller" }], activeQuantityCostItems: null, billOfMaterials: null });
    expect(full.activeQuantitiesByLocation).toEqual([{ location: { id: "loc_1", name: "Vault" }, quantity: "60" }, { location: { id: "loc_2", name: "Shipping Room" }, quantity: "10" }]);
  });

  test("returns null for an unknown id and refuses an id of another kind", () => {
    const { call, error } = bench();
    expect(call("get-product", { id: "prd_999" }).product).toBeNull();
    expect(error("get-product", { id: "com_1" })).toContain("tool_error");
    expect(error("get-product")).toContain("invalid_arguments");
  });
});

describe("bulk-update-products", () => {
  const activePrerolls = (world: ReturnType<typeof bench>["world"]) => world.products.filter((p) => p.categoryId === "cat_2" && p.active);

  test("tags every pre-roll as Summer promo, keeping their other tags", () => {
    const { call, world } = bench();
    const prerolls = activePrerolls(world);
    const before = new Map(prerolls.map((p) => [p.id, [...p.tagIds]]));
    const result = call("bulk-update-products", { ids: prerolls.map((p) => p.id), addTagIds: ["tag_3"] });
    expect(result.products).toHaveLength(13);
    for (const p of prerolls) expect(p.tagIds).toEqual([...new Set([...before.get(p.id)!, "tag_3"])]);
    expect(world.products.find((p) => p.name === "OG Kush Infused Pre-Roll")!.tagIds).toEqual(["tag_2", "tag_1", "tag_3"]);
    expect(world.products.find((p) => p.name === "Sour Diesel Pre-Roll 5-Pack")!.tagIds).toEqual([]);
    expect(call("search-products", { tagIds: ["tag_3"], productCategoryIds: ["cat_2"] }).totalCount).toBe(13);
    // One write, logging only the 12 pre-rolls that did not carry the tag yet.
    const action = world.actions.at(-1)!;
    expect(action.source).toBe("MCP");
    expect(action.records).toHaveLength(12);
    expect(action.records[0]!.fields[0]).toMatchObject({ field: "tagIds", label: "Tags" });
    const untouched = world.products.find((p) => p.name === "Blue Dream Pre-Roll 5-Pack")!;
    expect(untouched.updatedAt).toBe("2025-04-28T10:00:00-07:00");
  });

  test("replaces the whole tag list with tagIds, and removes tags with removeTagIds", () => {
    const { call, world } = bench();
    const ids = ["prd_15", "prd_19"];
    call("bulk-update-products", { ids, tagIds: ["tag_3"] });
    expect(ids.map((id) => world.products.find((p) => p.id === id)!.tagIds)).toEqual([["tag_3"], ["tag_3"]]);
    call("bulk-update-products", { ids, tagIds: ["tag_1", "tag_2"] });
    call("bulk-update-products", { ids, removeTagIds: ["tag_1"], addTagIds: ["tag_5"] });
    expect(ids.map((id) => world.products.find((p) => p.id === id)!.tagIds)).toEqual([["tag_2", "tag_5"], ["tag_2", "tag_5"]]);
    call("bulk-update-products", { ids, tagIds: [] });
    expect(ids.map((id) => world.products.find((p) => p.id === id)!.tagIds)).toEqual([[], []]);
  });

  test("refuses the whole save when it lists an inactive product, unless includeInactive is set", () => {
    const { call, error, world } = bench();
    const all = world.products.filter((p) => p.categoryId === "cat_2").map((p) => p.id);
    const before = JSON.stringify(world.products);
    const message = error("bulk-update-products", { ids: all, addTagIds: ["tag_3"] });
    expect(message).toContain("tool_error");
    expect(message).toContain("Sour Diesel Pre-Roll 5-Pack");
    expect(JSON.stringify(world.products)).toBe(before);
    call("bulk-update-products", { ids: all, addTagIds: ["tag_3"], includeInactive: true });
    expect(world.products.filter((p) => p.categoryId === "cat_2").every((p) => p.tagIds.includes("tag_3"))).toBe(true);
  });

  test("changes prices, costs, thresholds and classification on every product listed", () => {
    const { call, world } = bench();
    call("bulk-update-products", {
      ids: ["prd_9", "prd_10"], unitPrice: "6.25", unitCost: 3, quantityAvailableThresholdMin: 50, quantityAvailableThresholdMax: "900",
      categoryId: "cat_2", subcategoryId: "sub_5", groupId: null, strainId: "str_3", brandId: "com_6", vendorId: "com_1",
    });
    for (const id of ["prd_9", "prd_10"]) {
      expect(world.products.find((p) => p.id === id)).toMatchObject({
        unitPrice: 6.25, unitCost: 3, thresholdMin: 50, thresholdMax: 900, subcategoryId: "sub_5", groupId: null, strainId: "str_3", brandId: "com_6", vendorId: "com_1",
      });
    }
    expect(call("get-product", { id: "prd_9" }).product).toMatchObject({ unitPrice: "6.25", brand: { id: "com_6", name: "Pacific Coast Prerolls" }, group: null });
  });

  test("refuses what the documentation refuses, leaving the world untouched", () => {
    const { error, world } = bench();
    const before = JSON.stringify(world);
    expect(error("bulk-update-products", { ids: ["prd_9", "prd_999"], addTagIds: ["tag_3"] })).toContain("prd_999");
    expect(error("bulk-update-products", { ids: ["prd_9"], addTagIds: ["tag_99"] })).toContain("tool_error");
    expect(error("bulk-update-products", { ids: ["prd_9"], categoryId: "cat_1" })).toContain("subcategoryId");
    expect(error("bulk-update-products", { ids: ["prd_9"], categoryId: "cat_1", subcategoryId: "sub_5" })).toContain("does not belong");
    expect(error("bulk-update-products", { ids: ["prd_9"], quantityAvailableThresholdMax: 10 })).toContain("below the high-stock alert");
    expect(error("bulk-update-products", { ids: ["prd_9"], tagIds: ["tag_1"], addTagIds: ["tag_3"] })).toContain("tool_error");
    expect(error("bulk-update-products", { ids: ["prd_9"], addTagIds: ["tag_3"], removeTagIds: ["tag_3"] })).toContain("tool_error");
    expect(error("bulk-update-products", { ids: ["prd_9"], unitPrice: "cheap" })).toContain("tool_error");
    expect(error("bulk-update-products", { ids: [] })).toContain("tool_error");
    expect(error("bulk-update-products", { ids: ["prd_9"], addMenuIds: ["men_1"] })).toContain("unsupported_input");
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("mutate-product", () => {
  test("updates the fields the world models and logs the change", () => {
    const { call, world } = bench();
    const { product } = call("mutate-product", {
      action: "UPDATE", id: "prd_1", name: "Blue Dream 3.5g Jar", sku: "FL-9001", unitPrice: 23, unitCost: "15.10", quantityAvailableThresholdMin: 30,
      quantityAvailableThresholdMax: 300, categoryId: "cat_1", subcategoryId: "sub_2", tagIds: ["tag_3"], isInactive: true, strainId: null,
    });
    expect(product).toMatchObject({
      name: "Blue Dream 3.5g Jar", sku: "FL-9001", unitPrice: "23.00", unitCost: "15.10", quantityAvailableThresholdMin: "30", quantityAvailableThresholdMax: "300",
      subcategory: { id: "sub_2", name: "Quarters" }, tags: [{ id: "tag_3", name: "Summer promo" }], isInactive: true, strain: null,
    });
    const action = world.actions.at(-1)!;
    expect(action.records).toHaveLength(1);
    expect(action.records[0]!.fields.find((f) => f.field === "unitPrice")).toEqual({ field: "unitPrice", label: "Unit price", oldValue: "22.00", newValue: "23.00" });
    expect(action.records[0]!.fields.find((f) => f.field === "categoryId")).toBeUndefined(); // unchanged
    expect(product.updatedAt).toBe(action.changedAt);
  });

  test("changes nothing and logs nothing when the values are already set", () => {
    const { call, world } = bench();
    const actions = world.actions.length;
    call("mutate-product", { action: "UPDATE", id: "prd_1", unitPrice: "22", tagIds: ["tag_1"] });
    expect(world.actions).toHaveLength(actions);
  });

  test("refuses CREATE, DELETE and invalid updates", () => {
    const { error, world } = bench();
    const before = JSON.stringify(world);
    expect(error("mutate-product", { action: "CREATE", name: "New", sku: "X", categoryId: "cat_1", vendorId: "com_1", unitPrice: 1 })).toContain("only UPDATE");
    expect(error("mutate-product", { action: "DELETE", id: "prd_8" })).toContain("isInactive");
    expect(error("mutate-product", { action: "UPDATE" })).toContain("id is required");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_999", name: "X" })).toContain("No product found");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", name: "Blue Dream 7g" })).toContain("already named");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", sku: "fl-1002" })).toContain("SKU");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", name: "Blue [Dream]" })).toContain("cannot contain");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", categoryId: "cat_2" })).toContain("does not belong");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", unitCost: null })).toContain("tool_error");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", unitPrice: -1 })).toContain("tool_error");
    expect(error("mutate-product", { action: "UPDATE", id: "prd_1", description: "x" })).toContain("unsupported_input");
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("search-lookups", () => {
  test("lists categories with their subcategories, A to Z, 100 to a page", () => {
    const { call } = bench();
    const cats = call("search-lookups", { type: "PRODUCT_CATEGORY" });
    expect(names(cats)).toEqual(["Concentrates", "Edibles", "Flower", "Pre-Rolls", "Vapes"]);
    expect(cats.items[3].subcategories).toEqual([{ id: "sub_4", name: "Singles" }, { id: "sub_5", name: "Multi-packs" }, { id: "sub_6", name: "Infused" }]);
    expect(names(call("search-lookups", { type: "PRODUCT_CATEGORY", search: "infused" }))).toEqual(["Pre-Rolls"]);
    expect(names(call("search-lookups", { type: "PRODUCT_CATEGORY", search: "pre-roll" }))).toEqual(["Pre-Rolls"]);
  });

  test("resolves tags, groups, strains, unit types, payment methods and terms, and company groups", () => {
    const { call } = bench();
    expect(call("search-lookups", { type: "PRODUCT_TAG", search: "summer" }).items).toEqual([{ id: "tag_3", name: "Summer promo" }]);
    expect(names(call("search-lookups", { type: "PRODUCT_TAG" }))).toEqual(["Staff pick", "Clearance", "Summer promo", "New arrival", "Best seller"]);
    expect(names(call("search-lookups", { type: "PRODUCT_GROUP", sortBy: { field: "NAME", direction: "ASC" } }))).toEqual(["House brand", "Partner brands"]);
    expect(call("search-lookups", { type: "STRAIN", search: "blue" }).items).toEqual([{ id: "str_1", name: "Blue Dream", strainType: "HYBRID" }]);
    expect(call("search-lookups", { type: "UNIT_TYPE", unitTypeCategories: ["WEIGHT"] }).items).toEqual([{ id: "unt_2", name: "Gram", category: "WEIGHT", active: true, locked: true }]);
    expect(call("search-lookups", { type: "UNIT_TYPE", status: "INACTIVE" }).items).toEqual([]);
    expect(call("search-lookups", { type: "PAYMENT_METHOD", search: "ach" }).items).toEqual([{ id: "pmm_1", name: "ACH" }]);
    expect(call("search-lookups", { type: "PAYMENT_TERM", ids: ["ptm_1", "ptm_99"] }).items).toEqual([{ id: "ptm_1", name: "Net 30", days: 30 }]);
    expect(call("search-lookups", { type: "COMPANY_GROUP", search: "bay" }).items).toEqual([{ id: "cgr_1", name: "Bay Area" }]);
  });

  test("pages, and lists nothing for the types the world has no values for", () => {
    const { call } = bench();
    const first = call("search-lookups", { type: "PRODUCT_TAG", limit: 2 });
    expect(first).toMatchObject({ hasMore: true, totalCount: 5 });
    const rest = call("search-lookups", { type: "PRODUCT_TAG", limit: 3, cursor: first.nextCursor });
    expect(rest.hasMore).toBe(false);
    expect([...names(first), ...names(rest)]).toHaveLength(5);
    for (const type of ["RELATIONSHIP_TYPE", "COST_TYPE", "TAX", "CHARGE_PRESET", "LICENSE_TYPE", "COMPANY_CATEGORY"]) {
      expect(call("search-lookups", { type })).toEqual({ items: [], hasMore: false, totalCount: 0 });
    }
    expect(call("search-lookups", { type: "CHARGE_PRESET", chargeTypes: ["DISCOUNT"] }).items).toEqual([]);
  });

  test("refuses inputs on the types they do not apply to", () => {
    const { error } = bench();
    expect(error("search-lookups", { type: "PRODUCT_TAG", status: "ANY" })).toContain("tool_error");
    expect(error("search-lookups", { type: "PAYMENT_METHOD", ids: ["pmm_1"] })).toContain("tool_error");
    expect(error("search-lookups", { type: "TAX", search: "excise" })).toContain("tool_error");
    expect(error("search-lookups", { type: "STRAIN", unitTypeCategories: ["COUNT"] })).toContain("tool_error");
    expect(error("search-lookups", { type: "PRODUCT_TAG", chargeTypes: ["CHARGE"] })).toContain("tool_error");
    expect(error("search-lookups", { type: "LICENSE_TYPE", sortBy: { field: "NAME", direction: "ASC" } })).toContain("tool_error");
    expect(error("search-lookups", { type: "PRODUCT_TAG", ids: ["grp_1"] })).toContain("tool_error");
    expect(error("search-lookups")).toContain("invalid_arguments");
  });
});

describe("create-reference-type", () => {
  test("adds tags, groups, categories, subcategories, payment methods and company groups", () => {
    const { call, world } = bench();
    expect(call("create-reference-type", { type: "PRODUCT_TAG", name: "Holiday" })).toEqual({ tag: { id: "tag_6", name: "Holiday" } });
    expect(call("search-lookups", { type: "PRODUCT_TAG", search: "holiday" }).items).toEqual([{ id: "tag_6", name: "Holiday" }]);
    expect(call("create-reference-type", { type: "PRODUCT_GROUP", name: "Craft" }).productGroup.name).toBe("Craft");
    expect(call("create-reference-type", { type: "COMPANY_GROUP", name: "bay area" }).companyGroup.name).toBe("bay area");
    expect(call("create-reference-type", { type: "PAYMENT_METHOD", name: "Wire", paymentMethodType: "BANK_TRANSFER" }).paymentMethod).toMatchObject({ name: "Wire", type: "BANK_TRANSFER" });
    const cat = call("create-reference-type", { type: "PRODUCT_CATEGORY", name: "Infused Flower", officialProductCategoryId: "FLOWER" }).productCategory;
    expect(cat).toMatchObject({ name: "Infused Flower", officialProductCategoryId: "FLOWER" });
    const sub = call("create-reference-type", { type: "PRODUCT_SUBCATEGORY", name: "Singles", productCategoryId: cat.id }).productSubcategory;
    expect(sub.category).toEqual({ id: cat.id });
    expect(world.categories.find((c) => c.id === cat.id)!.subcategories).toEqual([{ id: sub.id, name: "Singles" }]);
    expect(world.actions.at(-1)!.records[0]).toMatchObject({ type: "PRODUCT_SUBCATEGORY", op: "INSERT", name: "Singles" });
  });

  test("refuses duplicates, misplaced or missing extra inputs, and overlong names", () => {
    const { error, world } = bench();
    const before = JSON.stringify(world);
    expect(error("create-reference-type", { type: "PRODUCT_TAG", name: "summer PROMO" })).toContain("already exists");
    expect(error("create-reference-type", { type: "PRODUCT_SUBCATEGORY", name: "infused", productCategoryId: "cat_2" })).toContain("already exists");
    expect(error("create-reference-type", { type: "PAYMENT_METHOD", name: "Wire" })).toContain("paymentMethodType is required");
    expect(error("create-reference-type", { type: "PRODUCT_TAG", name: "X", officialProductCategoryId: "FLOWER" })).toContain("only taken by type PRODUCT_CATEGORY");
    expect(error("create-reference-type", { type: "PAYMENT_METHOD", name: "x".repeat(32), paymentMethodType: "CASH" })).toContain("31");
    expect(error("create-reference-type", { type: "PRODUCT_TAG", name: "  " })).toContain("blank");
    expect(error("create-reference-type", { type: "PRODUCT_CATEGORY", name: "Balms", officialProductCategoryId: "TOPICALS" })).toContain("tool_error");
    expect(error("create-reference-type", { type: "RELATIONSHIP_TYPE", name: "Prospect" })).toContain("tool_error");
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("custom fields", () => {
  test("search-custom-fields lists, filters, sorts and pages", () => {
    const { call } = bench();
    expect(names(call("search-custom-fields"))).toEqual(["Delivery window", "Storage zone", "Shelf life"]);
    const [storage] = call("search-custom-fields", { entityType: "PACKAGE" }).items;
    expect(storage).toEqual({
      id: "cf_2", name: "Storage zone", description: null, entityType: "PACKAGE", fieldType: "DROPDOWN", required: false, filterable: false,
      options: [{ name: "Ambient", disabled: false }, { name: "Cold", disabled: false }],
    });
    expect(names(call("search-custom-fields", { search: "best-by" }))).toEqual(["Shelf life"]);
    expect(names(call("search-custom-fields", { ids: ["cf_1", "3"], sortBy: { field: "NAME", direction: "ASC" } }))).toEqual(["Delivery window", "Shelf life"]);
    const first = call("search-custom-fields", { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(call("search-custom-fields", { limit: 2, cursor: first.nextCursor }).items).toHaveLength(1);
  });

  test("create-custom-field adds the Lab dropdown to packages", () => {
    const { call, world } = bench();
    const { customField } = call("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "DROPDOWN", options: ["SC Labs", "Steep Hill"] });
    expect(customField).toMatchObject({ name: "Lab", entityType: "PACKAGE", fieldType: "DROPDOWN", required: false, description: null });
    expect(customField.options).toEqual([{ name: "SC Labs", disabled: false }, { name: "Steep Hill", disabled: false }]);
    expect(world.customFields.at(-1)).toMatchObject({ id: customField.id, entityType: "PACKAGE", options: ["SC Labs", "Steep Hill"] });
    expect(call("search-custom-fields", { entityType: "PACKAGE" }).totalCount).toBe(2);
    expect(world.actions.at(-1)!.records[0]).toMatchObject({ type: "CUSTOM_FIELD", op: "INSERT", name: "Lab" });
    const text = call("create-custom-field", { entityType: "PRODUCT", name: "Lab", fieldType: "TEXT", description: "Testing lab", required: true });
    expect(text.customField).toMatchObject({ options: [], required: true, description: "Testing lab" });
    expect(call("get-product", { id: "prd_1" }).product.customFields.map((f: any) => f.customField.name)).toEqual(["Shelf life", "Lab"]);
  });

  test("create-custom-field refuses what the documentation refuses", () => {
    const { error, world } = bench();
    const before = JSON.stringify(world);
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "storage zone", fieldType: "TEXT" })).toContain("already has");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "DROPDOWN" })).toContain("options");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "CHECKBOX", options: [] })).toContain("options");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "TEXT", options: ["SC Labs"] })).toContain("only for DROPDOWN");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "DROPDOWN", options: ["SC Labs", "SC Labs"] })).toContain("twice");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "DROPDOWN", options: ["SC Labs, Inc."] })).toContain("commas");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "x".repeat(71), fieldType: "TEXT" })).toContain("70");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab", fieldType: "TEXT", description: "x".repeat(101) })).toContain("100");
    expect(error("create-custom-field", { entityType: "PACKAGE", name: "Lab" })).toContain("invalid_arguments");
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("search-price-tiers", () => {
  test("lists no tiers, whatever the filters, and still refuses wrong input", () => {
    const { call, error } = bench();
    expect(call("search-price-tiers")).toEqual({ items: [], hasMore: false, totalCount: 0 });
    expect(call("search-price-tiers", {
      limit: 5, ids: ["1"], search: "bulk", customerIds: ["com_7"], customerGroupIds: ["cgr_1"], productIds: ["prd_1"], productTagIds: ["tag_1"],
      productCategoryIds: ["cat_1"], productSubcategoryIds: ["sub_1"], productGroupIds: ["grp_1"], brandIds: ["com_1"], menuIds: ["men_1"],
      validAt: "2026-11-23T10:00:00-08:00", pricingType: "PERCENT_OFF", ownerIds: ["usr_1"], includeDeleted: true, sortBy: { field: "NAME", direction: "ASC" },
    }).items).toEqual([]);
    expect(error("search-price-tiers", { customerIds: ["prd_1"] })).toContain("tool_error");
    expect(error("search-price-tiers", { validAt: "2026-11-23" })).toContain("tool_error");
    expect(error("search-price-tiers", { limit: 0 })).toContain("tool_error");
  });
});
