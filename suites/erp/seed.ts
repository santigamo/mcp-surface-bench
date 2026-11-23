// Builds the benchmark company as of a given day. Everything is derived from that day and a fixed random
// seed, so the same day always gives the same world, and "yesterday" or "last quarter" always have data.
import { addDays, isoIn, zoned } from "../../src/core/kit.ts";
import {
  PREFIX, orderTotal, purchaseTotal,
  type Action, type ActionRow, type Batch, type Company, type Contact, type Id, type Product, type PurchaseOrder, type RecordType, type RowEntity, type SalesOrder, type World,
} from "./world.ts";

export const TIMEZONE = "America/Los_Angeles";

/** The instant a run on `today` happens: mid-morning, company time. */
export const clock = (today: string) => zoned(TIMEZONE, today, "10:00:00");

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** First and last day of the calendar quarter `back` quarters before the one `today` is in. */
export function quarter(today: string, back: number): { start: string; end: string } {
  const y = +today.slice(0, 4), q = Math.floor((+today.slice(5, 7) - 1) / 3) - back;
  const year = y + Math.floor(q / 4), idx = ((q % 4) + 4) % 4;
  const start = `${year}-${String(idx * 3 + 1).padStart(2, "0")}-01`;
  const nextStart = idx === 3 ? `${year + 1}-01-01` : `${year}-${String(idx * 3 + 4).padStart(2, "0")}-01`;
  return { start, end: addDays(nextStart, -1) };
}

