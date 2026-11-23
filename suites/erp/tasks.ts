// The 25 tasks of the ERP suite and how each is graded. Every fact a grader expects is computed from the world
// the run started from (and, for a write, the world it ended with), because the world is rebuilt for the day of
// the run. `preflight` says when a day's world cannot grade the tasks fairly.
import { addDays, dayIn } from "../../src/core/kit.ts";
import type { Check, Task } from "../../src/core/tool.ts";
import {
  amount, attributed, check, diff, firstMentioned, list, literal, mentions, mentionsAll, mentionsCount, mentionsNone, named, numbered, numbers,
  onDay, passages, percentage, quotes, sentences, tagged, unchanged, unchangedExcept, valuesNear, weekday, weight, type Ref,
} from "./grading.ts";
import { clock, lastMonth, quarter } from "./seed.ts";
import {
  activeQuantity, availableQuantity, belowMinimum, fullName, invoiceMoney, orderTotal, purchaseMoney, purchaseTotal,
  type Category, type Id, type Invoice, type Menu, type Product, type SalesOrder, type World,
} from "./world.ts";

// ---------- tolerances, shared by the graders and by preflight ----------

const THC_POINTS = 0.05;
const MARGIN_POINTS = 1;
const PROFIT_SHARE = 0.01;
const VALUE_SHARE = 0.005;
const WEIGHT_SHARE = 0.01;
const SPEND_SHARE = 0.01;
const LATE_DAYS = 30;
/** How far apart the 10th and 11th customers must be, as a share of the 10th's revenue. */
const TOP_GAP = 0.03;

// ---------- shared lookups ----------

const DAY = 86_400_000;
/** Fields every write may change: the action it logs and the id counters. */
const LOG = ["actions", "nextId"];

const dayOf = (w: World, iso: string) => dayIn(w.timezone, new Date(iso));
const inRange = (w: World, iso: string, range: { start: string; end: string }) => {
  const d = dayOf(w, iso);
  return d >= range.start && d <= range.end;
};
const byName = <T extends { name: string }>(items: T[], name: string) => items.find((i) => i.name === name);
const productById = (w: World, id: Id) => w.products.find((p) => p.id === id);
const userName = (w: World, id: Id | null) => {
  const u = w.users.find((x) => x.id === id);
  return u ? fullName(u) : "nobody";
};
const unique = <T>(xs: T[]) => [...new Set(xs)];
const sum = (xs: number[]) => Math.round(xs.reduce((n, x) => n + x, 0) * 100) / 100;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sameText = (a: string | null | undefined, b: string) => a?.trim().toLowerCase() === b.toLowerCase();

const productRef = (p: Product) => named(p.name);
const categoryRef = (c: Category) => named(c.name, c.name.replace(/s$/, ""), c.official.replace(/S$/, ""));
const menuProducts = (w: World, m: Menu) => m.products.map((x) => productById(w, x.productId)).filter((p): p is Product => !!p);
/** A task is recognised by the first four words of its name, so a light rewording of the rest still counts. */
const taskRef = (t: World["tasks"][0]): Ref => ({ label: t.name, pattern: named(t.name.split(/\s+/).slice(0, 4).join(" ")).pattern });
/** History names an order by its number and other records by their name. */
const recordRef = (name: string) => (/^[A-Z]+-\d+$/.test(name) ? numbered(name) : named(name));

const read = (id: string, source: string, prompt: string, grade: (answer: string, w: World) => Check[]): Task<World> => ({
  id, source, prompt, kind: "read",
  grade: ({ answer, before, after }) => [...grade(answer, before), unchanged(before, after)],
});
const write = (id: string, source: string, prompt: string, grade: (run: { before: World; after: World }) => Check[]): Task<World> => ({
  id, source, prompt, kind: "write", grade,
});

// ---------- the facts each task depends on ----------

const LAB_OPTIONS = ["SC Labs", "Steep Hill"];

function prerolls(w: World) {
  const promo = byName(w.tags, "Summer promo");
  const category = w.categories.find((c) => c.official === "PREROLLS");
  const all = w.products.filter((p) => p.categoryId === category?.id);
  return { promo, category, all, active: all.filter((p) => p.active) };
}

function soldOut(w: World) {
  const menu = byName(w.menus, "Main Wholesale Menu");
  const listed = menu ? menuProducts(w, menu) : [];
  const out = (p: Product) => availableQuantity(w, p) <= 0;
  const elsewhere = w.menus.filter((m) => m !== menu).flatMap((m) => menuProducts(w, m)).filter((p) => out(p) && !listed.includes(p));
  return { menu, out: listed.filter(out), inStock: listed.filter((p) => !out(p)), elsewhere: unique(elsewhere) };
}

function springFlower(w: World) {
  const menu = byName(w.menus, "Spring Menu");
  const flower = w.categories.find((c) => c.official === "FLOWER");
  return { menu, products: menu ? menuProducts(w, menu).filter((p) => p.categoryId === flower?.id) : [] };
}

/** The tools have no single "ordering" switch: each of these settings, on its own, stops buyers ordering. */
const ORDERING_OFF = [["active", false], ["allowPartnerOrders", false], ["hidePricesMode", "HIDE_FOR_EVERYONE"]] as const;

function metrcImports(w: World) {
  return { unimported: w.metrcPackages.filter((p) => p.importStatus === "UNIMPORTED"), imported: w.metrcPackages.filter((p) => p.importStatus === "IMPORTED") };
}

function adjustments(w: World) {
  const yesterday = addDays(w.today, -1), dayBefore = addDays(w.today, -2);
  const failedOn = (ymd: string) => w.metrcActivities
    .filter((a) => a.type === "ADJUST_PACKAGE" && a.status === "FAILED" && dayOf(w, a.insertedAt) === ymd)
    .map((a) => ({ label: w.packages.find((k) => k.id === a.packageId)?.metrcLabel, error: a.lastError ?? "" }));
  return { yesterday, dayBefore, failed: failedOn(yesterday), earlier: failedOn(dayBefore) };
}

