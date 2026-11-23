// The 25 tasks of the ERP suite and how each is graded. Every fact a grader expects is computed from the world
// the run started from (and, for a write, the world it ended with), because the world is rebuilt for the day of
// the run. `preflight` says when a day's world cannot grade the tasks fairly.
import { addDays, dayIn } from "../../src/core/kit.ts";
import type { Check, Task } from "../../src/core/tool.ts";
import {
  amount, answerPart, attributed, check, diff, excuse, firstMentioned, informative, list, literal, mentions, mentionsAll, mentionsCount, mentionsOf, named, namesNone, numbered,
  numbers, onDay, percentage, presenting, presents, quotes, sentences, tagged, unchanged, unchangedExcept, valuesNear, weekday, weight, withoutNames, type Ref,
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

// ---------- what counts as presenting a wrong item as part of the answer ----------
//
// A negative check fails an answer that presents a wrong item as part of its answer (see `presents` in grading.ts).
// Each rule below says, in the task's terms:
// - what a remark must say of a wrong item to present it as part of the answer (the claim, and the statements that
//   make it). A mention outside the part of the answer that gives the answer counts only when its context says so;
// - what says the item is left out: explicit statements, which excuse a mention anywhere, even on a row of the
//   answer's own table; then plain facts that show it, which excuse it only outside the answer. Every rule also takes
//   "not included", "excluded" and the like.

const SOLD_OUT = ["sold out", "out of stock", "(?:none|nothing|zero|0) (?:units? )?(?:left|available|on hand|in stock)", "unavailable", "no (?:stock|inventory|units) (?:left|available|on hand)",
  /\b(?:not|no longer|isn't|aren't) (?:in stock|available)\b/];

const IN_STOCK = presenting("is sold out", SOLD_OUT, excuse("that it is in stock",
  ["in stock", "(?:is|are|still) available", "not sold out", "(?:has|have|with) (?:some |plenty of )?stock", "restocked", /sold out\W{1,3}(?:no|false)\b/],
  [String.raw`[1-9][\d,]*(?:\.\d+)?\s*(?:units?\s+)?(?:available|on hand|in stock|left|remaining)`]));

const ON_ANOTHER_MENU = (w: World, main: Menu | undefined) => {
  const others = w.menus.filter((m) => m !== main).flatMap((m) => [named(m.name).pattern, named(m.externalName).pattern]);
  return presenting("is sold out on the main menu", [...SOLD_OUT, "(?:on|in) the main (?:wholesale )?menu"], excuse("that it is on another menu",
    ["(?:another|other|a different|different) menus?", /\b(?:not|isn't|aren't) (?:on|in) the main/, ...others.map((p) => new RegExp(`\\b(?:only|just) (?:on|in) (?:the )?(?:${p.source})`))],
    others));
};

const ALREADY_IMPORTED = presenting("is not imported yet",
  ["unimported", "un-imported", "importable", /\b(?:not|never) (?:yet )?(?:been )?imported\b/, /\b(?:hasn't|haven't|has not|have not|isn't|aren't|wasn't|weren't) (?:yet |ever )?(?:been )?imported\b/,
    /\b(?:awaiting|pending|needs?|needing|waiting (?:for|to be)|ready (?:for|to be)|left to be|yet to be|still to be|has to be|have to be) import(?:ed|ing)?\b/,
    /\b(?:not|isn't|aren't) (?:yet )?in (?:distru|(?:the |your )?inventory)\b/, /\bmissing from (?:distru|(?:the |your )?inventory)\b/],
  excuse("that it is already imported", ["imported", "already in (?:distru|inventory)", "has a distru package"]));

const ON_ANOTHER_MANIFEST = (w: World, asked: string) => {
  const number = `0*${asked.replace(/^0+/, "")}`;
  return presenting(`is on manifest ${asked}`,
    [String.raw`(?:on|in|of) (?:the |this |that )?(?:incoming )?manifest(?:\s*(?:#|no\.?)?\s*${number})?(?!\s*(?:#|no\.?)?\s*\d)`, String.raw`(?:on|in|of) (?:manifest\s*)?(?:#|no\.?)?\s*${number}`],
    excuse("that it is on another manifest",
      ["(?:another|other|a different|different|second|separate|outgoing) manifests?", /\b(?:not|isn't|aren't) on (?:this|that|the) manifest/],
      w.metrcManifests.filter((m) => m.manifestNumber !== asked).flatMap((m) => [m.manifestNumber, m.manifestNumber.replace(/^0+/, "")])));
};

/** The Veg Room is where the trap's immature plants are: a remark that puts a group there, and says no more, presents it as in veg. */
const NOT_IN_VEG = presenting("has plants in veg", ["in veg(?:etative)?(?: stage| phase)?", "vegetative", "vegging", "in the veg(?:etative)? (?:stage|phase)", "(?:in )?the veg room"], excuse("that it has no plants in veg",
  ["immature", "seedlings?", "clones?", "flowering", "in flower", "harvested", "mothers?", /(?:not|n't|none (?:are|is)|no plants?)\s+(?:yet\s+)?in (?:veg|the vegetative)/]));

/** The other account's name, as words: not run together inside an email address, which names it too. */
const OF_ACCOUNT = (asked: string, name: string) => presenting(`is ${asked}'s`, ["(?:sales )?reps?", "account owner", "owner", "buyers?", "e-?mail", "contacts?", asked],
  excuse(`that it is ${name}'s`, [new RegExp(`(?<![\\w@.])${name.split(/\s+/).join("\\s+")}(?![\\w@]|\\.\\w)`)]));

const OVERDUE = ["overdue", "past due", "(?:is|are|was|were|running|days?|hours?|weeks?) late", "late by", "missed (?:its|the) due date"];

const NOT_YET_DUE = presenting("is overdue", OVERDUE, excuse("that it is done or not yet due",
  ["due (?:later )?today", "due tomorrow", String.raw`due in \d+ days?`, String.raw`due (?:next|later this|this coming) \w+`, "upcoming", "completed", "done", "finished",
    /\b(?:not|n't) (?:yet )?(?:over)?due\b/, /\bnot (?:yet )?late\b/]));

const SOMEONE_ELSES = (w: World) => {
  const names = w.users.filter((u) => u.id !== w.me).flatMap((u) => [named(fullName(u)).pattern, named(u.firstName).pattern]);
  return presenting("is yours and overdue", [...OVERDUE, "your tasks?", "yours", "assigned to you", "you own"], excuse("that it is another user's",
    ["someone else(?:'s)?", "(?:a )?(?:colleague|teammate)(?:'s)?", "another (?:user|person|teammate)(?:'s)?", /\bnot (?:yours|assigned to you|mine)\b/,
      ...names.map((p) => new RegExp(`\\b(?:assigned to|owned by|belongs to|for) (?:${p.source})`))],
    names));
};

const BY_THE_API = ["(?:public )?api", "api key", "storefront sync", "integration"];

const ON_ANOTHER_DAY = (yesterday: string, days: string[]) => presenting("was changed by the public API yesterday",
  [...BY_THE_API, "yesterday", onDay(yesterday, weekday(yesterday)).pattern],
  excuse("that it happened on another day",
    [/\bnot yesterday\b/, "(?:on )?(?:another|a different) day"],
    [...days.map((d) => onDay(d, weekday(d)).pattern), "today", "this morning", "day before yesterday", "(?:two|2|three|3) days ago", "earlier (?:this|last) week"]));

const BY_SOMEONE_ELSE = (w: World) => {
  const names = w.users.flatMap((u) => [named(fullName(u)).pattern, named(u.firstName).pattern]);
  return presenting("was changed by the public API", BY_THE_API, excuse("that a user changed it, not the public API",
    [/\bnot (?:by|through|via|from) the (?:public )?API\b/, "(?:by|through|via|in|from) (?:the )?(?:web app|web|app|MCP|Distru)", "manually", "by hand", "(?:a|another) user", "users",
      ...names.map((p) => new RegExp(`\\b(?:by|from) (?:${p.source})`))],
    [...names, "web app", "MCP"]));
};

const AT_OR_ABOVE_MINIMUM = presenting("is below its minimum",
  ["(?:below|under|beneath|short of) (?:its |the |their )?(?:minimum|min|threshold|reorder point|low-stock (?:alert|level))", "below (?:its |the )?min(?:imum)? stock(?: level)?", "short by"],
  excuse("that it is at or above its minimum, or has none",
    ["no (?:minimum|min|low-stock alert|alert|threshold|reorder point)(?: set)?", "without (?:a )?(?:minimum|min|threshold|alert)", "has no min",
      /\b(?:not|isn't|aren't) below\b/, "above (?:its |the )?(?:minimum|min|threshold)", "at (?:its |the )?(?:minimum|min|threshold)"]));

const NOT_OVERDUE_ENOUGH = presenting("is more than 30 days overdue",
  ["(?:more than|over|beyond|past|at least) (?:30|thirty) days", String.raw`30\+ days`,
    String.raw`(?:3[1-9]|[4-9]\d|[1-9]\d{2,}) days (?:overdue|past due|late|past (?:its |the )?due date)`, String.raw`(?:overdue|late) (?:by )?(?:3[1-9]|[4-9]\d|[1-9]\d{2,}) days`],
  excuse("that it is 30 days overdue or less, paid or voided",
    ["under (?:the )?(?:threshold|cutoff|cut-off|line|limit|30)", "(?:within|less than|fewer than|under|below|short of) (?:the )?(?:30|thirty)", "below the (?:threshold|cutoff|line)",
      /\bnot (?:yet )?(?:more than|over|past|beyond) (?:30|thirty)\b/, /\b(?:not|n't) (?:yet )?(?:overdue|due)\b/, "(?:is|was|been|fully|now) paid", "paid (?:in full|off)", "voided", "void", "cancell?ed"]));

const OUTSIDE_TOP_TEN = presenting("is in the top ten",
  ["top (?:10|ten)", "(?:in|made|makes|make|among) the top", String.raw`(?:#|no\.?\s*|number |rank(?:ed)? )(?:[1-9]|10)(?![\d.,])`, String.raw`(?:1st|2nd|3rd|[4-9]th|10th)`, "tenth"],
  excuse("that it is outside the top ten",
    [String.raw`(?:1[1-9]|[2-9]\d)(?:st|nd|rd|th)`, "eleventh|twelfth|thirteenth", String.raw`(?:#|no\.?\s*|number |rank(?:ed)? |place[d]? )1[1-9]`,
      "outside (?:of )?the top", "(?:just )?missed", "below the top", "out of the top", /\b(?:not|didn't|doesn't|don't) (?:in|make|crack|reach|part of) the top/,
      "cancell?ed", "(?:before|prior to|outside) the quarter", "(?:previous|prior|earlier) quarter"]));

const PAID_IN_FULL = presenting("is not paid in full",
  ["unpaid", "underpaid", "owe[sd]?", "owing", "outstanding", "(?:open|remaining|unpaid|outstanding) balance", "balance (?:due|owed|left|remaining|outstanding)", String.raw`balance of \$?[1-9]`,
    "still due", "amount due", "left to pay", "overdue", "past due", "(?:partially|partly) paid", "part-paid",
    /\b(?:not|never) (?:yet )?(?:been )?(?:fully |entirely )?paid\b/, /\b(?:hasn't|haven't|has not|have not|wasn't|isn't|aren't) (?:yet )?(?:been )?(?:fully |entirely )?paid\b/],
  excuse("that it is paid in full",
    ["paid in full", "fully paid", "over-?paid", "paid off", "settled", "nothing (?:left|owed|outstanding|due|remaining)", "no balance", /\bnot underpaid\b/],
    [String.raw`\$0(?:\.00)?\s*(?:left|remaining|outstanding|owed|due|balance)`, String.raw`balance of \$?0(?:\.00)?(?![\d.,])`]));

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const OUTSIDE_LAST_MONTH = (month: { start: string; end: string }) => {
  const name = MONTH_NAMES[+month.start.slice(5, 7) - 1]!;
  return presenting("was harvested last month", ["last month", name, name.slice(0, 3)], excuse("that it was harvested in another month",
    [/\bnot (?:in )?last month\b/, /\boutside (?:of )?last month\b/],
    ["this month", "today", "yesterday", "so far", "since then", "the month before", "two months ago", ...MONTH_NAMES.filter((m) => m !== name).map((m) => `(?:in |on )${m}`)]));
};

/** A sentence that mentions the price only to say it is not what someone changed. */
const NOT_THE_PRICE = /\b(?:not|n't|other than|except|besides|apart from|rather than) (?:change )?(?:the |its )?pric/i;

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

/** The distinctive part of a Metrc error: what follows its preamble ("Metrc rejected the adjustment: ..."). */
const reasonOf = (error: string) => error.slice(error.indexOf(": ") + 1).trim();

function adjustments(w: World) {
  const yesterday = addDays(w.today, -1), dayBefore = addDays(w.today, -2);
  const label = (a: World["metrcActivities"][0]) => w.packages.find((k) => k.id === a.packageId)?.metrcLabel;
  const ofYesterday = w.metrcActivities.filter((a) => a.type === "ADJUST_PACKAGE" && dayOf(w, a.insertedAt) === yesterday);
  return {
    yesterday, dayBefore,
    failed: ofYesterday.filter((a) => a.status === "FAILED").map((a) => ({ label: label(a), reason: reasonOf(a.lastError ?? "") })),
    queued: ofYesterday.filter((a) => a.status === "QUEUED").map((a) => ({ label: label(a) })),
    dayBeforeFailures: w.metrcActivities.filter((a) => a.status === "FAILED" && dayOf(w, a.insertedAt) === dayBefore),
  };
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
  return { month, strains, harvested: rows.filter((r) => r.harvested), elsewhere: rows.filter((r) => !r.harvested && r.outside.length) };
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
  const others = api.filter((a) => dayOf(w, a.changedAt) !== yesterday);
  const byUsers = names(w.actions.filter((a) => a.source !== "PUBLIC_API" && dayOf(w, a.changedAt) === yesterday)).filter((n) => !touched.includes(n));
  return { yesterday: touched, otherDays: names(others).filter((n) => !touched.includes(n)), days: unique(others.map((a) => dayOf(w, a.changedAt))), byUsers };
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
    const { menu, out, inStock, elsewhere } = soldOut(w);
    return [
      mentionsAll("names every sold-out product on the main menu", answer, out.map(productRef)),
      namesNone("names no product of the main menu that is in stock", answer, inStock.map(productRef), IN_STOCK, out.map(productRef)),
      namesNone("names no product sold out only on another menu", answer, elsewhere.map(productRef), ON_ANOTHER_MENU(w, menu), out.map(productRef)),
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
      namesNone("names no package that is already imported", answer, imported.map((p) => tagged(p.label)), ALREADY_IMPORTED, unimported.map((p) => tagged(p.label))),
    ];
  }),

  read("compliance-yesterday-adjustments", "mcp/compliance", "Did yesterday's Metrc adjustments all go through?", (answer, w) => {
    const { failed, queued } = adjustments(w);
    // Reporting the failure is what says "no": the package (in full or by its last five characters) or the words of its
    // error after the preamble every Metrc rejection shares, rather than the word "no".
    const missed = failed.filter((f) => !(f.label && mentions(answer, tagged(f.label))) && !quotes(answer, f.reason));
    const unmentioned = queued.filter((q) => !(q.label && mentions(answer, tagged(q.label))));
    return [
      check("reports that one did not go through, identifying the failed adjustment", missed.length === 0,
        missed.map((f) => `does not identify package ${f.label} or quote its error ("${f.reason}")`).join("; ")),
      informative("mentions the adjustments still queued behind it", unmentioned.length === 0, `does not mention package ${list(unmentioned.map((q) => q.label ?? "?"))}`),
    ];
  }),

  read("compliance-manifest-packages", "mcp/compliance", "Show me the packages on incoming manifest 0001234567.", (answer, w) => {
    const { asked, others } = manifest(w);
    return [
      mentionsAll("identifies every package on the manifest", answer, asked!.packages.map((p) => tagged(p.label))),
      namesNone("names no package of another manifest", answer, others.map((p) => tagged(p.label)), ON_ANOTHER_MANIFEST(w, asked!.manifestNumber), asked!.packages.map((p) => tagged(p.label))),
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
      namesNone("names no plant group without plants in veg", answer, others.map((g) => named(g.name)), NOT_IN_VEG, [...groups.map((g) => named(g.name)), ...plants.map((p) => tagged(p.metrcLabel))]),
    ];
  }),

  read("cultivation-harvest-by-strain", "mcp/cultivation", "How much did we harvest last month, by strain?", (answer, w) => {
    const { strains, harvested, elsewhere, month } = harvestsByStrain(w);
    const refs = strains.map((s) => named(s));
    const found = mentionsOf(answer, refs);
    const rule = OUTSIDE_LAST_MONTH(month);
    const part = answerPart(answer, harvested.map((h) => named(h.strain)));
    const bare = withoutNames(refs);
    // A weight for a strain harvested only in other months counts when the strain is presented as last month's: in the
    // part of the answer that gives last month's weights, or in a remark that says it was last month.
    const weighed = elsewhere.filter((r) => {
      const weights = [...r.outside, sum(r.outside)];
      return found.some((m, i) => refs[m.ref]!.label === r.strain && presents(m, rule, part, bare)
        && numbers(answer.slice(m.end, found[i + 1]?.start ?? answer.length).split("\n")[0]! + " " + m.context).some((n) => weights.some((g) => weight(g, WEIGHT_SHARE)(n))));
    });
    return [
      valuesNear("gives each strain's wet weight harvested last month", answer,
        harvested.map((r) => ({ ref: named(r.strain), accepts: weight(r.grams, WEIGHT_SHARE), shows: `${r.grams} g` })), refs),
      check("gives no weight for strains not harvested last month", weighed.length === 0, `gives a weight for ${list(weighed.map((r) => r.strain))} as last month's, without saying ${rule.unless.says}`),
    ];
  }),

  // Directory
  read("directory-sunset-rep-buyer", "mcp/directory", "Who is the sales rep on Sunset Dispensary, and what's the buyer's email?", (answer, w) => {
    const asked = account(w, "Sunset Dispensary"), other = account(w, "Sunset Wellness Collective");
    return [
      check("gives the sales rep of Sunset Dispensary", mentions(answer, named(asked.rep!)), `missing ${asked.rep}`),
      check("gives the email of its buyer", mentions(answer, literal(asked.buyer!)), `missing ${asked.buyer}`),
      namesNone("gives neither the rep nor the buyer of Sunset Wellness Collective", answer, [named(other.rep!), literal(other.buyer!)], OF_ACCOUNT(asked.company!.name, other.company!.name),
        [named(asked.rep!), literal(asked.buyer!)]),
    ];
  }),

  read("directory-my-overdue-tasks", "mcp/directory", "Which of my tasks are overdue?", (answer, w) => {
    const { overdue, notOverdue, others } = myTasks(w);
    return [
      mentionsAll("names every overdue task of mine", answer, overdue.map(taskRef)),
      namesNone("names none of my tasks that are done or not yet due", answer, notOverdue.map(taskRef), NOT_YET_DUE, overdue.map(taskRef)),
      namesNone("names no task of another user", answer, others.map(taskRef), SOMEONE_ELSES(w), overdue.map(taskRef)),
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
    const credited = sentences(answer).filter((s) => mentions(s, price) && !NOT_THE_PRICE.test(s)).map((s) => firstMentioned(s, actors)).filter((a) => a && a !== actor);
    const day = dayOf(w, change!.changedAt);
    return [
      check("names who changed the price", mentions(answer, actor), `missing ${change!.actorName}`),
      check("gives the date of the change", mentions(answer, onDay(day)), `missing ${day}`),
      check("does not credit anyone else with the price change", credited.length === 0, `ties the price to ${list(unique(credited.map((a) => a!.label)))}`),
    ];
  }),

  read("history-public-api-yesterday", "mcp/history", "What did the public API change yesterday?", (answer, w) => {
    const { yesterday, otherDays, days, byUsers } = apiChanges(w);
    return [
      mentionsAll("names every record the public API changed yesterday", answer, yesterday.map(recordRef)),
      namesNone("names no record the public API changed on another day", answer, otherDays.map(recordRef), ON_ANOTHER_DAY(addDays(w.today, -1), days), yesterday.map(recordRef)),
      namesNone("names no record only users changed yesterday", answer, byUsers.map(recordRef), BY_SOMEONE_ELSE(w), yesterday.map(recordRef)),
    ];
  }),

  // Inventory
  read("inventory-below-minimum", "mcp/inventory", "Which products are below their minimum stock level?", (answer, w) => {
    const { below, others } = stockLevels(w);
    return [
      mentionsAll("names every product below its minimum", answer, below.map(productRef)),
      namesNone("names no product at or above its minimum, or without one", answer, others.map(productRef), AT_OR_ABOVE_MINIMUM, below.map(productRef)),
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
      namesNone("lists no invoice overdue 30 days or less, paid or voided", answer, wrong.map(ref), NOT_OVERDUE_ENOUGH, overdue.map(ref)),
    ];
  }),

  read("orders-top-customers", "mcp/orders", "Who were our top 10 customers by revenue last quarter?", (answer, w) => {
    const ranked = customerRanking(w);
    const top = ranked.slice(0, 10).map((r) => named(r.company.name));
    // The order of a ranking is worth measuring, but "who were our top 10" does not strictly ask for it.
    const first = top.map((ref) => mentionsOf(answer, [ref])[0]?.start ?? -1);
    const inOrder = first.every((at, i) => at >= 0 && (i === 0 || at > first[i - 1]!));
    return [
      mentionsAll("names the ten customers with the most revenue last quarter", answer, top),
      namesNone("names no customer outside the top ten", answer, ranked.slice(10).map((r) => named(r.company.name)), OUTSIDE_TOP_TEN, top),
      informative("names the ten in descending order of revenue", inOrder, `first named in this order: ${list(top.map((r, i) => ({ r, at: first[i]! })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at).map((x) => x.r.label), 10)}`),
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
      namesNone("lists no purchase order paid in full", answer, paid.map((po) => numbered(po.purchaseNumber)), PAID_IN_FULL, unpaid.map((po) => numbered(po.purchaseNumber))),
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
      check("it is not voided and uses an existing payment method", !!payment && payment.voidedAt === null && before.paymentMethods.some((m) => m.id === payment.paymentMethodId),
        payment ? `voided: ${payment.voidedAt !== null}, payment method: ${payment.paymentMethodId}` : none),
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
  need("compliance-yesterday-adjustments", adj.failed.length === 1 && adj.failed[0]!.label, `${adj.failed.length} adjustments of known packages failed yesterday, not one`);
  need("compliance-yesterday-adjustments", adj.failed.every((f) => quotes(f.reason, f.reason)), "the failure's error has no reason of four words or more");
  need("compliance-yesterday-adjustments", adj.queued.length && adj.queued.every((q) => q.label), "no adjustment of yesterday is queued behind the failure");
  need("compliance-yesterday-adjustments", !adj.dayBeforeFailures.length, "an activity of the day before yesterday failed");
  none("compliance-yesterday-adjustments", w.licenses.filter((l) => w.metrcActivities.filter((a) => a.licenseId === l.id && a.status === "FAILED").length > 1).map((l) => l.licenseNumber),
    "licenses with more than one FAILED activity, which the documentation rules out");
  none("compliance-yesterday-adjustments", sameEnding([...adj.failed, ...adj.queued].map((f) => f.label ?? "")), "failed and queued packages share their last five characters");

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
  need("history-public-api-yesterday", api.byUsers.length, "no user changed a record yesterday that the public API did not");

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