/** First and last day of the calendar month before the one `today` is in. */
export function lastMonth(today: string): { start: string; end: string } {
  const first = `${today.slice(0, 7)}-01`;
  const end = addDays(first, -1);
  return { start: `${end.slice(0, 7)}-01`, end };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function createWorld(today: string): World {
  const rand = mulberry32(20260923);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  /** A company-time instant on a calendar day. */
  const on = (ymd: string, time = "10:00:00") => isoIn(TIMEZONE, zoned(TIMEZONE, ymd, time));
  const ago = (days: number, time?: string) => on(addDays(today, -days), time);

  const counters: Record<string, number> = {};
  const id = (prefix: string): Id => `${prefix}_${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;

  // ---------- people and places ----------
  const users = [
    ["Maya", "Okafor", "Operations Manager"], ["Daniel", "Reyes", "Account Executive"], ["Priya", "Nair", "Account Executive"],
    ["Tom", "Becker", "Purchasing Manager"], ["Lena", "Hartmann", "Compliance Manager"],
  ].map(([firstName, lastName, role]) => ({ id: id(PREFIX.user), firstName: firstName!, lastName: lastName!, role: role!, email: `${firstName!.toLowerCase()}@tidewatercannabis.example` }));
  const [maya, daniel, priya, tom, lena] = users as [typeof users[0], typeof users[0], typeof users[0], typeof users[0], typeof users[0]];

  const licenses = [
    { id: id(PREFIX.license), licenseNumber: "C11-0000482-LIC", name: "Tidewater Distribution", kind: "DISTRIBUTION" as const, complianceType: "METRC" as const, active: true, expiryDate: addDays(today, 240) },
    { id: id(PREFIX.license), licenseNumber: "CCL19-0003371", name: "Tidewater Cultivation", kind: "CULTIVATION" as const, complianceType: "METRC" as const, active: true, expiryDate: addDays(today, 310) },
  ];
  const [dist, cult] = licenses as [typeof licenses[0], typeof licenses[0]];
  const locations = [["Vault", dist], ["Shipping Room", dist], ["Processing Room", dist], ["Flower Room A", cult], ["Veg Room", cult], ["Dry Room", cult]]
    .map(([name, lic]) => ({ id: id(PREFIX.location), name: name as string, licenseId: (lic as typeof dist).id }));
  const [vault, shipping, , flowerRoom, vegRoom, dryRoom] = locations as [typeof locations[0], typeof locations[0], typeof locations[0], typeof locations[0], typeof locations[0], typeof locations[0]];

  // ---------- lookups ----------
  const named = (prefix: string, names: string[]) => names.map((name) => ({ id: id(prefix), name }));
  const categories = ([["Flower", "FLOWER", ["Eighths", "Quarters", "Half ounces"]], ["Pre-Rolls", "PREROLLS", ["Singles", "Multi-packs", "Infused"]], ["Edibles", "EDIBLES", ["Gummies", "Chocolates"]], ["Vapes", "VAPES", ["Cartridges", "Disposables"]], ["Concentrates", "CONCENTRATES", ["Live Resin", "Rosin"]]] as const)
    .map(([name, official, subs]) => ({ id: id(PREFIX.category), name, official, subcategories: named(PREFIX.subcategory, [...subs]) }));
  const tags = named(PREFIX.tag, ["Best seller", "New arrival", "Summer promo", "Clearance", "Staff pick"]);
  const [bestSeller, newArrival, summerPromo] = tags as [typeof tags[0], typeof tags[0], typeof tags[0]];
  const groups = named(PREFIX.group, ["House brand", "Partner brands"]);
  const strains = ([["Blue Dream", "HYBRID"], ["Wedding Cake", "INDICA"], ["Gelato", "HYBRID"], ["Sour Diesel", "SATIVA"], ["OG Kush", "INDICA"], ["Jack Herer", "SATIVA"]] as const)
    .map(([name, strainType]) => ({ id: id(PREFIX.strain), name, strainType }));
  const unitTypes = [{ id: id(PREFIX.unitType), name: "Each", category: "COUNT" as const }, { id: id(PREFIX.unitType), name: "Gram", category: "WEIGHT" as const }];
  const paymentMethods = named(PREFIX.paymentMethod, ["ACH", "Check", "Cash"]);
  const paymentTerms = [["Net 30", 30], ["Net 15", 15], ["Due on receipt", 0]].map(([name, days]) => ({ id: id(PREFIX.paymentTerm), name: name as string, days: days as number }));
  const companyGroups = named(PREFIX.companyGroup, ["Bay Area", "Southern California", "Central Coast"]);
  const customFields = [
    { id: id(PREFIX.customField), entityType: "PRODUCT", name: "Shelf life", fieldType: "TEXT" as const, description: "Months until best-by", required: false, options: [] },
    { id: id(PREFIX.customField), entityType: "PACKAGE", name: "Storage zone", fieldType: "DROPDOWN" as const, description: null, required: false, options: ["Ambient", "Cold"] },
    { id: id(PREFIX.customField), entityType: "COMPANY", name: "Delivery window", fieldType: "TEXT" as const, description: null, required: false, options: [] },
  ];

  // ---------- companies and contacts ----------
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "");
  const companies: Company[] = [];
  const contacts: Contact[] = [];
  const addCompany = (name: string, relationship: "CUSTOMER" | "VENDOR", ownerId: Id, city: string, people: [string, string, string][], invoiceTo = 1): Company => {
    const c: Company = {
      id: id(PREFIX.company), name, legalName: `${name} LLC`, relationship, ownerId, invoiceEmail: null, phone: `(415) 555-${String(1000 + companies.length * 37).slice(-4)}`,
      city, state: "CA", zip: String(94000 + companies.length * 13), licenseNumber: `C10-${String(1000100 + companies.length * 7)}-LIC`,
      groupId: relationship === "CUSTOMER" ? companyGroups[companies.length % 3]!.id : null, paymentTermId: paymentTerms[0]!.id, createdAt: ago(900 - companies.length * 11),
    };
    people.forEach(([first, last, title], i) => {
      const email = `${first.toLowerCase()}.${last.toLowerCase()}@${slug(name)}.example`;
      contacts.push({ id: id(PREFIX.contact), companyId: c.id, firstName: first, lastName: last, title, email, phone: null, ownerId, createdAt: c.createdAt });
      if (i === Math.min(invoiceTo, people.length - 1)) c.invoiceEmail = email;
    });
    companies.push(c);
    return c;
  };

  const vendors = [
    addCompany("Humboldt Family Farms", "VENDOR", tom.id, "Arcata", [["Caleb", "Stone", "Sales Manager"]]),
    addCompany("Mendocino Gold Growers", "VENDOR", tom.id, "Ukiah", [["Rosa", "Delgado", "Owner"]]),
    addCompany("Sierra Extracts", "VENDOR", tom.id, "Sacramento", [["Evan", "Park", "Account Manager"]]),
    addCompany("Sweet Leaf Confections", "VENDOR", tom.id, "Oakland", [["Nina", "Abbott", "Sales Manager"]]),
    addCompany("Cali Vape Works", "VENDOR", tom.id, "Long Beach", [["Omar", "Haddad", "Account Manager"]]),
    addCompany("Pacific Coast Prerolls", "VENDOR", tom.id, "Santa Cruz", [["Jill", "Tanaka", "Owner"]]),
  ];
  const [humboldt, mendocino, sierraExtracts, sweetLeaf, caliVape, pacificPrerolls] = vendors as [Company, Company, Company, Company, Company, Company];

  // Customers in the order of their revenue last quarter (thousands of dollars), which the top-10 question ranks.
  const customerPlan: [string, number, Id, string, [string, string, string][], number?][] = [
    ["Greenleaf Collective", 104, daniel.id, "Oakland", [["Hannah", "Voss", "Buyer"], ["Peter", "Lam", "Accounts Payable"]]],
    ["Harbor Lights Cannabis", 88, priya.id, "San Diego", [["Andre", "Mills", "Buyer"], ["Sofia", "Ruiz", "Accounts Payable"]]],
    ["Pacific Bloom", 79, daniel.id, "Santa Barbara", [["Kira", "Novak", "Purchasing Manager"]]],
    ["Golden Gate Greens", 71, priya.id, "San Francisco", [["Leo", "Marsh", "Buyer"], ["Tessa", "Ong", "Accounts Payable"]]],
    ["Sunset Dispensary", 64, daniel.id, "San Francisco", [["Marcus", "Bell", "Buyer"], ["Dana", "Whitlock", "Accounts Payable"]]],
    ["Redwood Remedies", 57, priya.id, "Eureka", [["Owen", "Hale", "Buyer"]]],
    ["Bayside Botanicals", 51, daniel.id, "Berkeley", [["Noah", "Kim", "Buyer"], ["Grace", "Lin", "Accounts Payable"]], 0],
    ["High Tide Wellness", 45, priya.id, "Ventura", [["Ruth", "Ibarra", "Buyer"]]],
    ["Canyon Cannabis Club", 40, maya.id, "Palm Springs", [["Felix", "Amato", "General Manager"]]],
    ["Emerald Coast Dispensary", 35, daniel.id, "Monterey", [["Zoe", "Pruitt", "Buyer"], ["Sam", "Odell", "Accounts Payable"]]],
    ["Laurel Canyon Collective", 27, priya.id, "Los Angeles", [["Iris", "Bauer", "Buyer"]]],
    ["Marina Green Dispensary", 22, daniel.id, "San Francisco", [["Theo", "Grant", "Buyer"]]],
    ["Topanga Wellness", 17, priya.id, "Topanga", [["Mila", "Soto", "Owner"]]],
    ["Sierra Vista Cannabis", 12, maya.id, "Fresno", [["Jonah", "Reid", "Buyer"]]],
    ["Sunset Wellness Collective", 9, priya.id, "Los Angeles", [["Irene", "Castillo", "Buyer"], ["Paul", "Dunn", "Accounts Payable"]]],
    ["Mesa Verde Dispensary", 6, daniel.id, "Costa Mesa", [["Carla", "Nunez", "Buyer"]]],
    ["Coastal Roots", 0, priya.id, "Santa Cruz", [["Derek", "Shaw", "Buyer"]]],
    ["Ojai Valley Collective", 0, daniel.id, "Ojai", [["Wren", "Abel", "Buyer"]]],
  ];
  const customers = customerPlan.map(([name, , owner, city, people, invoiceTo]) => addCompany(name, "CUSTOMER", owner, city, people, invoiceTo));
  const customer = (name: string) => customers.find((c) => c.name === name)!;

  // ---------- products ----------
  const [flower, prerolls, edibles, vapes, concentrates] = categories as [typeof categories[0], typeof categories[0], typeof categories[0], typeof categories[0], typeof categories[0]];
  const margin = new Map([[flower.id, 0.36], [prerolls.id, 0.46], [edibles.id, 0.54], [vapes.id, 0.41], [concentrates.id, 0.31]]);
  const strainOf = (name: string) => strains.find((s) => name.startsWith(s.name))?.id ?? null;
  const products: Product[] = [];
  const addProduct = (name: string, cat: typeof flower, sub: number, price: number, tracking: Product["tracking"], vendor: Company, thc: number | null, extra: Partial<Product> = {}) => {
    const cost = Math.round(price * (1 - margin.get(cat.id)! + (rand() - 0.5) * 0.06) * 100) / 100;
    const created = ago(700 - products.length * 9);
    products.push({
      id: id(PREFIX.product), name, sku: `${cat.name.slice(0, 2).toUpperCase()}-${String(1001 + products.length)}`, active: true, categoryId: cat.id, subcategoryId: cat.subcategories[sub]!.id,
      strainId: strainOf(name), brandId: null, vendorId: vendor.id, groupId: groups[products.length % 2]!.id, tagIds: [], unitTypeId: unitTypes[0]!.id, tracking,
      unitPrice: price, unitCost: cost, thresholdMin: null, thresholdMax: null, reserved: 0, thcPercent: thc, stock: [], createdAt: created, updatedAt: created, ...extra,
    });
  };
  ([["Blue Dream 3.5g", 0, 22, 24.6, "BATCH"], ["Blue Dream 7g", 1, 40, 24.6, "PACKAGE"], ["Wedding Cake 3.5g", 0, 24, 27.1, "PACKAGE"], ["Wedding Cake 7g", 1, 44, 27.1, "PACKAGE"],
    ["Gelato 3.5g", 0, 23, 25.9, "PACKAGE"], ["Sour Diesel 3.5g", 0, 21, 22.8, "PACKAGE"], ["OG Kush 3.5g", 0, 22, 25.3, "PACKAGE"], ["Jack Herer 14g", 2, 70, 19.4, "PACKAGE"]] as const)
    .forEach(([n, sub, price, thc, tracking]) => addProduct(n, flower, sub, price, tracking, rand() < 0.5 ? humboldt : mendocino, thc));
  ([["Blue Dream 1g Pre-Roll", 0, 5.5], ["Wedding Cake 1g Pre-Roll", 0, 5.5], ["Gelato 1g Pre-Roll", 0, 5.5], ["Sour Diesel 1g Pre-Roll", 0, 5], ["OG Kush 1g Pre-Roll", 0, 5.5], ["Jack Herer 1g Pre-Roll", 0, 5],
    ["Blue Dream Pre-Roll 5-Pack", 1, 22], ["Gelato Pre-Roll 5-Pack", 1, 22], ["Wedding Cake Pre-Roll 5-Pack", 1, 23], ["Sour Diesel Infused Pre-Roll", 2, 9], ["OG Kush Infused Pre-Roll", 2, 9.5],
    ["Gelato Infused Pre-Roll", 2, 9.5], ["Jack Herer Pre-Roll 10-Pack", 1, 38], ["Sour Diesel Pre-Roll 5-Pack", 1, 21]] as const)
    .forEach(([n, sub, price]) => addProduct(n, prerolls, sub, price, "BATCH", pacificPrerolls, 21 + int(0, 80) / 10));
  ([["Mango Gummies 100mg", 0, 9], ["Watermelon Gummies 100mg", 0, 9], ["Sour Cherry Gummies 100mg", 0, 9.5], ["Dark Chocolate Bar 100mg", 1, 11], ["Milk Chocolate Bar 100mg", 1, 11], ["Sea Salt Caramel Bites 100mg", 1, 12]] as const)
    .forEach(([n, sub, price]) => addProduct(n, edibles, sub, price, "PRODUCT", sweetLeaf, null));
  ([["Blue Dream Cartridge 1g", 0, 26], ["Gelato Cartridge 1g", 0, 26], ["OG Kush Cartridge 0.5g", 0, 18], ["Wedding Cake Disposable 0.5g", 1, 20], ["Sour Diesel Disposable 1g", 1, 28], ["Jack Herer Cartridge 1g", 0, 25]] as const)
    .forEach(([n, sub, price]) => addProduct(n, vapes, sub, price, "BATCH", caliVape, 78 + int(0, 100) / 10));
  ([["Gelato Live Resin 1g", 0, 30], ["Wedding Cake Live Rosin 1g", 1, 38], ["OG Kush Live Resin 1g", 0, 29], ["Blue Dream Badder 1g", 0, 24]] as const)
    .forEach(([n, sub, price]) => addProduct(n, concentrates, sub, price, "PACKAGE", sierraExtracts, 70 + int(0, 120) / 10));
  const product = (name: string) => products.find((p) => p.name === name)!;

  product("Sour Diesel Pre-Roll 5-Pack").active = false; // discontinued
  for (const [name, t] of [["Blue Dream 1g Pre-Roll", [bestSeller]], ["Gelato 1g Pre-Roll", [newArrival]], ["Blue Dream Pre-Roll 5-Pack", [bestSeller, summerPromo]], ["OG Kush Infused Pre-Roll", [newArrival, bestSeller]],
    ["Mango Gummies 100mg", [summerPromo]], ["Blue Dream 3.5g", [bestSeller]], ["Gelato Cartridge 1g", [bestSeller]]] as const) product(name).tagIds = t.map((x) => x.id);

  // On-hand quantity per product. Four products on the main menu and one that is only on the spring menu are sold out;
  // four are below their low-stock alert, one of them only once the units open orders hold are taken off.
  const onHand = new Map(products.map((p) => [p.id, int(140, 620)]));
  for (const name of ["Gelato 3.5g", "Sour Diesel 1g Pre-Roll", "Mango Gummies 100mg", "OG Kush Cartridge 0.5g", "Jack Herer 14g"]) onHand.set(product(name).id, 0);
  for (const p of products) if (rand() < 0.45) p.thresholdMin = 40;
  for (const name of ["Sour Diesel 1g Pre-Roll", "Mango Gummies 100mg", "OG Kush Cartridge 0.5g", "Jack Herer 14g", "Milk Chocolate Bar 100mg", "Sour Diesel Pre-Roll 5-Pack"]) product(name).thresholdMin = null;
  const lowStock: [string, number, number, number][] = [["Gelato 3.5g", 0, 0, 60], ["Wedding Cake 7g", 40, 0, 100], ["Dark Chocolate Bar 100mg", 90, 0, 150], ["Blue Dream Cartridge 1g", 110, 45, 80]];
  for (const [name, qty, reserved, min] of lowStock) { const p = product(name); onHand.set(p.id, qty); p.reserved = reserved; p.thresholdMin = min; }
  onHand.set(product("Milk Chocolate Bar 100mg").id, 25); // low, but it has no alert set
  onHand.set(product("Blue Dream 3.5g").id, 70);
  product("Blue Dream 3.5g").thresholdMin = 40;

  const label = (kind: "A4E2" | "9B7E", n: number) => `1A40603000${kind === "A4E2" ? "0A4E2" : "09B7E"}${String(n).padStart(9, "0")}`;
  const batches: World["batches"] = [];
  const packages: World["packages"] = [];
  const addBatch = (p: Product, stock: Batch["stock"], createdAt = ago(60 + batches.length)): Batch => {
    const b = { id: id(PREFIX.batch), productId: p.id, batchNumber: `LOT-${2200 + batches.length * 7}`, thcPercent: p.thcPercent, createdAt, stock };
    batches.push(b);
    return b;
  };
  // A batch-tracked product holds its stock in its batch, between the vault and the shipping room.
  for (const p of products.filter((x) => x.tracking === "BATCH")) {
    const total = onHand.get(p.id)!, inShipping = p.name === "Blue Dream 3.5g" ? 10 : Math.floor(total / 5);
    addBatch(p, total ? [{ locationId: vault.id, quantity: total - inShipping }, { locationId: shipping.id, quantity: inShipping }].filter((s) => s.quantity > 0) : []);
  }
  // A package-tracked product's packages all come from one batch, which holds no stock of its own.
  const lotOf = new Map(products.filter((x) => x.tracking === "PACKAGE").map((p) => [p.id, addBatch(p, []).id]));
  let labelNo = 20410;
  for (const p of products) {
    const total = onHand.get(p.id)!;
    if (p.tracking === "PRODUCT") {
      p.stock = total ? [{ locationId: vault.id, quantity: total - Math.floor(total / 4) }, { locationId: shipping.id, quantity: Math.floor(total / 4) }] : [];
    } else if (p.tracking === "PACKAGE") {
      const parts = total === 0 ? [0] : total < 120 ? [total] : [Math.ceil(total / 2), Math.floor(total / 2)];
      for (const quantity of parts) packages.push({ id: id(PREFIX.package), productId: p.id, batchId: lotOf.get(p.id)!, metrcLabel: label("A4E2", labelNo++), quantity, locationId: vault.id, licenseId: dist.id,
        status: quantity ? "ACTIVE" : "FINISHED", labTestingState: "TestPassed", createdAt: ago(45 + packages.length) });
    }
  }

  // ---------- menus ----------
  const menuOf = (name: string, externalName: string, active: boolean, visibility: World["menus"][0]["visibility"], names: string[], age: number): World["menus"][0] => ({
    id: id(PREFIX.menu), name, externalName, urlSuffix: slug(name), active, visibility, ownerId: daniel.id, allowPartnerOrders: true, hidePricesMode: "DO_NOT_HIDE", minimumOrderSubtotal: 500,
    minimumOrderLeadTimeDays: 2, sellByCaseOnly: false, showInventoryLevels: true, products: names.map((n, i) => ({ productId: product(n).id, addedAt: ago(age - i) })), createdAt: ago(age + 30), updatedAt: ago(Math.floor(age / 4)),
  });
  const menus = [
    menuOf("Main Wholesale Menu", "Tidewater Wholesale", true, "PUBLIC", ["Blue Dream 3.5g", "Blue Dream 7g", "Wedding Cake 3.5g", "Gelato 3.5g", "OG Kush 3.5g", "Blue Dream 1g Pre-Roll", "Wedding Cake 1g Pre-Roll", "Sour Diesel 1g Pre-Roll",
      "Blue Dream Pre-Roll 5-Pack", "Gelato Infused Pre-Roll", "Mango Gummies 100mg", "Watermelon Gummies 100mg", "Dark Chocolate Bar 100mg", "Blue Dream Cartridge 1g", "Gelato Cartridge 1g", "OG Kush Cartridge 0.5g", "Gelato Live Resin 1g", "Wedding Cake Live Rosin 1g"], 200),
    menuOf("Spring Menu", "Tidewater Spring Drop", true, "PASSCODE_PROTECTED", ["Blue Dream 3.5g", "Wedding Cake 3.5g", "Sour Diesel 3.5g", "OG Kush 3.5g", "Jack Herer 14g", "Jack Herer 1g Pre-Roll", "Gelato Pre-Roll 5-Pack", "Sour Cherry Gummies 100mg", "Sour Diesel Disposable 1g"], 120),
    menuOf("Bay Area Menu", "Tidewater Bay Area", true, "PRIVATE", ["Blue Dream 3.5g", "Wedding Cake 7g", "OG Kush 1g Pre-Roll", "Wedding Cake Pre-Roll 5-Pack", "Milk Chocolate Bar 100mg", "Jack Herer Cartridge 1g", "OG Kush Live Resin 1g"], 90),
    menuOf("Holiday Menu", "Tidewater Holiday", false, "PUBLIC", ["Blue Dream 7g", "Sea Salt Caramel Bites 100mg", "Wedding Cake Disposable 0.5g"], 340),
  ];

  // ---------- sales ----------
  const sellable = products.filter((p) => p.active);
  const salesOrders: SalesOrder[] = [];
  const invoices: World["invoices"] = [];
  const invoicePayments: World["invoicePayments"] = [];
  const addOrder = (c: Company, orderDay: string, target: number, opts: { status?: SalesOrder["status"]; items?: [string, number, number?][]; number?: string; terms?: number } = {}): SalesOrder => {
    const items = opts.items
      ? opts.items.map(([name, quantity, price]) => { const p = product(name); return { id: id(PREFIX.orderItem), productId: p.id, batchId: null, packageId: null, quantity, unitPrice: price ?? p.unitPrice, unitCost: p.unitCost }; })
      : ((lines: number) => Array.from({ length: lines }, () => { const p = pick(sellable); return { id: id(PREFIX.orderItem), productId: p.id, batchId: null, packageId: null, quantity: Math.max(1, Math.round(target / lines / p.unitPrice)), unitPrice: p.unitPrice, unitCost: p.unitCost }; }))(int(2, 4));
    const age = daysBetween(orderDay, today);
    const status = opts.status ?? (age > 10 ? "COMPLETED" : (["PENDING", "PROCESSING", "READY_TO_SHIP", "DELIVERED"] as const)[int(0, 3)]!);
    const delivered = status === "COMPLETED" || status === "DELIVERED";
    const order: SalesOrder = {
      id: id(PREFIX.salesOrder), orderNumber: opts.number ?? "", customerId: c.id, ownerId: c.ownerId!, status, orderDatetime: on(orderDay, "09:30:00"), dueDatetime: on(addDays(orderDay, opts.terms ?? 30), "17:00:00"),
      deliveryDatetime: delivered ? on(addDays(orderDay, 3), "13:00:00") : null, locationId: shipping.id, menuId: null, items, internalNotes: null,
    };
    salesOrders.push(order);
    return order;
  };
  const spread = (c: Company, range: { start: string; end: string }, thousands: number) => {
    const n = int(3, 5), span = daysBetween(range.start, range.end);
    for (let i = 0; i < n; i++) addOrder(c, addDays(range.start, 2 + int(0, Math.max(0, span - 4))), (thousands * 1000) / n);
  };

  const lastQ = quarter(today, 0 + 1), prevQ = quarter(today, 2), thisQ = quarter(today, 0);
  customerPlan.forEach(([name, thousands]) => { if (thousands) spread(customer(name), lastQ, thousands); });
  // Orders that would change the ranking if the date range or the status were read wrongly.
  addOrder(customer("Coastal Roots"), addDays(lastQ.start, -6), 85000);
  addOrder(customer("Marina Green Dispensary"), addDays(lastQ.start, 20), 60000, { status: "CANCELED" });
  for (const c of customers.slice(0, 12)) addOrder(c, addDays(prevQ.start, int(3, 80)), int(8, 30) * 1000);
  const sinceQuarterStart = daysBetween(thisQ.start, today);
  if (sinceQuarterStart > 14) {
    addOrder(customer("Ojai Valley Collective"), addDays(thisQ.start, 5), 70000);
    for (let i = 0; i < 16; i++) addOrder(pick(customers), addDays(today, -int(1, sinceQuarterStart - 1)), int(4, 22) * 1000);
  }

  // Invoices that are overdue by more than 30 days (the four the question asks for) and the ones that only look like it.
  const overdue = (name: string, dueDaysAgo: number, total: number, status?: SalesOrder["status"]) =>
    addOrder(customer(name), addDays(today, -(dueDaysAgo + 30)), total, { status: status ?? "COMPLETED" });
  const lateUnpaid = [overdue("Harbor Lights Cannabis", 33, 8400), overdue("Topanga Wellness", 58, 5200)];
  const latePartial = [overdue("Golden Gate Greens", 41, 12600), overdue("Sierra Vista Cannabis", 75, 7300)];
  const dueRecently = [overdue("Redwood Remedies", 12, 6100), overdue("Pacific Bloom", 27, 9800)];
  const voidedLate = overdue("Laurel Canyon Collective", 60, 4400, "CANCELED");

  // The two orders the questions name.
  const so4512 = addOrder(customer("Bayside Botanicals"), addDays(today, -4), 0, { status: "DELIVERED", number: "SO-4512", items: [["Blue Dream 7g", 60], ["Gelato Cartridge 1g", 48], ["Watermelon Gummies 100mg", 120]] });
  const so1042 = addOrder(customer("Sunset Dispensary"), addDays(today, -400), 0, { status: "COMPLETED", number: "SO-1042", items: [["Wedding Cake 3.5g", 60, 19.5], ["Blue Dream 1g Pre-Roll", 200], ["Mango Gummies 100mg", 80]] });
  const apiOrder = addOrder(customer("Emerald Coast Dispensary"), addDays(today, -1), 0, { status: "PENDING", number: "SO-4509", items: [["OG Kush 3.5g", 40], ["Gelato 1g Pre-Roll", 150]] });

  // Number the rest in date order, ending just below the named recent orders.
  const unnumbered = salesOrders.filter((o) => !o.orderNumber).sort((a, b) => a.orderDatetime.localeCompare(b.orderDatetime));
  unnumbered.forEach((o, i) => { o.orderNumber = `SO-${4508 - unnumbered.length + i}`; });

  for (const o of salesOrders) {
    if (!o.deliveryDatetime && o !== voidedLate) continue;
    const inv = { id: id(PREFIX.invoice), invoiceNumber: o.orderNumber.replace("SO", "INV"), salesOrderId: o.id, customerId: o.customerId, ownerId: o.ownerId, invoiceDatetime: o.deliveryDatetime ?? o.orderDatetime, dueDatetime: o.dueDatetime, voided: o === voidedLate };
    invoices.push(inv);
    const total = orderTotal(o), dueDay = o.dueDatetime.slice(0, 10);
    const pay = (amount: number, day: string) => {
      const paymentId = id(PREFIX.invoicePayment), paymentDatetime = on(day, "11:00:00");
      invoicePayments.push({ id: paymentId, paymentNumber: `PAY-${paymentId.split("_")[1]}`, invoiceId: inv.id, amount, paymentDatetime, recordedAt: paymentDatetime, paymentMethodId: pick(paymentMethods).id, note: null, voidedAt: null });
    };
    if (lateUnpaid.includes(o) || dueRecently.includes(o) || o === voidedLate) continue;
    if (latePartial.includes(o)) pay(Math.round(total * 0.4), addDays(dueDay, -2));
    else if (addDays(dueDay, -5) <= today && o.status === "COMPLETED") pay(total, addDays(dueDay, -5));
  }

  // ---------- purchasing ----------
  const purchaseOrders: PurchaseOrder[] = [];
  const purchasePayments: World["purchasePayments"] = [];
  const addPurchase = (v: Company, orderDay: string, opts: { number?: string; items?: [string, number, number][]; status?: PurchaseOrder["status"] } = {}): PurchaseOrder => {
    const theirs = products.filter((p) => p.vendorId === v.id);
    const items = (opts.items ?? Array.from({ length: int(1, 3) }, () => { const p = pick(theirs); return [p.name, int(2, 12) * 100, p.unitCost] as [string, number, number]; }))
      .map(([name, quantity, unitCost]) => ({ id: id(PREFIX.purchaseItem), productId: product(name).id, quantity, unitCost }));
    const po: PurchaseOrder = { id: id(PREFIX.purchaseOrder), purchaseNumber: opts.number ?? "", vendorId: v.id, ownerId: tom.id, status: opts.status ?? "COMPLETED", orderDatetime: on(orderDay, "08:45:00"), dueDatetime: on(addDays(orderDay, 30), "17:00:00"), locationId: vault.id, items };
    purchaseOrders.push(po);
    return po;
  };
  const yearStart = `${today.slice(0, 4)}-01-01`, intoYear = daysBetween(yearStart, today);
  // The regular purchases of the year, each paid in full two weeks later. None in the year's first 20 days, so that
  // no payment falls after today: on those days "this year" has only the purchases placed below.
  const regular = new Set<PurchaseOrder>();
  if (intoYear >= 20) for (const v of vendors) for (let i = 0, n = int(2, 4); i < n; i++) regular.add(addPurchase(v, addDays(yearStart, int(0, intoYear - 20))));
  for (const v of [humboldt, sierraExtracts, sweetLeaf, caliVape]) addPurchase(v, addDays(yearStart, -int(5, 50))); // last year: not part of "this year"
  const unpaid = [addPurchase(mendocino, addDays(today, -9), { status: "PROCESSING" }), addPurchase(caliVape, addDays(today, -16), { status: "DELIVERING" }), addPurchase(sweetLeaf, addDays(today, -24))];
  const po1182 = addPurchase(humboldt, addDays(today, -21), { number: "PO-1182", items: [["Blue Dream 7g", 250, 25.6]] });
  const partial = addPurchase(sierraExtracts, addDays(today, -38));
  const overpaid = addPurchase(pacificPrerolls, addDays(today, -52));
  addPurchase(humboldt, addDays(yearStart, -70), { number: "PO-1128", items: [["OG Kush 3.5g", 300, 14.1]] });

  // What each vendor was ordered this year, in thousands of dollars, which the vendor-spend question asks for. Planned,
  // as customer revenue is, so that no two vendors are within 5% of each other: the regular purchases are scaled to
  // make up each total once the purchases placed above that fall in this year are counted.
  const vendorPlan: [Company, number][] = [[mendocino, 260], [humboldt, 215], [sierraExtracts, 180], [pacificPrerolls, 150], [caliVape, 124], [sweetLeaf, 100]];
  const thisYear = (po: PurchaseOrder) => po.orderDatetime.slice(0, 4) === today.slice(0, 4);
  for (const [v, thousands] of vendorPlan) {
    const mine = purchaseOrders.filter((po) => po.vendorId === v.id && thisYear(po));
    const scaled = mine.filter((po) => regular.has(po));
    const fixed = mine.filter((po) => !regular.has(po)).reduce((n, po) => n + purchaseTotal(po), 0);
    const natural = scaled.reduce((n, po) => n + purchaseTotal(po), 0);
    if (!natural) continue;
    const factor = (thousands * 1000 - fixed) / natural;
    for (const item of scaled.flatMap((po) => po.items)) item.quantity = Math.max(1, Math.round(item.quantity * factor));
  }

  const openPurchases = purchaseOrders.filter((p) => !p.purchaseNumber).sort((a, b) => a.orderDatetime.localeCompare(b.orderDatetime));
  openPurchases.forEach((p, i) => { p.purchaseNumber = `PO-${1181 - openPurchases.length + i}`; });
  const yesterday = addDays(today, -1);
  for (const po of purchaseOrders) {
    const pay = (amount: number, daysAfter: number) => {
      const paymentId = id(PREFIX.purchasePayment), day = addDays(po.orderDatetime.slice(0, 10), daysAfter);
      const paymentDatetime = on(day < yesterday ? day : yesterday, "15:00:00");
      purchasePayments.push({ id: paymentId, paymentNumber: `PMT-${paymentId.split("_")[1]}`, purchaseId: po.id, amount, paymentDatetime, recordedAt: paymentDatetime, paymentMethodId: paymentMethods[0]!.id, note: null, voidedAt: null });
    };
    if (unpaid.includes(po)) continue;
    if (po === po1182) pay(1000, 3);
    else if (po === partial) pay(Math.round(purchaseTotal(po) / 2), 10);
    else if (po === overpaid) pay(purchaseTotal(po) + 50, 12);
    else pay(purchaseTotal(po), 14);
  }

  // ---------- tasks ----------
  const tasks: World["tasks"] = [];
  const addTask = (name: string, owner: typeof maya, dueDaysAgo: number, status: "ACTIVE" | "COMPLETED" = "ACTIVE", related: World["tasks"][0]["related"] = null) =>
    tasks.push({ id: id(PREFIX.task), name, description: null, status, dueDate: ago(dueDaysAgo, "17:00:00"), ownerId: owner.id, creatorId: maya.id, related, createdAt: ago(dueDaysAgo + 7) });
  addTask("Call Sunset Dispensary about the late payment", maya, 3, "ACTIVE", { type: "COMPANY", id: customer("Sunset Dispensary").id });
  addTask("Review the wholesale price list", maya, 9);
  addTask("Reconcile Metrc package counts", maya, 1);
  addTask("Send monthly statements", maya, 12, "COMPLETED");
  addTask("Approve this week's purchase orders", maya, 0);
  addTask("Plan the holiday menu", maya, -6);
  addTask("Renew the distribution license paperwork", maya, -20);
  addTask("Follow up with Pacific Bloom on their reorder", daniel, 4, "ACTIVE", { type: "COMPANY", id: customer("Pacific Bloom").id });
  addTask("Confirm delivery date with Sierra Extracts", tom, 2);
  addTask("File the weekly compliance report", lena, 5, "COMPLETED");

  // ---------- Metrc ----------
  const distPackages = packages.filter((k) => k.status === "ACTIVE" && k.licenseId === dist.id);
  const metrcPackages: World["metrcPackages"] = distPackages.map((k, i) => {
    const p = products.find((x) => x.id === k.productId)!;
    return { metrcId: 880100 + i, label: k.metrcLabel, licenseId: dist.id, itemName: p.name, itemCategory: categories.find((c) => c.id === p.categoryId)!.name, strainName: strains.find((s) => s.id === p.strainId)?.name ?? null,
      quantity: k.quantity, unitOfMeasure: "Each", status: "ACTIVE", importStatus: "IMPORTED", labTestingState: "TestPassed", metrcLocationName: "Vault", packagedDate: k.createdAt.slice(0, 10), lastModified: k.createdAt };
  });
  const notImported: [string, string, string | null, number, typeof dist, string, number][] = [
    ["Sour Diesel 3.5g", "Flower", "Sour Diesel", 240, dist, "Vault", 3], ["Gelato Live Resin 1g", "Concentrates", "Gelato", 96, dist, "Vault", 2], ["Jack Herer 14g", "Flower", "Jack Herer", 48, dist, "Processing Room", 1],
    ["Wedding Cake Bulk Flower", "Buds", "Wedding Cake", 4200, cult, "Dry Room", 4], ["Blue Dream Bulk Flower", "Buds", "Blue Dream", 3650, cult, "Dry Room", 2],
  ];
  notImported.forEach(([itemName, itemCategory, strainName, quantity, lic, room, age], i) => metrcPackages.push({ metrcId: 881500 + i, label: label("A4E2", 30771 + i * 13), licenseId: lic.id, itemName, itemCategory, strainName, quantity,
    unitOfMeasure: lic === cult ? "Grams" : "Each", status: "ACTIVE", importStatus: "UNIMPORTED", labTestingState: lic === cult ? "NotSubmitted" : "TestPassed", metrcLocationName: room, packagedDate: addDays(today, -age), lastModified: ago(age) }));

  // The cultivation license's imported package: bulk flower in the dry room, with the house product it was imported as.
  const bulk: Product = {
    id: id(PREFIX.product), name: "Gelato Bulk Flower", sku: `FL-${1001 + products.length}`, active: true, categoryId: flower.id, subcategoryId: null, strainId: strainOf("Gelato"), brandId: null, vendorId: null,
    groupId: groups[0]!.id, tagIds: [], unitTypeId: unitTypes[1]!.id, tracking: "PACKAGE", unitPrice: 4.5, unitCost: 1.9, thresholdMin: null, thresholdMax: null, reserved: 0, thcPercent: null, stock: [],
    createdAt: ago(30), updatedAt: ago(30),
  };
  products.push(bulk);
  const bulkPackage = { id: id(PREFIX.package), productId: bulk.id, batchId: addBatch(bulk, [], ago(30)).id, metrcLabel: label("A4E2", 31900), quantity: 5100, locationId: dryRoom.id, licenseId: cult.id,
    status: "ACTIVE" as const, labTestingState: "TestPassed" as const, createdAt: ago(30) };
  packages.push(bulkPackage);
  metrcPackages.push({ metrcId: 881700, label: bulkPackage.metrcLabel, licenseId: cult.id, itemName: bulk.name, itemCategory: "Buds", strainName: "Gelato", quantity: bulkPackage.quantity, unitOfMeasure: "Grams",
    status: "ACTIVE", importStatus: "IMPORTED", labTestingState: "TestPassed", metrcLocationName: dryRoom.name, packagedDate: addDays(today, -30), lastModified: ago(30) });

  // The distribution license's Metrc queue. Activities sync one at a time in the order they were queued, and a failed
  // one holds back every later one, so the license has one FAILED activity: yesterday afternoon's adjustment. The
  // day before everything went through; yesterday's earlier changes did too; what was queued after the failure,
  // yesterday and this morning, is still QUEUED behind it.
  const metrcActivities: World["metrcActivities"] = [];
  const addActivity = (type: World["metrcActivities"][0]["type"], daysAgo: number, time: string, status: World["metrcActivities"][0]["status"], lastError: string | null = null) => {
    const k = distPackages[(metrcActivities.length * 5) % distPackages.length]!;
    const verb = { ADJUST_PACKAGE: "Adjust package", CHANGE_PACKAGE_LOCATION: "Move package", CREATE_PACKAGE: "Create package", FINISH_PACKAGE: "Finish package" }[type];
    metrcActivities.push({ id: id(PREFIX.metrcActivity), type, title: `${verb} ${k.metrcLabel}`, description: `${verb} for ${products.find((p) => p.id === k.productId)!.name}`, status, lastError, licenseId: dist.id, creatorId: daysAgo % 2 ? lena.id : maya.id, packageId: k.id, insertedAt: ago(daysAgo, time) });
  };
  addActivity("ADJUST_PACKAGE", 2, "09:10:00", "COMPLETED");
  addActivity("CHANGE_PACKAGE_LOCATION", 2, "11:30:00", "COMPLETED");
  addActivity("ADJUST_PACKAGE", 2, "15:40:00", "COMPLETED");
  addActivity("CHANGE_PACKAGE_LOCATION", 2, "16:05:00", "COMPLETED");
  addActivity("ADJUST_PACKAGE", 1, "08:50:00", "COMPLETED");
  addActivity("ADJUST_PACKAGE", 1, "09:20:00", "COMPLETED");
  addActivity("CHANGE_PACKAGE_LOCATION", 1, "10:15:00", "COMPLETED");
  addActivity("CREATE_PACKAGE", 1, "11:45:00", "COMPLETED");
  addActivity("ADJUST_PACKAGE", 1, "14:05:00", "FAILED", "Metrc rejected the adjustment: the quantity removed is more than the package holds in Metrc.");
  addActivity("ADJUST_PACKAGE", 1, "15:30:00", "QUEUED");
  addActivity("CHANGE_PACKAGE_LOCATION", 1, "17:10:00", "QUEUED");
  addActivity("ADJUST_PACKAGE", 0, "08:15:00", "QUEUED");

  const manifestPackage = (itemName: string, itemCategory: string, quantity: number, n: number) => ({ label: label("A4E2", n), itemName, itemCategory, quantity, unitOfMeasure: "Each", labTestingState: "TestPassed" });
  const metrcManifests: World["metrcManifests"] = [
    { manifestNumber: "0001234567", direction: "INCOMING", licenseId: dist.id, counterpartyName: humboldt.name, counterpartyLicense: humboldt.licenseNumber!, createdDate: ago(2), estimatedArrival: ago(-1, "11:00:00"), receivedDate: null,
      packages: [manifestPackage("Blue Dream 7g", "Flower", 250, 41207), manifestPackage("Wedding Cake 3.5g", "Flower", 400, 41208), manifestPackage("OG Kush 3.5g", "Flower", 320, 41215), manifestPackage("Jack Herer 14g", "Flower", 90, 41222)] },
    { manifestNumber: "0001234568", direction: "INCOMING", licenseId: dist.id, counterpartyName: sierraExtracts.name, counterpartyLicense: sierraExtracts.licenseNumber!, createdDate: ago(1), estimatedArrival: ago(-2, "14:00:00"), receivedDate: null,
      packages: [manifestPackage("Gelato Live Resin 1g", "Concentrates", 200, 52310), manifestPackage("OG Kush Live Resin 1g", "Concentrates", 180, 52311), manifestPackage("Blue Dream Badder 1g", "Concentrates", 150, 52319)] },
    { manifestNumber: "0001234100", direction: "OUTGOING", licenseId: dist.id, counterpartyName: customer("Sunset Dispensary").name, counterpartyLicense: customer("Sunset Dispensary").licenseNumber!, createdDate: ago(6), estimatedArrival: ago(5, "12:00:00"), receivedDate: ago(5, "12:40:00"),
      packages: [manifestPackage("Blue Dream 7g", "Flower", 60, 38811), manifestPackage("Gelato Cartridge 1g", "Vapes", 48, 38812)] },
  ];

  // ---------- cultivation ----------
  const plantGroups: World["plantGroups"] = [];
  const plants: World["plants"] = [];
  let plantNo = 7301;
  const addGroup = (name: string, strainName: string, count: number, status: World["plants"][0]["status"], room: typeof vegRoom, age: number) => {
    const g = { id: id(PREFIX.plantGroup), name, strainName, licenseId: cult.id, locationId: room.id, plantedAt: ago(age) };
    plantGroups.push(g);
    for (let i = 0; i < count; i++) plants.push({ id: id(PREFIX.plant), metrcLabel: label("9B7E", plantNo++), plantGroupId: g.id, status, plantedAt: g.plantedAt,
      floweredAt: status === "FLOWERING" || status === "HARVESTED" ? ago(age - 35) : null, harvestedAt: status === "HARVESTED" ? ago(age - 98) : null, isMother: false });
  };
  addGroup("Wedding Cake Run 22", "Wedding Cake", 9, "FLOWERING", flowerRoom, 62);
  addGroup("Gelato Run 14", "Gelato", 7, "VEGETATIVE", vegRoom, 24);
  addGroup("OG Kush Run 3", "OG Kush", 6, "IMMATURE", vegRoom, 8);
  addGroup("Sour Diesel Run 9", "Sour Diesel", 5, "VEGETATIVE", vegRoom, 19);
  addGroup("Blue Dream Run 31", "Blue Dream", 8, "HARVESTED", flowerRoom, 120);

  const lm = lastMonth(today);
  const harvestOn = (name: string, strainName: string, day: string, wetWeight: number, plantCount: number): World["harvests"][0] => {
    const finished = daysBetween(day, today) > 21;
    return { id: id(PREFIX.harvest), name, strainName, licenseId: cult.id, locationId: dryRoom.id, status: finished ? "FINISHED" : "DRYING", harvestedAt: on(day, "07:30:00"), finishedDate: finished ? addDays(day, 14) : null, wetWeight, plantCount };
  };
  const harvests = [
    harvestOn("Sour Diesel Harvest 8", "Sour Diesel", addDays(lm.start, -12), 14000, 20),
    harvestOn("Blue Dream Harvest 30", "Blue Dream", addDays(lm.start, 5), 18450, 24),
    harvestOn("Gelato Harvest 12", "Gelato", addDays(lm.start, 8), 12780, 18),
    harvestOn("Blue Dream Harvest 31", "Blue Dream", addDays(lm.start, 13), 16200, 22),
    harvestOn("Gelato Harvest 13", "Gelato", addDays(lm.start, 21), 11340, 16),
    harvestOn("Wedding Cake Harvest 21", "Wedding Cake", addDays(lm.start, 26), 21600, 28),
    ...(today.slice(8) > "03" ? [harvestOn("OG Kush Harvest 2", "OG Kush", addDays(today, -2), 9900, 14), harvestOn("Blue Dream Harvest 32", "Blue Dream", addDays(today, -1), 5000, 7)] : []),
  ];

  // ---------- history ----------
  const actions: Action[] = [];
  const act = (daysAgo: number, time: string, actor: typeof maya | null, source: Action["source"], records: ActionRow[], sourceDetail: string | null = null) =>
    actions.push({ id: id(PREFIX.action), changedAt: ago(daysAgo, time), actorId: actor?.id ?? null, actorName: actor ? `${actor.firstName} ${actor.lastName}` : "Public API", source, sourceDetail, records });
  type Line = { entity: RowEntity; id: Id | null; label: string };
  /** A change of one field, on the record's own row or on one of its lines. */
  const change = (type: RecordType, record: { id: Id }, name: string, field: string, label: string, oldValue: string | null, newValue: string | null, line?: Line): ActionRow =>
    ({ type, id: record.id, name, entity: line?.entity ?? type, rowId: line ? line.id : record.id, op: "UPDATE", rowLabel: line?.label ?? null, fields: [{ field, label, oldValue, newValue }] });
  const created = (type: RecordType, record: { id: Id }, name: string): ActionRow => ({ type, id: record.id, name, entity: type, rowId: record.id, op: "INSERT", rowLabel: null, fields: [] });
  const weddingCakeLine: Line = { entity: "ORDER_ITEM", id: so1042.items[0]!.id, label: "Wedding Cake 3.5g" };

  act(400, "10:12:00", daniel, "WEB", [created("SALES_ORDER", so1042, "SO-1042")]);
  act(399, "09:05:00", daniel, "WEB", [change("SALES_ORDER", so1042, "SO-1042", "quantity", "Quantity", "40", "60", weddingCakeLine)]);
  act(397, "14:37:00", priya, "WEB", [change("SALES_ORDER", so1042, "SO-1042", "priceBase", "Price", "24.00", "19.50", weddingCakeLine)]);
  act(396, "11:20:00", maya, "WEB", [change("SALES_ORDER", so1042, "SO-1042", "status", "Status", "PENDING", "PROCESSING")]);
  act(395, "16:02:00", lena, "WEB", [change("SALES_ORDER", so1042, "SO-1042", "dueDatetime", "Due date", ago(370, "17:00:00"), ago(363, "17:00:00"))]);
  act(392, "13:15:00", maya, "WEB", [change("SALES_ORDER", so1042, "SO-1042", "status", "Status", "PROCESSING", "COMPLETED")]);

  const api = "API key: storefront sync";
  act(2, "18:22:00", null, "PUBLIC_API", [change("PRODUCT", product("Jack Herer Cartridge 1g"), "Jack Herer Cartridge 1g", "unitPrice", "Unit price", "26.00", "25.00")], api);
  act(1, "06:05:00", null, "PUBLIC_API", [change("PRODUCT", product("Gelato Cartridge 1g"), "Gelato Cartridge 1g", "unitPrice", "Unit price", "27.50", "26.00")], api);
  act(1, "06:05:00", null, "PUBLIC_API", [change("PRODUCT", product("Mango Gummies 100mg"), "Mango Gummies 100mg", "unitPrice", "Unit price", "9.50", "9.00")], api);
  act(1, "09:31:00", daniel, "WEB", [change("SALES_ORDER", so4512, "SO-4512", "status", "Status", "READY_TO_SHIP", "DELIVERED")]);
  act(1, "12:48:00", null, "PUBLIC_API", [created("SALES_ORDER", apiOrder, "SO-4509")], api);
  act(1, "15:10:00", maya, "MCP", [change("PRODUCT", product("Wedding Cake 7g"), "Wedding Cake 7g", "quantityAvailableThresholdMin", "Low-stock alert", "80", "100")]);
  act(1, "19:40:00", null, "PUBLIC_API", [change("COMPANY", customer("Greenleaf Collective"), "Greenleaf Collective", "phone", "Phone", "(510) 555-0144", customer("Greenleaf Collective").phone)], api);
  act(0, "08:02:00", null, "PUBLIC_API", [change("PRODUCT", product("OG Kush Live Resin 1g"), "OG Kush Live Resin 1g", "unitPrice", "Unit price", "30.00", "29.00")], api);

  return {
    today, timezone: TIMEZONE, company: { id: "com_0", name: "Tidewater Cannabis Co.", legalName: "Tidewater Cannabis Company, Inc.", state: "CA", complianceSystem: "METRC" }, me: maya.id,
    users, licenses, locations, categories, tags, groups, strains, unitTypes, paymentMethods, paymentTerms, companyGroups, customFields, companies, contacts, products, batches, packages,
    stockTransfers: [], salesOrders, invoices, invoicePayments, purchaseOrders, purchasePayments, tasks, menus, metrcPackages, metrcActivities, metrcManifests, plantGroups, plants, harvests, actions,
    outbox: [], nextId: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, v + 1])),
  };
}