function manifest(w: World) {
  const asked = w.metrcManifests.find((m) => m.manifestNumber === "0001234567");
  return { asked, others: w.metrcManifests.filter((m) => m !== asked).flatMap((m) => m.packages) };
}

/** The valuation report has a row for every active product and values its active stock, at unit price or unit cost. */
function stockValue(w: World) {
  const active = w.products.filter((p) => p.active);
  const at = (unit: (p: Product) => number) => sum(active.map((p) => activeQuantity(w, p) * unit(p)));
  return { atPrice: at((p) => p.unitPrice), atCost: at((p) => p.unitCost) };
}

function categoryMargins(w: World) {
  const q = quarter(w.today, 1);
  const lines = w.salesOrders.filter((o) => o.status === "COMPLETED" && inRange(w, o.orderDatetime, q)).flatMap((o) => o.items);
  return w.categories.map((category) => {
    const mine = lines.filter((i) => productById(w, i.productId)?.categoryId === category.id);
    const revenue = sum(mine.map((i) => i.quantity * i.unitPrice));
    const profit = sum(mine.map((i) => i.quantity * (i.unitPrice - i.unitCost)));
    return { category, revenue, profit, margin: revenue ? (profit / revenue) * 100 : 0 };
  });
}

function vegetative(w: World) {
  const plants = w.plants.filter((p) => p.status === "VEGETATIVE");
  const groups = w.plantGroups.filter((g) => plants.some((p) => p.plantGroupId === g.id));
  return { plants, groups, others: w.plantGroups.filter((g) => !groups.includes(g)) };
}

function harvestsByStrain(w: World) {
  const month = lastMonth(w.today);
  const strains = unique([...w.strains.map((s) => s.name), ...w.harvests.map((h) => h.strainName)]);
  const rows = strains.map((strain) => {
    const all = w.harvests.filter((h) => h.strainName === strain);
    const inMonth = all.filter((h) => inRange(w, h.harvestedAt, month));
    return { strain, grams: sum(inMonth.map((h) => h.wetWeight)), harvested: inMonth.length > 0, outside: all.filter((h) => !inMonth.includes(h)).map((h) => h.wetWeight) };
  });
  return { strains, harvested: rows.filter((r) => r.harvested), elsewhere: rows.filter((r) => !r.harvested && r.outside.length) };
}

function account(w: World, name: string) {
  const company = byName(w.companies, name);
  const buyer = w.contacts.find((k) => k.companyId === company?.id && sameText(k.title, "Buyer"));
  return { company, rep: company?.ownerId ? userName(w, company.ownerId) : undefined, buyer: buyer?.email ?? undefined };
}

function myTasks(w: World) {
  const now = clock(w.today).getTime();
  const mine = w.tasks.filter((t) => t.ownerId === w.me);
  const overdue = mine.filter((t) => t.status === "ACTIVE" && Date.parse(t.dueDate) < now);
  return { overdue, notOverdue: mine.filter((t) => !overdue.includes(t)), others: w.tasks.filter((t) => t.ownerId !== w.me) };
}

function priceHistory(w: World) {
  const order = w.salesOrders.find((o) => o.orderNumber === "SO-1042");
  const history = w.actions.filter((a) => a.records.some((r) => r.type === "SALES_ORDER" && r.id === order?.id));
  const changes = history.filter((a) => a.records.some((r) => r.id === order?.id && r.fields.some((f) => f.field === "priceBase")));
  return { changes, others: unique(history.map((a) => a.actorName)).filter((n) => !changes.some((c) => c.actorName === n)) };
}

function apiChanges(w: World) {
  const yesterday = addDays(w.today, -1);
  const api = w.actions.filter((a) => a.source === "PUBLIC_API");
  const names = (actions: typeof api) => unique(actions.flatMap((a) => a.records.map((r) => r.name)));
  const touched = names(api.filter((a) => dayOf(w, a.changedAt) === yesterday));
  return { yesterday: touched, otherDays: names(api.filter((a) => dayOf(w, a.changedAt) !== yesterday)).filter((n) => !touched.includes(n)) };
}

function stockLevels(w: World) {
  const below = w.products.filter((p) => belowMinimum(w, p));
  return { below, others: w.products.filter((p) => !below.includes(p)) };
}

function invoicesLate(w: World) {
  const now = clock(w.today).getTime();
  const late = (i: Invoice) => (now - Date.parse(i.dueDatetime)) / DAY;
  const owing = (i: Invoice) => !i.voided && invoiceMoney(w, i).remaining > 0;
  const overdue = w.invoices.filter((i) => owing(i) && late(i) > LATE_DAYS);
  return {
    overdue,
    late,
    // An invoice with a balance that is not due yet is neither asked for nor a trap.
    wrong: w.invoices.filter((i) => !overdue.includes(i) && !(owing(i) && late(i) <= 0)),
    recent: w.invoices.filter((i) => owing(i) && late(i) > 0 && late(i) <= LATE_DAYS),
    voidedLate: w.invoices.filter((i) => i.voided && late(i) > LATE_DAYS),
    paidLate: w.invoices.filter((i) => !i.voided && invoiceMoney(w, i).remaining === 0 && late(i) > LATE_DAYS),
    owingNearLine: w.invoices.filter((i) => owing(i) && Math.abs(late(i) - LATE_DAYS) <= 1),
  };
}

function customerRanking(w: World, counts = (o: SalesOrder) => o.status !== "CANCELED", range = quarter(w.today, 1)) {
  const revenue = (c: { id: Id }) => sum(w.salesOrders.filter((o) => o.customerId === c.id && counts(o) && inRange(w, o.orderDatetime, range)).map(orderTotal));
  return w.companies.filter((c) => c.relationship === "CUSTOMER").map((company) => ({ company, revenue: revenue(company) })).sort((a, b) => b.revenue - a.revenue);
}

function invoiceToEmail(w: World) {
  const order = w.salesOrders.find((o) => o.orderNumber === "SO-4512");
  const invoice = w.invoices.find((i) => i.salesOrderId === order?.id && !i.voided);
  const buyers = w.contacts.filter((k) => k.companyId === order?.customerId && sameText(k.title, "Buyer") && k.email);
  return { order, invoice, buyers };
}

function vendorSpend(w: World) {
  const year = w.today.slice(0, 4);
  const ordered = w.purchaseOrders.filter((po) => dayOf(w, po.orderDatetime).startsWith(year));
  const rows = w.companies
    .filter((v) => ordered.some((po) => po.vendorId === v.id))
    .map((vendor) => ({ vendor, total: sum(ordered.filter((po) => po.vendorId === vendor.id).map(purchaseTotal)) }));
  return { rows, earlier: w.purchaseOrders.filter((po) => dayOf(w, po.orderDatetime) < `${year}-01-01`) };
}

function purchasesUnpaid(w: World) {
  const status = (po: World["purchaseOrders"][0]) => purchaseMoney(w, po).status;
  return {
    unpaid: w.purchaseOrders.filter((po) => status(po) === "NOT_PAID" || status(po) === "PARTIALLY_PAID"),
    paid: w.purchaseOrders.filter((po) => status(po) === "PAID" || status(po) === "OVER_PAID"),
    overpaid: w.purchaseOrders.filter((po) => status(po) === "OVER_PAID"),
  };
}

// ---------- the tasks ----------

export const tasks: Task<World>[] = [
  // Catalog
  write("catalog-lab-dropdown", "mcp/catalog", "Add a Lab dropdown to packages with the options SC Labs and Steep Hill.", ({ before, after }) => {
    const added = after.customFields.slice(before.customFields.length);
    const field = added[0];
    const none = "no custom field was added";
    const options = (field?.options ?? []).map((o) => o.trim()).sort();
    return [
      check("adds exactly one custom field", added.length === 1, `added ${added.length}: ${list(added.map((f) => f.name))}`),
      check("the field is for packages", field?.entityType === "PACKAGE", field ? `it is for ${field.entityType}` : none),
      check("the field is named Lab", sameText(field?.name, "Lab"), field ? `it is named "${field.name}"` : none),
      check("the field is a dropdown", field?.fieldType === "DROPDOWN", field ? `it is a ${field.fieldType}` : none),
      check("its options are exactly SC Labs and Steep Hill", options.join("|") === [...LAB_OPTIONS].sort().join("|"), field ? `options: ${list(field.options) || "none"}` : none),
      unchangedExcept("changes nothing else", before, after, ["customFields.+", ...LOG]),
    ];
  }),

  write("catalog-tag-prerolls", "mcp/catalog", "Tag every pre-roll as Summer promo.", ({ before, after }) => {
    const { promo, category, active } = prerolls(before);
    const now = new Map(after.products.map((p) => [p.id, p]));
    const tagName = (id: Id) => before.tags.find((t) => t.id === id)?.name ?? id;
    const untagged = active.filter((p) => !now.get(p.id)?.tagIds.includes(promo!.id));
    const lost = before.products.flatMap((p) => {
      const gone = p.tagIds.filter((t) => !now.get(p.id)?.tagIds.includes(t));
      return gone.length ? [`${p.name} lost ${gone.map(tagName).join(", ")}`] : [];
    });
    const extra = before.products.flatMap((p) => {
      const added = (now.get(p.id)?.tagIds ?? []).filter((t) => t !== promo!.id && !p.tagIds.includes(t));
      return added.length ? [`${p.name} got ${added.map(tagName).join(", ")}`] : [];
    });
    const outside = before.products.filter((p) => p.categoryId !== category!.id && diff(p, now.get(p.id)).length);
    return [
      check("tags every active pre-roll Summer promo", untagged.length === 0, `not tagged: ${list(untagged.map((p) => p.name))}`),
      check("keeps the tags products already had", lost.length === 0, list(lost)),
      check("adds no tag but Summer promo", extra.length === 0, list(extra)),
      check("changes no product outside Pre-Rolls", outside.length === 0, `changed: ${list(outside.map((p) => p.name))}`),
      unchangedExcept("changes nothing but product tags", before, after, ["products.*.tagIds", "products.*.updatedAt", ...LOG]),
    ];
  }),

  // Commerce
  read("commerce-main-menu-sold-out", "mcp/commerce", "Which products on our main wholesale menu are sold out?", (answer, w) => {
    const { out, inStock, elsewhere } = soldOut(w);
    return [
      mentionsAll("names every sold-out product on the main menu", answer, out.map(productRef)),
      mentionsNone("names no product of the main menu that is in stock", answer, inStock.map(productRef)),
      mentionsNone("names no product sold out only on another menu", answer, elsewhere.map(productRef)),
    ];
  }),

  read("commerce-spring-flower-thc", "mcp/commerce", "What does the Spring menu show for THC on each flower product?", (answer, w) => [
    valuesNear("gives the THC of each flower product on the Spring Menu", answer,
      springFlower(w).products.map((p) => ({ ref: productRef(p), accepts: percentage(p.thcPercent!, THC_POINTS, true), shows: `${p.thcPercent}%` })),
      w.products.map(productRef)),
  ]),

  write("commerce-bay-area-ordering", "mcp/commerce", "Turn off ordering on the Bay Area menu.", ({ before, after }) => {
    const index = before.menus.findIndex((m) => m.name === "Bay Area Menu");
    const was = before.menus[index]!;
    const now = after.menus.find((m) => m.id === was.id);
    const taken = ORDERING_OFF.filter(([field, off]) => was[field] !== off && now?.[field] === off);
    const stray = diff(was, now).filter((path) => path !== "updatedAt" && !taken.some(([field]) => field === path));
    return [
      {
        name: "turns off ordering on the Bay Area Menu",
        pass: taken.length > 0,
        detail: taken.length ? `reading taken: ${taken.map(([field, off]) => `${field} set to ${off}`).join(" and ")}` : "active, allowPartnerOrders and hidePricesMode are as they were",
      },
      check("changes nothing else on the Bay Area Menu", stray.length === 0, `changed: ${list(stray)}`),
      unchangedExcept("changes no other menu or record", before, after, [`menus.${index}`, ...LOG]),
    ];
  }),

  // Compliance
  read("compliance-unimported-packages", "mcp/compliance", "Which Metrc packages haven't been imported into Distru yet?", (answer, w) => {
    const { unimported, imported } = metrcImports(w);
    return [
      mentionsAll("identifies every unimported Metrc package, on both licenses", answer, unimported.map((p) => tagged(p.label))),
      mentionsNone("names no package that is already imported", answer, imported.map((p) => tagged(p.label))),
    ];
  }),

  read("compliance-yesterday-adjustments", "mcp/compliance", "Did yesterday's Metrc adjustments all go through?", (answer, w) => {
    const { yesterday, dayBefore, failed, earlier } = adjustments(w);
    // Reporting the failure is what says "no": the package, or the words of its error, rather than the word "no".
    const missed = failed.filter((f) => !(f.label && mentions(answer, tagged(f.label))) && !quotes(answer, f.error, earlier.map((e) => e.error)));
    // The day before's failure may be mentioned, as long as the answer ties it to its own day.
    const earlierRefs = earlier.flatMap((e) => (e.label ? [tagged(e.label)] : []));
    const days = [onDay(yesterday, "yesterday", weekday(yesterday)), onDay(dayBefore, "day before yesterday", "two days ago", "2 days ago", weekday(dayBefore))];
    const dated = attributed(answer, [...earlierRefs, ...failed.flatMap((f) => (f.label ? [tagged(f.label)] : []))], days);
    const misdated = earlierRefs.filter((_, i) => dated[i]!.length && (!dated[i]!.includes(1) || dated[i]!.includes(0)));
    return [
      check("reports yesterday's failed adjustment", missed.length === 0, missed.map((f) => `does not identify package ${f.label} or quote its error "${f.error}"`).join("; ")),
      check("does not present the earlier failure as yesterday's", misdated.length === 0, `names package ${list(misdated.map((r) => r.label))} without dating it to ${dayBefore}`),
    ];
  }),

  read("compliance-manifest-packages", "mcp/compliance", "Show me the packages on incoming manifest 0001234567.", (answer, w) => {
    const { asked, others } = manifest(w);
    return [
      mentionsAll("identifies every package on the manifest", answer, asked!.packages.map((p) => tagged(p.label))),
      mentionsNone("names no package of another manifest", answer, others.map((p) => tagged(p.label))),
    ];
  }),

  // Costing
  read("costing-inventory-value", "mcp/costing", "What is our inventory worth today?", (answer, w) => {
    const { atPrice, atCost } = stockValue(w);
    const said = numbers(answer);
    const matched = ([["unit price", atPrice], ["unit cost", atCost]] as const).filter(([, total]) => said.some(amount(total, VALUE_SHARE)));
    return [{
      name: "gives the value of stock on hand",
      pass: matched.length > 0,
      detail: matched.length
        ? `matched the value at ${matched.map(([basis, total]) => `${basis} (${usd(total)})`).join(" and ")}`
        : `expected ${usd(atPrice)} at unit price or ${usd(atCost)} at unit cost; found ${list(said.filter((n) => !n.percent).map((n) => n.text)) || "no amount"}`,
    }];
  }),

  read("costing-category-margin", "mcp/costing", "What was our margin by product category last quarter?", (answer, w) => [
    valuesNear("gives each category's margin or profit", answer,
      categoryMargins(w).map((r) => ({
        ref: categoryRef(r.category),
        accepts: (n) => percentage(r.margin, MARGIN_POINTS, true)(n) || amount(r.profit, PROFIT_SHARE)(n),
        shows: `${r.margin.toFixed(1)}% or ${usd(r.profit)} profit`,
      }))),
  ]),

  // Cultivation
  read("cultivation-plants-in-veg", "mcp/cultivation", "Which plants are in veg right now?", (answer, w) => {
    const { plants, groups, others } = vegetative(w);
    const unlisted = plants.filter((p) => !mentions(answer, tagged(p.metrcLabel)));
    const unnamed = groups.filter((g) => !mentions(answer, named(g.name)));
    const counted = mentionsCount(answer, plants.length);
    return [
      check("gives the plants in veg, by label or by group with their count", !unlisted.length || (!unnamed.length && counted),
        `${unlisted.length} of ${plants.length} plant labels missing; ${unnamed.length ? `groups missing: ${list(unnamed.map((g) => g.name))}` : "every group named"}; ${counted ? "count given" : `no count of ${plants.length}`}`),
      mentionsNone("names no plant group without plants in veg", answer, others.map((g) => named(g.name))),
    ];
  }),

  read("cultivation-harvest-by-strain", "mcp/cultivation", "How much did we harvest last month, by strain?", (answer, w) => {
    const { strains, harvested, elsewhere } = harvestsByStrain(w);
    const refs = strains.map((s) => named(s));
    const near = passages(answer, refs);
    // A strain harvested only in other months may be named, but not with the weight of those harvests.
    const weighed = elsewhere.filter((r) => {
      const weights = [...r.outside, sum(r.outside)];
      return near[strains.indexOf(r.strain)]!.flatMap(numbers).some((n) => weights.some((g) => weight(g, WEIGHT_SHARE)(n)));
    });
    return [
      valuesNear("gives each strain's wet weight harvested last month", answer,
        harvested.map((r) => ({ ref: named(r.strain), accepts: weight(r.grams, WEIGHT_SHARE), shows: `${r.grams} g` })), refs),
      check("gives no weight for strains not harvested last month", weighed.length === 0, `gives a weight for ${list(weighed.map((r) => r.strain))}`),
    ];
  }),

  // Directory
  read("directory-sunset-rep-buyer", "mcp/directory", "Who is the sales rep on Sunset Dispensary, and what's the buyer's email?", (answer, w) => {
    const asked = account(w, "Sunset Dispensary"), other = account(w, "Sunset Wellness Collective");
    return [
      check("gives the sales rep of Sunset Dispensary", mentions(answer, named(asked.rep!)), `missing ${asked.rep}`),
      check("gives the email of its buyer", mentions(answer, literal(asked.buyer!)), `missing ${asked.buyer}`),
      mentionsNone("gives neither the rep nor the buyer of Sunset Wellness Collective", answer, [named(other.rep!), literal(other.buyer!)]),
    ];
  }),

  read("directory-my-overdue-tasks", "mcp/directory", "Which of my tasks are overdue?", (answer, w) => {
    const { overdue, notOverdue, others } = myTasks(w);
    return [
      mentionsAll("names every overdue task of mine", answer, overdue.map(taskRef)),
      mentionsNone("names none of my tasks that are done or not yet due", answer, notOverdue.map(taskRef)),
      mentionsNone("names no task of another user", answer, others.map(taskRef)),
    ];
  }),

  write("directory-add-contact", "mcp/directory", "Add Jane Lee, purchasing manager, as a contact at Sunset Dispensary.", ({ before, after }) => {
    const added = after.contacts.slice(before.contacts.length);
    const contact = added[0];
    const none = "no contact was added";
    const company = (id: Id) => after.companies.find((c) => c.id === id)?.name ?? id;
    return [
      check("adds exactly one contact", added.length === 1, `added ${added.length}: ${list(added.map(fullName))}`),
      check("the contact is Jane Lee", sameText(contact?.firstName, "Jane") && sameText(contact?.lastName, "Lee"), contact ? `added ${fullName(contact)}` : none),
      check("her title is purchasing manager", sameText(contact?.title, "purchasing manager"), contact ? `title: ${contact.title ?? "none"}` : none),
      check("she is a contact at Sunset Dispensary", contact?.companyId === byName(before.companies, "Sunset Dispensary")!.id, contact ? `added at ${company(contact.companyId)}` : none),
      unchangedExcept("changes nothing else", before, after, ["contacts.+", ...LOG]),
    ];
  }),

  // History
  read("history-price-change-so-1042", "mcp/history", "Who changed the price on SO-1042, and when?", (answer, w) => {
    const { changes: [change], others } = priceHistory(w);
    const actor = named(change!.actorName);
    const actors = [actor, ...others.map((n) => named(n))];
    const price = named("price", "priced", "pricing", "priceBase");
    // Other changes to the order may be listed; a sentence or row about the price must name its changer first.
    const credited = sentences(answer).filter((s) => mentions(s, price)).map((s) => firstMentioned(s, actors)).filter((a) => a && a !== actor);
    const day = dayOf(w, change!.changedAt);
    return [
      check("names who changed the price", mentions(answer, actor), `missing ${change!.actorName}`),
      check("gives the date of the change", mentions(answer, onDay(day)), `missing ${day}`),
      check("does not credit anyone else with the price change", credited.length === 0, `ties the price to ${list(unique(credited.map((a) => a!.label)))}`),
    ];
  }),

  read("history-public-api-yesterday", "mcp/history", "What did the public API change yesterday?", (answer, w) => {
    const { yesterday, otherDays } = apiChanges(w);
    return [
      mentionsAll("names every record the public API changed yesterday", answer, yesterday.map(recordRef)),
      mentionsNone("names no record the public API changed on another day", answer, otherDays.map(recordRef)),
    ];
  }),

  // Inventory
  read("inventory-below-minimum", "mcp/inventory", "Which products are below their minimum stock level?", (answer, w) => {
    const { below, others } = stockLevels(w);
    return [
      mentionsAll("names every product below its minimum", answer, below.map(productRef)),
      mentionsNone("names no product at or above its minimum, or without one", answer, others.map(productRef)),
    ];
  }),

  write("inventory-move-blue-dream", "mcp/inventory", "Move 20 units of Blue Dream 3.5g from the vault to the shipping room.", ({ before, after }) => {
    const product = byName(before.products, "Blue Dream 3.5g")!;
    const vault = byName(before.locations, "Vault")!, shipping = byName(before.locations, "Shipping Room")!;
    const held = (w: World, p: Product, at?: Id) => {
      const now = productById(w, p.id);
      return now ? activeQuantity(w, now, at) : 0;
    };
    const moved = (at: Id) => held(after, product, at) - held(before, product, at);
    const transfers = after.stockTransfers.slice(before.stockTransfers.length);
    const t = transfers[0];
    const units = t ? sum(t.items.filter((i) => i.productId === product.id).map((i) => i.quantity)) : 0;
    const otherStock = before.products.filter((p) => p.id !== product.id && before.locations.some((l) => held(before, p, l.id) !== held(after, p, l.id)));
    return [
      check("takes 20 units of Blue Dream 3.5g out of the Vault", moved(vault.id) === -20, `the Vault changed by ${moved(vault.id)}`),
      check("puts 20 units into the Shipping Room", moved(shipping.id) === 20, `the Shipping Room changed by ${moved(shipping.id)}`),
      check("keeps its total stock", held(after, product) === held(before, product), `total went from ${held(before, product)} to ${held(after, product)}`),
      check("records one transfer of 20 units from the Vault to the Shipping Room",
        transfers.length === 1 && t!.fromLocationId === vault.id && t!.toLocationId === shipping.id && units === 20 && t!.items.every((i) => i.productId === product.id),
        t ? `${transfers.length} transfer(s); the first from ${t.fromLocationId} to ${t.toLocationId}, ${units} units of it, ${t.items.length} line(s)` : "no transfer recorded"),
      check("changes no other product's stock", otherStock.length === 0, `changed: ${list(otherStock.map((p) => p.name))}`),
      unchangedExcept("changes nothing else", before, after, [
        ...before.batches.flatMap((b, i) => (b.productId === product.id ? [`batches.${i}`] : [])),
        `products.${before.products.indexOf(product)}.updatedAt`, "stockTransfers.+", ...LOG,
      ]),
    ];
  }),

  // Orders
  read("orders-overdue-invoices", "mcp/orders", "Which invoices are more than 30 days overdue, and who is the sales rep on each?", (answer, w) => {
    const { overdue, wrong } = invoicesLate(w);
    const ref = (i: Invoice) => numbered(i.invoiceNumber, "SO");
    const reps = w.users.map((u) => named(fullName(u)));
    const tied = attributed(answer, w.invoices.map(ref), reps);
    const misattributed = overdue.flatMap((inv) => {
      const said = tied[w.invoices.indexOf(inv)]!;
      if (said.includes(w.users.findIndex((u) => u.id === inv.ownerId))) return [];
      const given = unique(said.flatMap((r) => (r === undefined ? [] : [reps[r]!.label])));
      return [`${inv.invoiceNumber}: expected ${userName(w, inv.ownerId)}, found ${given.join(", ") || "no rep"}`];
    });
    return [
      mentionsAll("lists every invoice more than 30 days overdue", answer, overdue.map(ref)),
      check("gives the sales rep of each", misattributed.length === 0, list(misattributed, 6)),
      mentionsNone("lists no invoice overdue 30 days or less, paid or voided", answer, wrong.map(ref)),
    ];
  }),

  read("orders-top-customers", "mcp/orders", "Who were our top 10 customers by revenue last quarter?", (answer, w) => {
    const ranked = customerRanking(w);
    return [
      mentionsAll("names the ten customers with the most revenue last quarter", answer, ranked.slice(0, 10).map((r) => named(r.company.name))),
      mentionsNone("names no customer outside the top ten", answer, ranked.slice(10).map((r) => named(r.company.name))),
    ];
  }),

  write("orders-email-invoice", "mcp/orders", "Email the invoice for order 4512 to the buyer.", ({ before, after }) => {
    const { invoice, buyers } = invoiceToEmail(before);
    const buyer = buyers[0]!.email!;
    const sent = after.outbox.slice(before.outbox.length);
    const email = sent[0];
    const none = "no email was sent";
    return [
      check("sends exactly one email", sent.length === 1, `sent ${sent.length}`),
      check("the email carries the invoice of SO-4512", email?.document === "INVOICE" && email.recordId === invoice!.id, email ? `it carries ${email.document} ${email.recordId}` : none),
      check("it goes to the buyer and no one else", email?.emailAddresses.length === 1 && sameText(email.emailAddresses[0], buyer), email ? `sent to ${list(email.emailAddresses) || "nobody"}, not only ${buyer}` : none),
      unchangedExcept("changes nothing else", before, after, ["outbox", ...LOG]),
    ];
  }),

  // Purchasing
  read("purchasing-vendor-spend", "mcp/purchasing", "How much did we spend with each vendor this year?", (answer, w) => [
    valuesNear("gives what was ordered from each vendor this year", answer,
      vendorSpend(w).rows.map((r) => ({ ref: named(r.vendor.name), accepts: amount(r.total, SPEND_SHARE), shows: usd(r.total) })),
      w.companies.filter((c) => c.relationship === "VENDOR").map((c) => named(c.name))),
  ]),

  read("purchasing-unpaid-pos", "mcp/purchasing", "Which purchase orders haven't been paid in full?", (answer, w) => {
    const { unpaid, paid } = purchasesUnpaid(w);
    return [
      mentionsAll("lists every purchase order not paid in full", answer, unpaid.map((po) => numbered(po.purchaseNumber))),
      mentionsNone("lists no purchase order paid in full", answer, paid.map((po) => numbered(po.purchaseNumber))),
    ];
  }),

  write("purchasing-record-payment", "mcp/purchasing", "Record a $2,500 payment against purchase order 1182.", ({ before, after }) => {
    const po = before.purchaseOrders.find((p) => p.purchaseNumber === "PO-1182")!;
    const added = after.purchasePayments.slice(before.purchasePayments.length);
    const payment = added[0];
    const none = "no payment was recorded";
    const number = (id: Id) => before.purchaseOrders.find((p) => p.id === id)?.purchaseNumber ?? id;
    return [
      check("records exactly one purchase payment", added.length === 1, `recorded ${added.length}`),
      check("the payment is $2,500", !!payment && Math.abs(payment.amount - 2500) < 0.005, payment ? `it is ${usd(payment.amount)}` : none),
      check("it is against PO-1182", payment?.purchaseId === po.id, payment ? `it is against ${number(payment.purchaseId)}` : none),
      check("it is not voided and uses an existing payment method", !!payment && !payment.voided && before.paymentMethods.some((m) => m.id === payment.paymentMethodId),
        payment ? `voided: ${payment.voided}, payment method: ${payment.paymentMethodId}` : none),
      unchangedExcept("changes nothing else", before, after, ["purchasePayments.+", ...LOG]),
    ];
  }),
];

// ---------- preflight ----------

/** Pairs of values a check could not tell apart: the number given for one would also be accepted for the other. */
function clashes(rows: { label: string; value: number }[], close: (a: number, b: number) => boolean): string[] {
  return rows.flatMap((a, i) => rows.slice(i + 1).filter((b) => close(a.value, b.value)).map((b) => `${a.label} (${a.value}) and ${b.label} (${b.value})`));
}
const withinShare = (share: number) => (a: number, b: number) => Math.abs(a - b) <= share * Math.max(Math.abs(a), Math.abs(b));
const withinPoints = (points: number) => (a: number, b: number) => Math.abs(a - b) <= points;

/** Metrc tags an answer may give by their last five characters, which must then name one package only. */
function sameEnding(labels: string[]): string[] {
  return unique(labels).filter((l, _, all) => all.some((o) => o !== l && o.slice(-5) === l.slice(-5)));
}

/**
 * The problems that make a task ungradable on this world's day: a fact a task asks for that the day does not
 * have, a trap the seed places that is missing, or values a check could not tell apart. Empty when all is well.
 */
export function preflight(w: World): string[] {
  const problems: string[] = [];
  const need = (task: string, ok: unknown, problem: string) => {
    if (!ok) problems.push(`${task}: ${problem}`);
  };
  const none = (task: string, found: string[], problem: string) => need(task, !found.length, `${problem}: ${list(found)}`);

  need("catalog-lab-dropdown", !w.customFields.some((f) => f.entityType === "PACKAGE" && sameText(f.name, "Lab")), "packages already have a Lab field");

  const pre = prerolls(w);
  need("catalog-tag-prerolls", pre.promo && pre.category, "there is no Summer promo tag or no Pre-Rolls category");
  need("catalog-tag-prerolls", pre.active.some((p) => !p.tagIds.includes(pre.promo?.id ?? "")), "every active pre-roll is already tagged Summer promo");
  need("catalog-tag-prerolls", pre.all.some((p) => p.tagIds.some((t) => t !== pre.promo?.id)), "no pre-roll has another tag to keep");

  const sold = soldOut(w);
  need("commerce-main-menu-sold-out", sold.menu, "there is no Main Wholesale Menu");
  need("commerce-main-menu-sold-out", sold.out.length, "nothing on the main menu is sold out");
  need("commerce-main-menu-sold-out", sold.inStock.length, "everything on the main menu is sold out");
  need("commerce-main-menu-sold-out", sold.elsewhere.length, "no product is sold out only on another menu");

  const spring = springFlower(w);
  need("commerce-spring-flower-thc", spring.products.length, "the Spring Menu lists no flower product");
  need("commerce-spring-flower-thc", spring.products.every((p) => p.thcPercent !== null), "a flower product on the Spring Menu has no THC");
  none("commerce-spring-flower-thc", clashes(spring.products.map((p) => ({ label: p.name, value: p.thcPercent ?? 0 })), withinPoints(THC_POINTS)), "THC values too close to tell apart");

  const bay = byName(w.menus, "Bay Area Menu");
  need("commerce-bay-area-ordering", bay?.active && bay.allowPartnerOrders && bay.hidePricesMode !== "HIDE_FOR_EVERYONE", "the Bay Area Menu is missing or already takes no orders");

  const metrc = metrcImports(w);
  need("compliance-unimported-packages", w.licenses.every((l) => metrc.unimported.some((p) => p.licenseId === l.id)), "a license has no unimported package");
  need("compliance-unimported-packages", metrc.imported.length, "no package is imported");
  none("compliance-unimported-packages", sameEnding(w.metrcPackages.map((p) => p.label)), "Metrc packages share their last five characters");

  const adj = adjustments(w);
  need("compliance-yesterday-adjustments", adj.failed.length && adj.failed.every((f) => f.label), "no adjustment of a known package failed yesterday");
  need("compliance-yesterday-adjustments", adj.earlier.length && adj.earlier.every((f) => f.label), "no adjustment of a known package failed the day before");
  none("compliance-yesterday-adjustments", sameEnding([...adj.failed, ...adj.earlier].map((f) => f.label ?? "")), "failed packages share their last five characters");
  need("compliance-yesterday-adjustments", adj.failed.every((f) => quotes(f.error, f.error, adj.earlier.map((e) => e.error))), "yesterday's error says nothing the day before's does not");

  const man = manifest(w);
  need("compliance-manifest-packages", man.asked?.packages.length, "manifest 0001234567 is missing or empty");
  need("compliance-manifest-packages", man.others.length, "no other manifest has packages");
  none("compliance-manifest-packages", sameEnding(w.metrcManifests.flatMap((m) => m.packages.map((p) => p.label))), "manifest packages share their last five characters");

  const value = stockValue(w);
  need("costing-inventory-value", value.atPrice > 0 && value.atCost > 0, "there is no stock to value");

  const margins = categoryMargins(w);
  none("costing-category-margin", margins.filter((r) => !r.revenue).map((r) => r.category.name), "categories with no completed sales last quarter");
  none("costing-category-margin", clashes(margins.map((r) => ({ label: r.category.name, value: Math.round(r.margin * 100) / 100 })), withinPoints(MARGIN_POINTS)), "margins too close to tell apart");
  none("costing-category-margin", clashes(margins.map((r) => ({ label: r.category.name, value: r.profit })), withinShare(PROFIT_SHARE)), "profits too close to tell apart");

  const veg = vegetative(w);
  need("cultivation-plants-in-veg", veg.plants.length, "no plant is in veg");
  need("cultivation-plants-in-veg", veg.others.length, "every plant group has plants in veg");
  none("cultivation-plants-in-veg", sameEnding(w.plants.map((p) => p.metrcLabel)), "plants share their last five characters");

  const harvest = harvestsByStrain(w);
  need("cultivation-harvest-by-strain", harvest.harvested.length >= 2, "fewer than two strains were harvested last month");
  none("cultivation-harvest-by-strain", clashes(harvest.harvested.map((r) => ({ label: r.strain, value: r.grams })), withinShare(WEIGHT_SHARE)), "strain weights too close to tell apart");
  need("cultivation-harvest-by-strain", harvest.elsewhere.length, "no strain was harvested only outside last month");

  const asked = account(w, "Sunset Dispensary"), other = account(w, "Sunset Wellness Collective");
  need("directory-sunset-rep-buyer", asked.rep && asked.buyer && other.rep && other.buyer, "Sunset Dispensary or Sunset Wellness Collective lacks a rep or a buyer with an email");
  need("directory-sunset-rep-buyer", asked.rep !== other.rep && asked.buyer !== other.buyer, "the two Sunset accounts share their rep or buyer");

  const todo = myTasks(w);
  need("directory-my-overdue-tasks", todo.overdue.length, "none of my tasks is overdue");
  need("directory-my-overdue-tasks", todo.notOverdue.length, "all of my tasks are overdue");
  need("directory-my-overdue-tasks", todo.others.some((t) => t.status === "ACTIVE" && Date.parse(t.dueDate) < clock(w.today).getTime()), "no other user has an overdue task");
  none("directory-my-overdue-tasks", w.tasks.filter((t) => w.tasks.some((o) => o !== t && mentions(o.name, taskRef(t)))).map((t) => t.name), "tasks whose first four words name another task too");

  const sunset = byName(w.companies, "Sunset Dispensary");
  need("directory-add-contact", sunset && !w.contacts.some((k) => k.companyId === sunset.id && sameText(k.firstName, "Jane") && sameText(k.lastName, "Lee")), "Sunset Dispensary is missing or already has Jane Lee");

  const price = priceHistory(w);
  need("history-price-change-so-1042", price.changes.length === 1, `SO-1042 has ${price.changes.length} price changes, not one`);
  need("history-price-change-so-1042", price.others.length, "nobody else changed SO-1042");

  const api = apiChanges(w);
  need("history-public-api-yesterday", api.yesterday.length, "the public API changed nothing yesterday");
  need("history-public-api-yesterday", api.otherDays.length, "the public API changed nothing on other days");

  const stock = stockLevels(w);
  const highestMinimum = Math.max(...stock.below.map((p) => p.thresholdMin!));
  need("inventory-below-minimum", stock.below.length, "no product is below its minimum");
  need("inventory-below-minimum", stock.others.some((p) => p.thresholdMin !== null), "no product with a minimum is at or above it");
  need("inventory-below-minimum", stock.below.some((p) => activeQuantity(w, p) >= p.thresholdMin!), "no product is below its minimum only because of reserved units");
  need("inventory-below-minimum", stock.others.some((p) => p.thresholdMin === null && availableQuantity(w, p) < highestMinimum), "no product without a minimum has low stock");

  const blueDream = byName(w.products, "Blue Dream 3.5g"), vault = byName(w.locations, "Vault");
  need("inventory-move-blue-dream", blueDream && vault && byName(w.locations, "Shipping Room") && activeQuantity(w, blueDream, vault.id) >= 20, "Blue Dream 3.5g, the Vault or the Shipping Room is missing, or the Vault holds fewer than 20 units");

  const late = invoicesLate(w);
  need("orders-overdue-invoices", late.overdue.length, "no invoice is more than 30 days overdue");
  need("orders-overdue-invoices", late.recent.length, "no invoice is overdue by 30 days or less");
  need("orders-overdue-invoices", late.voidedLate.length, "no voided invoice is past due");
  need("orders-overdue-invoices", late.paidLate.length, "no paid invoice is past due");
  none("orders-overdue-invoices", late.owingNearLine.map((i) => `${i.invoiceNumber} (${late.late(i).toFixed(1)} days)`), "invoices within a day of the 30-day line");

  const ranked = customerRanking(w);
  const top = (r: typeof ranked) => r.slice(0, 10).map((x) => x.company.name).sort().join("|");
  const [tenth, eleventh] = [ranked[9], ranked[10]];
  need("orders-top-customers", tenth && eleventh, "fewer than eleven customers");
  need("orders-top-customers", tenth && eleventh && tenth.revenue - eleventh.revenue > TOP_GAP * tenth.revenue, `the 10th customer (${tenth?.company.name}, ${usd(tenth?.revenue ?? 0)}) is within 3% of the 11th (${eleventh?.company.name}, ${usd(eleventh?.revenue ?? 0)})`);
  need("orders-top-customers", top(customerRanking(w, () => true)) !== top(ranked), "counting canceled orders would not change the top ten");
  // The seed places a large order in the week before the quarter, for an answer that reads the range loosely.
  const q = quarter(w.today, 1);
  need("orders-top-customers", top(customerRanking(w, undefined, { start: addDays(q.start, -7), end: q.end })) !== top(ranked), "counting the week before the quarter would not change the top ten");

  const mail = invoiceToEmail(w);
  need("orders-email-invoice", mail.invoice, "SO-4512 is missing or has no open invoice");
  need("orders-email-invoice", mail.buyers.length === 1, `SO-4512's customer has ${mail.buyers.length} buyers with an email, not one`);

  const spend = vendorSpend(w);
  need("purchasing-vendor-spend", spend.rows.length >= 3, "fewer than three vendors have purchase orders this year");
  none("purchasing-vendor-spend", clashes(spend.rows.map((r) => ({ label: r.vendor.name, value: r.total })), withinShare(SPEND_SHARE)), "vendor totals too close to tell apart");
  need("purchasing-vendor-spend", spend.earlier.length, "no purchase order is from an earlier year");

  const pos = purchasesUnpaid(w);
  need("purchasing-unpaid-pos", pos.unpaid.length, "every purchase order is paid in full");
  need("purchasing-unpaid-pos", pos.paid.length, "no purchase order is paid in full");
  need("purchasing-unpaid-pos", pos.overpaid.length, "no purchase order is overpaid");

  const po1182 = w.purchaseOrders.find((p) => p.purchaseNumber === "PO-1182");
  need("purchasing-record-payment", po1182 && purchaseMoney(w, po1182).remaining > 0 && w.paymentMethods.length, "PO-1182 is missing or paid in full, or there is no payment method");

  return problems;
}
