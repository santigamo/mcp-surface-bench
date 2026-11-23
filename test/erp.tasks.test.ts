import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { addDays, dayIn } from "../src/core/kit.ts";
import { clock, createWorld, lastMonth, quarter } from "../suites/erp/seed.ts";
import { preflight, tasks } from "../suites/erp/tasks.ts";
import { activeQuantity, availableQuantity, belowMinimum, fullName, invoiceMoney, newId, orderTotal, purchaseMoney, purchaseTotal, type Product, type World } from "../suites/erp/world.ts";
import { TODAY } from "./helpers.ts";

// ---------- the world of TODAY, and facts about it computed here rather than taken from the graders ----------

const W = createWorld(TODAY);
const NOW = clock(TODAY).getTime();
const day = (iso: string) => dayIn(W.timezone, new Date(iso));
const longDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const product = (name: string) => W.products.find((p) => p.name === name)!;
const company = (name: string) => W.companies.find((c) => c.name === name)!;
const location = (name: string) => W.locations.find((l) => l.name === name)!;
const menuProducts = (name: string) => W.menus.find((m) => m.name === name)!.products.map((x) => W.products.find((p) => p.id === x.productId)!);
const userName = (id: string | null) => fullName(W.users.find((u) => u.id === id)!);
const buyerOf = (companyId: string) => W.contacts.find((k) => k.companyId === companyId && k.title === "Buyer")!;
const table = (head: string[], rows: (string | number)[][]) => [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------- grading ----------

const task = (id: string) => {
  const found = tasks.find((t) => t.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

/** The names of the required checks that fail, once each failure is shown to say why. */
function failures(id: string, answer: string, after: World = W): string[] {
  const checks = task(id).grade({ answer, before: W, after });
  for (const c of checks) if (!c.pass) expect(c.detail, `"${c.name}" fails without a detail`).toBeTruthy();
  return checks.filter((c) => !c.pass && c.required !== false).map((c) => c.name);
}

/** The names of the informative checks (reported, not deciding the run) that fail. */
function notes(id: string, answer: string): string[] {
  return task(id).grade({ answer, before: W, after: W }).filter((c) => !c.pass && c.required === false).map((c) => c.name);
}

/** A copy of the world after a write: `change` edits it, and the write is logged the way the tools log one. */
function written(change: (w: World) => void): World {
  const w = structuredClone(W);
  change(w);
  w.actions.push({ id: newId(w, "act"), changedAt: new Date(NOW).toISOString(), actorId: w.me, actorName: userName(w.me), source: "MCP", sourceDetail: null, records: [] });
  return w;
}

// ---------- the suite ----------

describe("the task list", () => {
  const readme = readFileSync(new URL("../suites/erp/README.md", import.meta.url), "utf8");
  const rows = readme.slice(readme.indexOf("## The tasks")).split("\n").flatMap((line) => {
    const m = /^\| (\w+) \| (.+) \|$/.exec(line);
    return m && m[1] !== "Area" ? [{ area: m[1]!.toLowerCase(), prompt: m[2]! }] : [];
  });

  test("has the 25 prompts of the README, word for word, each once", () => {
    expect(rows).toHaveLength(25);
    expect(tasks.map((t) => t.prompt).sort()).toEqual(rows.map((r) => r.prompt).sort());
  });

  test("ids are unique slugs of the area, and sources the area's page", () => {
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    for (const t of tasks) {
      const { area } = rows.find((r) => r.prompt === t.prompt)!;
      expect(t.id).toMatch(new RegExp(`^${area}-[a-z0-9]+(-[a-z0-9]+)*$`));
      expect(t.source).toBe(`mcp/${area}`);
    }
  });
});

describe("preflight", () => {
  test("is clean today", () => expect(preflight(W)).toEqual([]));

  // The one degenerate stretch: in a year's first 20 days the seed places no regular purchase orders (their payments
  // would fall after today), so "this year" holds at most two vendors' and the vendor-spend task has nothing to rank.
  // Every other day of 2026 and 2027 grades all 25 tasks.
  const EARLY_JANUARY = "purchasing-vendor-spend: fewer than three vendors have purchase orders this year";
  const degenerate = (date: string) => date.slice(5, 7) === "01" && +date.slice(8) <= 20;
  const days: string[] = [];
  for (let d = "2026-01-01"; d <= "2027-12-31"; d = addDays(d, 1)) days.push(d);

  test("on every day of 2026 and 2027", () => {
    const unexpected = days.flatMap((date) => {
      const problems = preflight(createWorld(date));
      const expected = degenerate(date) ? [EARLY_JANUARY] : [];
      return JSON.stringify(problems) === JSON.stringify(expected) ? [] : [`${date}: ${problems.join("; ") || "clean, but expected to be degenerate"}`];
    });
    expect(unexpected).toEqual([]);
  }, 60_000);

  test("reports what makes a world ungradable", () => {
    const w = structuredClone(W);
    w.tasks = w.tasks.filter((t) => t.ownerId !== w.me);
    w.metrcManifests = w.metrcManifests.slice(0, 1);
    w.harvests = [];
    const problems = preflight(w);
    expect(problems).toContain("directory-my-overdue-tasks: none of my tasks is overdue");
    expect(problems).toContain("compliance-manifest-packages: no other manifest has packages");
    expect(problems).toContain("cultivation-harvest-by-strain: fewer than two strains were harvested last month");
  });
});

// ---------- one block per task: a correct answer passes, wrong ones fail on the check they should ----------

describe("catalog-lab-dropdown", () => {
  const id = "catalog-lab-dropdown";
  const withField = (field: Partial<World["customFields"][0]>) => written((w) => {
    w.customFields.push({ id: newId(w, "cf"), entityType: "PACKAGE", name: "Lab", fieldType: "DROPDOWN", description: null, required: false, options: ["Steep Hill", "SC Labs"], ...field });
  });

  test("a Lab dropdown on packages passes", () => expect(failures(id, "", withField({}))).toEqual([]));
  test("on the wrong entity", () => expect(failures(id, "", withField({ entityType: "PRODUCT" }))).toEqual(["the field is for packages"]));
  test("with a missing option", () => expect(failures(id, "", withField({ options: ["SC Labs"] }))).toEqual(["its options are exactly SC Labs and Steep Hill"]));
  test("as a text field", () => expect(failures(id, "", withField({ fieldType: "TEXT", options: [] }))).toEqual(["the field is a dropdown", "its options are exactly SC Labs and Steep Hill"]));
  test("by editing the existing package dropdown instead", () => {
    const after = written((w) => {
      w.customFields.find((f) => f.entityType === "PACKAGE")!.options.push("SC Labs", "Steep Hill");
    });
    expect(failures(id, "", after)).toEqual(["adds exactly one custom field", "the field is for packages", "the field is named Lab", "the field is a dropdown", "its options are exactly SC Labs and Steep Hill", "changes nothing else"]);
  });
});

describe("catalog-tag-prerolls", () => {
  const id = "catalog-tag-prerolls";
  const promo = W.tags.find((t) => t.name === "Summer promo")!.id;
  const prerolls = W.products.filter((p) => p.categoryId === W.categories.find((c) => c.name === "Pre-Rolls")!.id);
  const tag = (pick: (p: Product) => boolean, how: (p: Product) => void = (p) => p.tagIds.includes(promo) || p.tagIds.push(promo)) =>
    written((w) => w.products.filter(pick).forEach((p) => { how(p); p.updatedAt = new Date(NOW).toISOString(); }));
  const isPreroll = (p: Product) => prerolls.some((x) => x.id === p.id);

  test("tagging the active pre-rolls passes", () => expect(failures(id, "", tag((p) => isPreroll(p) && p.active))).toEqual([]));
  test("tagging the discontinued one too passes", () => expect(failures(id, "", tag(isPreroll))).toEqual([]));
  test("missing one", () => {
    const skipped = prerolls.find((p) => p.active)!.id;
    expect(failures(id, "", tag((p) => isPreroll(p) && p.active && p.id !== skipped))).toEqual(["tags every active pre-roll Summer promo"]);
  });
  test("replacing the tags they had", () => expect(failures(id, "", tag(isPreroll, (p) => { p.tagIds = [promo]; }))).toEqual(["keeps the tags products already had"]));
  test("tagging a flower product too", () => expect(failures(id, "", tag((p) => isPreroll(p) || p.name === "Blue Dream 3.5g"))).toEqual(["changes no product outside Pre-Rolls"]));
  test("adding another tag", () => {
    const clearance = W.tags.find((t) => t.name === "Clearance")!.id;
    expect(failures(id, "", tag(isPreroll, (p) => p.tagIds.push(promo, clearance)))).toEqual(["adds no tag but Summer promo"]);
  });
});

describe("commerce-main-menu-sold-out", () => {
  const id = "commerce-main-menu-sold-out";
  const main = menuProducts("Main Wholesale Menu");
  const out = main.filter((p) => availableQuantity(W, p) <= 0);
  const elsewhere = W.menus.flatMap((m) => menuProducts(m.name)).filter((p) => availableQuantity(W, p) <= 0 && !main.includes(p));
  const answer = (names: string[]) => `These are sold out on the Main Wholesale Menu:\n${bullets(names.map((n) => `${n} (0 available)`))}`;

  test("the seed's four", () => expect(out).toHaveLength(4));
  test("a bullet list of them passes", () => expect(failures(id, answer(out.map((p) => p.name)))).toEqual([]));
  test("missing one", () => expect(failures(id, answer(out.slice(1).map((p) => p.name)))).toEqual(["names every sold-out product on the main menu"]));
  test("adding one sold out on another menu", () => expect(failures(id, answer([...out, ...elsewhere].map((p) => p.name)))).toEqual(["names no product sold out only on another menu"]));
  test("adding one in stock", () => expect(failures(id, answer([...out.map((p) => p.name), "Blue Dream 7g"]))).toEqual(["names no product of the main menu that is in stock"]));
});

describe("commerce-spring-flower-thc", () => {
  const id = "commerce-spring-flower-thc";
  const flower = menuProducts("Spring Menu").filter((p) => p.categoryId === W.categories.find((c) => c.name === "Flower")!.id);
  const thc = flower.map((p) => p.thcPercent!);

  test("a table passes", () => expect(failures(id, table(["Product", "THC"], flower.map((p, i) => [p.name, `${thc[i]!.toFixed(2)} %`])))).toEqual([]));
  test("prose with fractions passes", () => expect(failures(id, flower.map((p, i) => `${p.name} shows ${(thc[i]! / 100).toFixed(3)} THC`).join("; "))).toEqual([]));
  test("two values swapped", () => {
    const swapped = [thc[1]!, thc[0]!, ...thc.slice(2)];
    expect(failures(id, table(["Product", "THC"], flower.map((p, i) => [p.name, `${swapped[i]}%`])))).toEqual(["gives the THC of each flower product on the Spring Menu"]);
  });
  test("values rounded to whole percents", () => expect(failures(id, table(["Product", "THC"], flower.map((p, i) => [p.name, `${Math.round(thc[i]!)}%`])))).toEqual(["gives the THC of each flower product on the Spring Menu"]));
});

describe("commerce-bay-area-ordering", () => {
  const id = "commerce-bay-area-ordering";
  const bay = (w: World) => w.menus.find((m) => m.name === "Bay Area Menu")!;
  const change = (edit: (m: World["menus"][0], w: World) => void) => written((w) => { edit(bay(w), w); bay(w).updatedAt = new Date(NOW).toISOString(); });

  test.each([
    ["deactivating it", (m: World["menus"][0]) => { m.active = false; }, "reading taken: active set to false"],
    ["closing partner orders", (m: World["menus"][0]) => { m.allowPartnerOrders = false; }, "reading taken: allowPartnerOrders set to false"],
    ["hiding prices from everyone", (m: World["menus"][0]) => { m.hidePricesMode = "HIDE_FOR_EVERYONE"; }, "reading taken: hidePricesMode set to HIDE_FOR_EVERYONE"],
  ])("%s passes and says so", (_, edit, reading) => {
    const checks = task(id).grade({ answer: "", before: W, after: change(edit) });
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(checks[0]!.detail).toBe(reading);
  });
  test("hiding prices only from visitors", () => expect(failures(id, "", change((m) => { m.hidePricesMode = "HIDE_FOR_NON_LOGGED_IN_USERS"; }))).toEqual(["turns off ordering on the Bay Area Menu", "changes nothing else on the Bay Area Menu"]));
  test("changing another setting too", () => expect(failures(id, "", change((m) => { m.active = false; m.minimumOrderSubtotal = 0; }))).toEqual(["changes nothing else on the Bay Area Menu"]));
  test("turning off another menu too", () => expect(failures(id, "", change((m, w) => { m.active = false; w.menus.find((x) => x.name === "Spring Menu")!.active = false; }))).toEqual(["changes no other menu or record"]));
});

describe("compliance-unimported-packages", () => {
  const id = "compliance-unimported-packages";
  const unimported = W.metrcPackages.filter((p) => p.importStatus === "UNIMPORTED");
  const imported = W.metrcPackages.filter((p) => p.importStatus === "IMPORTED");
  const prose = (labels: string[]) => `${labels.length} Metrc packages are not in Distru yet: the ones ending in ${labels.map((l) => l.slice(-5)).join(", ")}.`;

  test("their last digits in prose pass", () => expect(failures(id, prose(unimported.map((p) => p.label)))).toEqual([]));
  test("their full tags in a table pass", () => expect(failures(id, table(["Tag", "Item", "License"], unimported.map((p) => [p.label, p.itemName, p.licenseId])))).toEqual([]));
  test("only the distribution license's", () => expect(failures(id, prose(unimported.filter((p) => p.licenseId === W.licenses[0]!.id).map((p) => p.label)))).toEqual(["identifies every unimported Metrc package, on both licenses"]));
  test("with an imported one", () => expect(failures(id, prose([...unimported, imported[0]!].map((p) => p.label)))).toEqual(["names no package that is already imported"]));
});

describe("compliance-yesterday-adjustments", () => {
  const id = "compliance-yesterday-adjustments";
  const yesterday = addDays(TODAY, -1);
  const adjustments = W.metrcActivities.filter((a) => a.type === "ADJUST_PACKAGE" && day(a.insertedAt) === yesterday);
  const failed = adjustments.find((a) => a.status === "FAILED")!, queued = adjustments.filter((a) => a.status === "QUEUED");
  const label = (a: World["metrcActivities"][0]) => W.packages.find((k) => k.id === a.packageId)!.metrcLabel;
  const reason = failed.lastError!.split(": ")[1]!;

  test("the seed: one failed in the afternoon, and at least one queued behind it", () => {
    expect(adjustments.filter((a) => a.status === "FAILED")).toHaveLength(1);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((q) => q.insertedAt > failed.insertedAt)).toBe(true);
  });
  test("naming the failed package passes", () => expect(failures(id, `No. One of yesterday's adjustments failed: package ${label(failed)}. Metrc said: ${failed.lastError}`)).toEqual([]));
  test("its last five characters pass", () => expect(failures(id, `Not all: the adjustment of package …${label(failed).slice(-5)} failed.`)).toEqual([]));
  test("quoting its error passes", () => expect(failures(id, `Not all of them: one was rejected because ${reason}`)).toEqual([]));
  test("saying they all went through", () => expect(failures(id, "Yes, all of yesterday's adjustments went through.")).toEqual(["reports that one did not go through, identifying the failed adjustment"]));
  test("only the preamble every Metrc rejection shares does not identify it", () => {
    expect(failures(id, "No: Metrc rejected the adjustment.")).toEqual(["reports that one did not go through, identifying the failed adjustment"]);
  });
  test("mentioning the queued ones is reported, not required", () => {
    const answer = `No. The adjustment of package ${label(failed)} failed`;
    expect(notes(id, `${answer}.`)).toEqual(["mentions the adjustments still queued behind it"]);
    expect(notes(id, `${answer}, and ${queued.map((q) => label(q).slice(-5)).join(" and ")} are queued behind it.`)).toEqual([]);
  });
});

describe("compliance-manifest-packages", () => {
  const id = "compliance-manifest-packages";
  const [asked, ...others] = [W.metrcManifests.find((m) => m.manifestNumber === "0001234567")!, ...W.metrcManifests.filter((m) => m.manifestNumber !== "0001234567")];
  const answer = (packages: World["metrcManifests"][0]["packages"]) => table(["Package", "Item", "Quantity"], packages.map((p) => [p.label, p.itemName, p.quantity]));

  test("a table of them passes", () => expect(failures(id, answer(asked.packages))).toEqual([]));
  test("missing one", () => expect(failures(id, answer(asked.packages.slice(0, -1)))).toEqual(["identifies every package on the manifest"]));
  test("with one from the next manifest", () => expect(failures(id, answer([...asked.packages, others[0]!.packages[0]!]))).toEqual(["names no package of another manifest"]));
});

describe("costing-inventory-value", () => {
  const id = "costing-inventory-value";
  const value = (products: Product[], unit: (p: Product) => number) => products.reduce((n, p) => n + activeQuantity(W, p) * unit(p), 0);
  const active = W.products.filter((p) => p.active);

  test("the value at price, rounded to thousands, passes and says which", () => {
    const checks = task(id).grade({ answer: `About $${(value(active, (p) => p.unitPrice) / 1000).toFixed(1)}k at list price.`, before: W, after: W });
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks[0]!.detail).toStartWith("matched the value at unit price");
  });
  test("the value at cost passes", () => expect(failures(id, `At cost it is ${Math.round(value(active, (p) => p.unitCost)).toLocaleString("en-US")}.`)).toEqual([]));
  test("counting the discontinued product", () => expect(failures(id, `It is worth ${money(value(W.products, (p) => p.unitPrice))}.`)).toEqual(["gives the value of stock on hand"]));
  test("a rough figure", () => expect(failures(id, `Roughly $${Math.round(value(active, (p) => p.unitPrice) * 0.97).toLocaleString("en-US")}.`)).toEqual(["gives the value of stock on hand"]));
});

describe("costing-category-margin", () => {
  const id = "costing-category-margin";
  const q = quarter(TODAY, 1);
  const lines = W.salesOrders.filter((o) => o.status === "COMPLETED" && day(o.orderDatetime) >= q.start && day(o.orderDatetime) <= q.end).flatMap((o) => o.items);
  const rows = W.categories.map((c) => {
    const mine = lines.filter((i) => W.products.find((p) => p.id === i.productId)!.categoryId === c.id);
    const revenue = mine.reduce((n, i) => n + i.quantity * i.unitPrice, 0), profit = mine.reduce((n, i) => n + i.quantity * (i.unitPrice - i.unitCost), 0);
    return { name: c.name, profit, margin: (profit / revenue) * 100 };
  });
  const prose = (margins: number[]) => `Last quarter, by category: ${rows.map((r, i) => `${r.name} at ${margins[i]!.toFixed(1)}%`).join(", ")}.`;

  test("margins in prose pass", () => expect(failures(id, prose(rows.map((r) => r.margin)))).toEqual([]));
  test("profits in a table pass", () => expect(failures(id, table(["Category", "Gross profit"], rows.map((r) => [r.name, money(r.profit)])))).toEqual([]));
  test("two margins swapped", () => {
    const m = rows.map((r) => r.margin);
    expect(failures(id, prose([m[1]!, m[0]!, ...m.slice(2)]))).toEqual(["gives each category's margin or profit"]);
  });
  test("a category left out", () => {
    expect(failures(id, rows.slice(1).map((r) => `${r.name}: ${r.margin.toFixed(1)}%`).join("\n"))).toEqual(["gives each category's margin or profit"]);
  });
});

describe("cultivation-plants-in-veg", () => {
  const id = "cultivation-plants-in-veg";
  const veg = W.plants.filter((p) => p.status === "VEGETATIVE");
  const groups = W.plantGroups.filter((g) => veg.some((p) => p.plantGroupId === g.id));
  const byGroup = (count: number) => `${count} plants are in veg: ${groups.map((g) => `${g.name} (${veg.filter((p) => p.plantGroupId === g.id).length})`).join(" and ")}.`;

  test("the groups and the count pass", () => expect(failures(id, byGroup(veg.length))).toEqual([]));
  test("the plant tags pass", () => expect(failures(id, bullets(veg.map((p) => p.metrcLabel)))).toEqual([]));
  test("a wrong count", () => expect(failures(id, byGroup(veg.length - 1))).toEqual(["gives the plants in veg, by label or by group with their count"]));
  test("adding the immature group in the veg room", () => {
    const immature = W.plantGroups.find((g) => W.plants.some((p) => p.plantGroupId === g.id && p.status === "IMMATURE"))!;
    expect(failures(id, `${byGroup(veg.length)} ${immature.name} is in the Veg Room too.`)).toEqual(["names no plant group without plants in veg"]);
  });
});

describe("cultivation-harvest-by-strain", () => {
  const id = "cultivation-harvest-by-strain";
  const month = lastMonth(TODAY);
  const grams = (strain: string, from: string, to: string) => W.harvests.filter((h) => h.strainName === strain && day(h.harvestedAt) >= from && day(h.harvestedAt) <= to).reduce((n, h) => n + h.wetWeight, 0);
  const strains = [...new Set(W.harvests.filter((h) => day(h.harvestedAt) >= month.start && day(h.harvestedAt) <= month.end).map((h) => h.strainName))];
  const kg = (rows: [string, number][]) => table(["Strain", "Wet weight"], rows.map(([s, g]) => [s, `${(g / 1000).toFixed(2)} kg`]));
  const right = strains.map((s): [string, number] => [s, grams(s, month.start, month.end)]);

  test("a table in kilograms passes", () => expect(failures(id, kg(right))).toEqual([]));
  test("grams in prose, with a strain said to have none, pass", () => {
    expect(failures(id, `${right.map(([s, g]) => `${s} gave ${g.toLocaleString("en-US")} g`).join(", ")}. OG Kush had no harvest last month.`)).toEqual([]);
  });
  test("counting this month's harvests too", () => {
    expect(failures(id, kg(strains.map((s) => [s, grams(s, month.start, TODAY)])))).toEqual(["gives each strain's wet weight harvested last month"]);
  });
  test("adding a strain harvested this month", () => {
    expect(failures(id, kg([...right, ["OG Kush", grams("OG Kush", month.start, TODAY)]]))).toEqual(["gives no weight for strains not harvested last month"]);
  });
});

describe("directory-sunset-rep-buyer", () => {
  const id = "directory-sunset-rep-buyer";
  const asked = company("Sunset Dispensary"), other = company("Sunset Wellness Collective");
  const answer = (c: typeof asked, email = buyerOf(c.id).email) => `${userName(c.ownerId)} is the sales rep on ${asked.name}. The buyer is ${fullName(buyerOf(c.id))}: ${email}.`;

  test("the rep and the buyer's email pass", () => expect(failures(id, answer(asked))).toEqual([]));
  test("those of Sunset Wellness Collective", () => {
    expect(failures(id, answer(other))).toEqual(["gives the sales rep of Sunset Dispensary", "gives the email of its buyer", "gives neither the rep nor the buyer of Sunset Wellness Collective"]);
  });
  test("the accounts payable email instead", () => {
    const ap = W.contacts.find((k) => k.companyId === asked.id && k.title !== "Buyer")!;
    expect(failures(id, answer(asked, ap.email))).toEqual(["gives the email of its buyer"]);
  });
});

describe("directory-my-overdue-tasks", () => {
  const id = "directory-my-overdue-tasks";
  const overdue = (t: World["tasks"][0]) => t.status === "ACTIVE" && Date.parse(t.dueDate) < NOW;
  const mine = W.tasks.filter((t) => t.ownerId === W.me);
  // Each task in its own words after the first four.
  const answer = (ts: World["tasks"]) => `You have ${ts.length} overdue tasks:\n${bullets(ts.map((t) => `${t.name.split(" ").slice(0, 4).join(" ")}… (was due ${longDate(day(t.dueDate))})`))}`;

  test("a list of mine that are overdue passes", () => expect(failures(id, answer(mine.filter(overdue)))).toEqual([]));
  test("adding the one due later today", () => {
    expect(failures(id, answer([...mine.filter(overdue), mine.find((t) => day(t.dueDate) === TODAY)!]))).toEqual(["names none of my tasks that are done or not yet due"]);
  });
  test("adding a colleague's", () => {
    expect(failures(id, answer([...mine.filter(overdue), W.tasks.find((t) => t.ownerId !== W.me && overdue(t))!]))).toEqual(["names no task of another user"]);
  });
});

describe("directory-add-contact", () => {
  const id = "directory-add-contact";
  const add = (contact: Partial<World["contacts"][0]>, at = "Sunset Dispensary") => written((w) => {
    w.contacts.push({ id: newId(w, "con"), companyId: company(at).id, firstName: "Jane", lastName: "Lee", title: "Purchasing Manager", email: null, phone: null, ownerId: null, createdAt: new Date(NOW).toISOString(), ...contact });
  });

  test("Jane Lee at Sunset Dispensary passes", () => expect(failures(id, "", add({}))).toEqual([]));
  test("at Sunset Wellness Collective", () => expect(failures(id, "", add({}, "Sunset Wellness Collective"))).toEqual(["she is a contact at Sunset Dispensary"]));
  test("with another title", () => expect(failures(id, "", add({ title: "Purchasing" }))).toEqual(["her title is purchasing manager"]));
  test("added twice", () => {
    const twice = add({});
    twice.contacts.push({ ...twice.contacts.at(-1)!, id: newId(twice, "con") });
    expect(failures(id, "", twice)).toEqual(["adds exactly one contact"]);
  });
});

describe("history-price-change-so-1042", () => {
  const id = "history-price-change-so-1042";
  const order = W.salesOrders.find((o) => o.orderNumber === "SO-1042")!;
  const history = W.actions.filter((a) => a.records.some((r) => r.id === order.id));
  const change = history.find((a) => a.records.some((r) => r.fields.some((f) => f.field === "priceBase")))!;
  const someoneElse = history.find((a) => a.actorName !== change.actorName)!;

  test("prose passes", () => expect(failures(id, `${change.actorName} changed the price of Wedding Cake 3.5g on SO-1042 from $24.00 to $19.50 on ${longDate(day(change.changedAt))}.`)).toEqual([]));
  test("the whole history as a table passes", () => {
    const rows = history.map((a) => [day(a.changedAt), a.actorName, a.records[0]!.fields[0]?.label ?? "Created the order"]);
    expect(failures(id, table(["Date", "Who", "What"], rows))).toEqual([]);
  });
  test("the wrong person", () => {
    expect(failures(id, `${someoneElse.actorName} changed the price on ${longDate(day(change.changedAt))}.`)).toEqual(["names who changed the price", "does not credit anyone else with the price change"]);
  });
  test("the wrong date", () => expect(failures(id, `${change.actorName} changed the price on ${longDate(day(someoneElse.changedAt))}.`)).toEqual(["gives the date of the change"]));
  test("crediting someone else first", () => {
    expect(failures(id, `${someoneElse.actorName} and ${change.actorName} changed the price on ${longDate(day(change.changedAt))}.`)).toEqual(["does not credit anyone else with the price change"]);
  });
});

describe("history-public-api-yesterday", () => {
  const id = "history-public-api-yesterday";
  const api = W.actions.filter((a) => a.source === "PUBLIC_API");
  const touched = (pick: (d: string) => boolean) => [...new Set(api.filter((a) => pick(day(a.changedAt))).flatMap((a) => a.records.map((r) => r.name)))];
  const yesterday = touched((d) => d === addDays(TODAY, -1));
  const answer = (names: string[]) => `Yesterday the public API (storefront sync) changed:\n${bullets(names.map((n) => `**${n}**`))}`;

  test("a list of what it touched passes", () => expect(failures(id, answer(yesterday))).toEqual([]));
  test("missing the order it created", () => expect(failures(id, answer(yesterday.filter((n) => !n.startsWith("SO-"))))).toEqual(["names every record the public API changed yesterday"]));
  test("adding this morning's change", () => expect(failures(id, answer([...yesterday, ...touched((d) => d === TODAY)]))).toEqual(["names no record the public API changed on another day"]));
});

describe("inventory-below-minimum", () => {
  const id = "inventory-below-minimum";
  const below = W.products.filter((p) => belowMinimum(W, p));
  const answer = (ps: Product[]) => table(["Product", "Available", "Minimum"], ps.map((p) => [p.name, availableQuantity(W, p), p.thresholdMin ?? "none"]));

  test("a table of them passes", () => expect(failures(id, answer(below))).toEqual([]));
  test("missing the one held by open orders", () => {
    expect(failures(id, answer(below.filter((p) => activeQuantity(W, p) < p.thresholdMin!)))).toEqual(["names every product below its minimum"]);
  });
  test("adding a low product with no minimum", () => expect(failures(id, answer([...below, product("Milk Chocolate Bar 100mg")]))).toEqual(["names no product at or above its minimum, or without one"]));
});

describe("inventory-move-blue-dream", () => {
  const id = "inventory-move-blue-dream";
  const blueDream = product("Blue Dream 3.5g");
  const [vault, shipping] = [location("Vault"), location("Shipping Room")];
  const move = (from: string, to: string, quantity: number, transfer = true) => written((w) => {
    const batch = w.batches.find((b) => b.productId === blueDream.id)!;
    batch.stock.find((s) => s.locationId === from)!.quantity -= quantity;
    if (to) batch.stock.find((s) => s.locationId === to)!.quantity += quantity;
    if (transfer) w.stockTransfers.push({ id: newId(w, "stt"), number: "ST-1", fromLocationId: from, toLocationId: to, items: [{ productId: blueDream.id, batchId: batch.id, quantity }], description: null, transferDatetime: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString() });
  });

  test("a transfer of 20 from the vault to shipping passes", () => expect(failures(id, "", move(vault.id, shipping.id, 20))).toEqual([]));
  test("moving the stock without recording a transfer", () => expect(failures(id, "", move(vault.id, shipping.id, 20, false))).toEqual(["records one transfer of 20 units from the Vault to the Shipping Room"]));
  test("moving it the other way", () => {
    expect(failures(id, "", move(shipping.id, vault.id, 10))).toEqual(["takes 20 units of Blue Dream 3.5g out of the Vault", "puts 20 units into the Shipping Room", "records one transfer of 20 units from the Vault to the Shipping Room"]);
  });
  test("moving Blue Dream 7g instead", () => {
    const after = written((w) => {
      const pkg = w.packages.find((k) => k.productId === product("Blue Dream 7g").id && k.locationId === vault.id)!;
      pkg.quantity -= 20;
      w.packages.push({ ...pkg, id: newId(w, "pkg"), quantity: 20, locationId: shipping.id });
      w.stockTransfers.push({ id: newId(w, "stt"), number: "ST-1", fromLocationId: vault.id, toLocationId: shipping.id, items: [{ productId: pkg.productId, batchId: null, quantity: 20 }], description: null, transferDatetime: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString() });
    });
    expect(failures(id, "", after)).toEqual(["takes 20 units of Blue Dream 3.5g out of the Vault", "puts 20 units into the Shipping Room", "records one transfer of 20 units from the Vault to the Shipping Room", "changes no other product's stock", "changes nothing else"]);
  });
});

describe("orders-overdue-invoices", () => {
  const id = "orders-overdue-invoices";
  const late = (i: World["invoices"][0]) => (NOW - Date.parse(i.dueDatetime)) / 86_400_000;
  const owing = (i: World["invoices"][0]) => !i.voided && invoiceMoney(W, i).remaining > 0;
  const overdue = W.invoices.filter((i) => owing(i) && late(i) > 30);
  const customer = (i: World["invoices"][0]) => W.companies.find((c) => c.id === i.customerId)!.name;
  const rows = (invoices: World["invoices"]) => invoices.map((i) => [i.invoiceNumber, customer(i), money(invoiceMoney(W, i).remaining), Math.floor(late(i)), userName(i.ownerId)]);
  const asTable = (invoices: World["invoices"]) => table(["Invoice", "Customer", "Balance", "Days overdue", "Sales rep"], rows(invoices));

  test("the seed's four", () => expect(overdue).toHaveLength(4));
  test("a table passes", () => expect(failures(id, asTable(overdue))).toEqual([]));
  test("grouped under each rep passes", () => {
    const reps = [...new Set(overdue.map((i) => i.ownerId))];
    expect(failures(id, reps.map((r) => `**${userName(r)}**\n${bullets(overdue.filter((i) => i.ownerId === r).map((i) => `${i.invoiceNumber.replace("INV", "SO")}: ${customer(i)}`))}`).join("\n\n"))).toEqual([]);
  });
  test("details under each invoice pass", () => {
    expect(failures(id, overdue.map((i) => `### Invoice ${i.invoiceNumber.slice(4)}\n- Customer: ${customer(i)}\n- Sales rep: ${userName(i.ownerId)}`).join("\n\n"))).toEqual([]);
  });
  test("adding one 27 days overdue", () => {
    const recent = W.invoices.find((i) => owing(i) && late(i) > 0 && late(i) <= 30)!;
    expect(failures(id, asTable([...overdue, recent]))).toEqual(["lists no invoice overdue 30 days or less, paid or voided"]);
  });
  test("adding the voided one", () => expect(failures(id, asTable([...overdue, W.invoices.find((i) => i.voided)!]))).toEqual(["lists no invoice overdue 30 days or less, paid or voided"]));
  test("the wrong rep on one", () => {
    const wrong = rows(overdue);
    wrong[0]![4] = W.users.map(fullName).find((n) => n !== wrong[0]![4])!;
    expect(failures(id, table(["Invoice", "Customer", "Balance", "Days overdue", "Sales rep"], wrong))).toEqual(["gives the sales rep of each"]);
  });
  test("missing one", () => expect(failures(id, asTable(overdue.slice(1)))).toEqual(["lists every invoice more than 30 days overdue", "gives the sales rep of each"]));
});

describe("orders-top-customers", () => {
  const id = "orders-top-customers";
  const q = quarter(TODAY, 1);
  const revenue = (c: World["companies"][0]) => W.salesOrders.filter((o) => o.customerId === c.id && o.status !== "CANCELED" && day(o.orderDatetime) >= q.start && day(o.orderDatetime) <= q.end).reduce((n, o) => n + orderTotal(o), 0);
  const ranked = W.companies.filter((c) => c.relationship === "CUSTOMER").map((c) => ({ name: c.name, revenue: revenue(c) })).sort((a, b) => b.revenue - a.revenue);
  const answer = (rs: typeof ranked) => rs.map((r, i) => `${i + 1}. ${r.name} — ${money(r.revenue)}`).join("\n");

  test("a numbered list passes", () => expect(failures(id, answer(ranked.slice(0, 10)))).toEqual([]));
  test("counting the order placed before the quarter", () => {
    expect(failures(id, answer([...ranked.slice(0, 9), { name: "Coastal Roots", revenue: 85000 }]))).toEqual(["names the ten customers with the most revenue last quarter", "names no customer outside the top ten"]);
  });
  test("listing eleven", () => expect(failures(id, answer(ranked.slice(0, 11)))).toEqual(["names no customer outside the top ten"]));
  test("the order is reported, not required", () => {
    expect(notes(id, answer(ranked.slice(0, 10)))).toEqual([]);
    const shuffled = [ranked[1]!, ranked[0]!, ...ranked.slice(2, 10)];
    expect(failures(id, answer(shuffled))).toEqual([]);
    expect(notes(id, answer(shuffled))).toEqual(["names the ten in descending order of revenue"]);
    expect(notes(id, bullets([...ranked.slice(0, 10)].sort((a, b) => a.name.localeCompare(b.name)).map((r) => r.name)))).toEqual(["names the ten in descending order of revenue"]);
  });
});

describe("orders-email-invoice", () => {
  const id = "orders-email-invoice";
  const order = W.salesOrders.find((o) => o.orderNumber === "SO-4512")!;
  const invoice = W.invoices.find((i) => i.salesOrderId === order.id)!;
  const buyer = buyerOf(order.customerId).email!;
  const send = (email: Partial<World["outbox"][0]>) => written((w) => { w.outbox.push({ document: "INVOICE", recordId: invoice.id, emailAddresses: [buyer.toUpperCase()], sentAt: new Date(NOW).toISOString(), ...email }); });

  test("the invoice to the buyer passes", () => expect(failures(id, "", send({}))).toEqual([]));
  test("to accounts payable", () => {
    const ap = W.contacts.find((k) => k.companyId === order.customerId && k.title !== "Buyer")!.email!;
    expect(failures(id, "", send({ emailAddresses: [ap] }))).toEqual(["it goes to the buyer and no one else"]);
  });
  test("to the buyer and someone else", () => expect(failures(id, "", send({ emailAddresses: [buyer, W.users[0]!.email] }))).toEqual(["it goes to the buyer and no one else"]));
  test("the order slip instead", () => expect(failures(id, "", send({ document: "SALES_ORDER", recordId: order.id }))).toEqual(["the email carries the invoice of SO-4512"]));
});

describe("purchasing-vendor-spend", () => {
  const id = "purchasing-vendor-spend";
  const year = TODAY.slice(0, 4);
  const thisYear = W.purchaseOrders.filter((po) => day(po.orderDatetime).startsWith(year));
  const vendors = W.companies.filter((c) => thisYear.some((po) => po.vendorId === c.id));
  const per = (pos: World["purchaseOrders"], value: (po: World["purchaseOrders"][0]) => number) => vendors.map((v) => [v.name, pos.filter((po) => po.vendorId === v.id).reduce((n, po) => n + value(po), 0)] as const);
  const prose = (rows: readonly (readonly [string, number])[]) => `This year we ordered ${rows.map(([v, t]) => `$${(t / 1000).toFixed(1)}k from ${v}`).join(", ")}.`;
  const labelFirst = (rows: readonly (readonly [string, number])[]) => bullets(rows.map(([v, t]) => `${v}: ${money(t)}`));

  test("what was ordered, in a list, passes", () => expect(failures(id, labelFirst(per(thisYear, purchaseTotal)))).toEqual([]));
  test("what was paid instead", () => expect(failures(id, labelFirst(per(thisYear, (po) => purchaseMoney(W, po).paid)))).toEqual(["gives what was ordered from each vendor this year"]));
  test("counting last year's orders", () => expect(failures(id, labelFirst(per(W.purchaseOrders, purchaseTotal)))).toEqual(["gives what was ordered from each vendor this year"]));
  test("amounts before the vendor's name do not count", () => expect(failures(id, prose(per(thisYear, purchaseTotal)))).toEqual(["gives what was ordered from each vendor this year"]));
});

describe("purchasing-unpaid-pos", () => {
  const id = "purchasing-unpaid-pos";
  const status = (po: World["purchaseOrders"][0]) => purchaseMoney(W, po).status;
  const unpaid = W.purchaseOrders.filter((po) => status(po) === "NOT_PAID" || status(po) === "PARTIALLY_PAID");
  const answer = (pos: World["purchaseOrders"]) => `Not paid in full: ${pos.map((po) => `${po.purchaseNumber.slice(3)} (${money(purchaseMoney(W, po).remaining)} left)`).join(", ")}.`;

  test("their bare numbers in prose pass", () => expect(failures(id, answer(unpaid))).toEqual([]));
  test("missing the partly paid ones", () => expect(failures(id, answer(unpaid.filter((po) => status(po) === "NOT_PAID")))).toEqual(["lists every purchase order not paid in full"]));
  test("adding the overpaid one", () => expect(failures(id, answer([...unpaid, W.purchaseOrders.find((po) => status(po) === "OVER_PAID")!]))).toEqual(["lists no purchase order paid in full"]));
});

describe("purchasing-record-payment", () => {
  const id = "purchasing-record-payment";
  const pay = (payment: Partial<World["purchasePayments"][0]>) => written((w) => {
    const at = new Date(NOW).toISOString();
    w.purchasePayments.push({ id: newId(w, "ppy"), paymentNumber: "PMT-99", purchaseId: w.purchaseOrders.find((p) => p.purchaseNumber === "PO-1182")!.id, amount: 2500, paymentDatetime: at, recordedAt: at, paymentMethodId: w.paymentMethods[1]!.id, note: null, voidedAt: null, ...payment });
  });

  test("$2,500 on PO-1182 passes", () => expect(failures(id, "", pay({}))).toEqual([]));
  test("the wrong amount", () => expect(failures(id, "", pay({ amount: 2000 }))).toEqual(["the payment is $2,500"]));
  test("on another purchase order", () => expect(failures(id, "", pay({ purchaseId: W.purchaseOrders.find((p) => p.purchaseNumber === "PO-1180")!.id }))).toEqual(["it is against PO-1182"]));
  test("with a payment method that does not exist", () => expect(failures(id, "", pay({ paymentMethodId: "pmm_99" }))).toEqual(["it is not voided and uses an existing payment method"]));
});

// ---------- negative checks: mentioning a wrong item to set it aside passes, naming it as part of the answer fails ----------

describe("negative checks", () => {
  const late = (i: World["invoices"][0]) => (NOW - Date.parse(i.dueDatetime)) / 86_400_000;
  const owing = (i: World["invoices"][0]) => !i.voided && invoiceMoney(W, i).remaining > 0;
  const q = quarter(TODAY, 1);
  const revenue = (c: World["companies"][0]) => W.salesOrders.filter((o) => o.customerId === c.id && o.status !== "CANCELED" && day(o.orderDatetime) >= q.start && day(o.orderDatetime) <= q.end).reduce((n, o) => n + orderTotal(o), 0);
  const ranked = W.companies.filter((c) => c.relationship === "CUSTOMER").map((c) => ({ name: c.name, revenue: revenue(c) })).sort((a, b) => b.revenue - a.revenue);
  const main = menuProducts("Main Wholesale Menu");
  const soldOut = main.filter((p) => availableQuantity(W, p) <= 0);
  const metrcLabel = (name: string, imported: boolean) => W.metrcPackages.find((m) => m.itemName === name && (m.importStatus === "IMPORTED") === imported)!.label;
  const unimported = W.metrcPackages.filter((m) => m.importStatus === "UNIMPORTED");
  const manifests = W.metrcManifests;
  const asked = manifests.find((m) => m.manifestNumber === "0001234567")!, other = manifests.find((m) => m.manifestNumber === "0001234568")!;
  const veg = W.plants.filter((p) => p.status === "VEGETATIVE");
  const vegGroups = W.plantGroups.filter((g) => veg.some((p) => p.plantGroupId === g.id));
  const myOverdue = W.tasks.filter((t) => t.ownerId === W.me && t.status === "ACTIVE" && Date.parse(t.dueDate) < NOW);
  const dueToday = W.tasks.find((t) => t.ownerId === W.me && t.status === "ACTIVE" && day(t.dueDate) === TODAY && Date.parse(t.dueDate) > NOW)!;
  const colleagues = W.tasks.find((t) => t.ownerId !== W.me && t.status === "ACTIVE" && Date.parse(t.dueDate) < NOW)!;
  const api = W.actions.filter((a) => a.source === "PUBLIC_API");
  const apiOn = (ymd: string) => [...new Set(api.filter((a) => day(a.changedAt) === ymd).flatMap((a) => a.records.map((r) => r.name)))];
  const below = W.products.filter((p) => belowMinimum(W, p));
  const overdueInvoices = W.invoices.filter((i) => owing(i) && late(i) > 30);
  const recent = W.invoices.find((i) => owing(i) && late(i) > 20 && late(i) <= 30)!;
  const voided = W.invoices.find((i) => i.voided && late(i) > 30)!;
  const status = (po: World["purchaseOrders"][0]) => purchaseMoney(W, po).status;
  const unpaid = W.purchaseOrders.filter((po) => status(po) === "NOT_PAID" || status(po) === "PARTIALLY_PAID");
  const overpaid = W.purchaseOrders.find((po) => status(po) === "OVER_PAID")!;
  const month = lastMonth(TODAY);
  const inMonth = W.harvests.filter((h) => day(h.harvestedAt) >= month.start && day(h.harvestedAt) <= month.end);
  const strainGrams = [...new Set(inMonth.map((h) => h.strainName))].map((s) => [s, inMonth.filter((h) => h.strainName === s).reduce((n, h) => n + h.wetWeight, 0)] as const);
  const thisMonth = W.harvests.find((h) => day(h.harvestedAt) > month.end && !inMonth.some((x) => x.strainName === h.strainName))!;
  const sunset = company("Sunset Dispensary"), wellness = company("Sunset Wellness Collective");

  const shortName = (t: World["tasks"][0]) => t.name.split(" ").slice(0, 4).join(" ");
  const soldOutTable = table(["Product", "Available"], soldOut.map((p) => [p.name, availableQuantity(W, p)]));
  const taskList = bullets(myOverdue.map((t) => `${shortName(t)}… (was due ${longDate(day(t.dueDate))})`));
  const invoiceTable = (invoices: World["invoices"]) => table(["Invoice", "Customer", "Days overdue", "Sales rep"], invoices.map((i) => [i.invoiceNumber, W.companies.find((c) => c.id === i.customerId)!.name, Math.round(late(i)), userName(i.ownerId)]));
  const topTen = ranked.slice(0, 10).map((r, i) => `${i + 1}. ${r.name} — ${money(r.revenue)}`).join("\n");
  const poList = `Not paid in full: ${unpaid.map((po) => `${po.purchaseNumber} (${money(purchaseMoney(W, po).remaining)} left)`).join(", ")}.`;
  const harvestTable = table(["Strain", "Wet weight"], strainGrams.map(([s, g]) => [s, `${g.toLocaleString("en-US")} g`]));

  // Each case: the task, the negative check, an answer that mentions a wrong item while saying why it is not part of
  // the answer (it must pass the whole grade), and an answer that includes that item as part of the answer (it must
  // fail that check).
  const cases: [string, string, string, string][] = [
    ["commerce-main-menu-sold-out", "names no product of the main menu that is in stock",
      // The answer of a real run, quoted.
      `${soldOutTable}\n\nThe other 14 products are in stock. The lowest are Blue Dream Cartridge 1g with 65 available and Blue Dream 3.5g with 70.`,
      `These are sold out:\n${bullets([...soldOut.map((p) => p.name), "Blue Dream Cartridge 1g (65 available)"])}`],
    ["commerce-main-menu-sold-out", "names no product of the main menu that is in stock",
      table(["Product", "Status"], main.map((p) => [p.name, availableQuantity(W, p) > 0 ? "In stock" : "Sold out"])),
      `${soldOut.map((p) => p.name).join(", ")} and Blue Dream Cartridge 1g are sold out, while the rest have stock available.`],
    ["commerce-main-menu-sold-out", "names no product of the main menu that is in stock",
      `**Sold out**\n${bullets(soldOut.map((p) => p.name))}\n\n**In stock, but running low**\n${bullets(["Blue Dream Cartridge 1g: 65", "Blue Dream 3.5g: 70"])}`,
      `**Sold out or nearly**\n${bullets([...soldOut.map((p) => p.name), "Blue Dream Cartridge 1g: 65"])}`],
    ["commerce-main-menu-sold-out", "names no product sold out only on another menu",
      `${soldOutTable}\n\nJack Herer 14g is sold out too, but it is only on the Spring Menu.`,
      `${soldOutTable}\n| Jack Herer 14g | 0 |`],
    ["commerce-main-menu-sold-out", "names no product sold out only on another menu",
      `${soldOutTable}\n\n(Jack Herer 14g, on the Spring Menu, is out as well.)`,
      `Sold out:\n${bullets([...soldOut.map((p) => p.name), "Jack Herer 14g (Spring Menu)"])}`],
    ["compliance-unimported-packages", "names no package that is already imported",
      `${table(["Tag", "Item"], unimported.map((m) => [m.label, m.itemName]))}\n\nThe cultivation license's other package, ${metrcLabel("Gelato Bulk Flower", true)} (Gelato Bulk Flower), is already imported.`,
      `Not imported yet:\n${bullets([...unimported.map((m) => m.label), metrcLabel("Gelato Bulk Flower", true)])}`],
    ["compliance-unimported-packages", "names no package that is already imported",
      table(["Tag", "Import status"], [...unimported.map((m) => [m.label, "UNIMPORTED"]), [metrcLabel("Gelato Bulk Flower", true), "IMPORTED"]]),
      table(["Tag", "Imported"], [...unimported.map((m) => [m.label, "No"]), [metrcLabel("Gelato Bulk Flower", true), "No"]])],
    ["compliance-manifest-packages", "names no package of another manifest",
      `${table(["Package", "Item"], asked.packages.map((p) => [p.label, p.itemName]))}\n\nManifest ${other.manifestNumber}, from Sierra Extracts, also comes in tomorrow, with ${other.packages[0]!.label} on it.`,
      table(["Package", "Item", "Note"], [...asked.packages.map((p) => [p.label, p.itemName, ""]), [other.packages[0]!.label, other.packages[0]!.itemName, `manifest ${other.manifestNumber}`]])],
    ["cultivation-plants-in-veg", "names no plant group without plants in veg",
      `${veg.length} plants are in veg: ${vegGroups.map((g) => `${g.name} (${veg.filter((p) => p.plantGroupId === g.id).length})`).join(" and ")}. OG Kush Run 3 is in the Veg Room too, but its plants are still immature.`,
      `${veg.length} plants are in veg: ${vegGroups.map((g) => g.name).join(", ")} and OG Kush Run 3.`],
    ["directory-sunset-rep-buyer", "gives neither the rep nor the buyer of Sunset Wellness Collective",
      `${userName(sunset.ownerId)} is the sales rep on Sunset Dispensary, and the buyer is ${buyerOf(sunset.id).email}. Not to be confused with Sunset Wellness Collective, whose rep is ${userName(wellness.ownerId)}.`,
      `${userName(sunset.ownerId)} is the sales rep on Sunset Dispensary, and the buyer is ${buyerOf(sunset.id).email} (or ${buyerOf(wellness.id).email}).`],
    ["directory-my-overdue-tasks", "names none of my tasks that are done or not yet due",
      `${taskList}\n\n${dueToday.name} is due later today, so it is not overdue.`,
      `${taskList}\n- ${dueToday.name} (due ${longDate(TODAY)})`],
    ["directory-my-overdue-tasks", "names no task of another user",
      `${taskList}\n\n${userName(colleagues.ownerId)} also has an overdue one, ${colleagues.name}, but it is assigned to them, not you.`,
      `${taskList}\n- ${colleagues.name} (${userName(colleagues.ownerId)})`],
    ["history-public-api-yesterday", "names no record the public API changed on another day",
      `Yesterday the public API changed:\n${bullets(apiOn(addDays(TODAY, -1)))}\n\nThis morning it also changed ${apiOn(TODAY)[0]}, but that was today, not yesterday.`,
      `Yesterday the public API changed:\n${bullets([...apiOn(addDays(TODAY, -1)), apiOn(TODAY)[0]!])}`],
    ["history-public-api-yesterday", "names no record the public API changed on another day",
      `Yesterday: ${apiOn(addDays(TODAY, -1)).join(", ")}.\n\nTwo days ago it had changed ${apiOn(addDays(TODAY, -2))[0]}.`,
      `Yesterday: ${[...apiOn(addDays(TODAY, -1)), apiOn(addDays(TODAY, -2))[0]].join(", ")}.`],
    ["history-public-api-yesterday", "names no record only users changed yesterday",
      `Yesterday the public API changed:\n${bullets(apiOn(addDays(TODAY, -1)))}\n\nWedding Cake 7g and SO-4512 changed yesterday too, but by users through MCP and the web app, not by the public API.`,
      `Yesterday the public API changed:\n${bullets([...apiOn(addDays(TODAY, -1)), "Wedding Cake 7g"])}`],
    ["history-public-api-yesterday", "names no record only users changed yesterday",
      `Yesterday: ${apiOn(addDays(TODAY, -1)).join(", ")}.\n\n(Maya Okafor also changed Wedding Cake 7g's low-stock alert.)`,
      `Yesterday: ${[...apiOn(addDays(TODAY, -1)), "SO-4512"].join(", ")}.`],
    ["inventory-below-minimum", "names no product at or above its minimum, or without one",
      `${table(["Product", "Available", "Minimum"], below.map((p) => [p.name, availableQuantity(W, p), p.thresholdMin!]))}\n\nMilk Chocolate Bar 100mg is low too, with 25 available, but it has no minimum set.`,
      table(["Product", "Available", "Minimum"], [...below.map((p) => [p.name, availableQuantity(W, p), p.thresholdMin!]), ["Milk Chocolate Bar 100mg", 25, "none"]])],
    ["orders-overdue-invoices", "lists no invoice overdue 30 days or less, paid or voided",
      `${invoiceTable(overdueInvoices)}\n\n${recent.invoiceNumber} is ${Math.round(late(recent))} days overdue, under the threshold.`,
      invoiceTable([...overdueInvoices, recent])],
    ["orders-overdue-invoices", "lists no invoice overdue 30 days or less, paid or voided",
      `${invoiceTable(overdueInvoices)}\n\n${voided.invoiceNumber} is ${Math.round(late(voided))} days past due, but it was voided.`,
      `${invoiceTable(overdueInvoices)}\n| ${voided.invoiceNumber} | Laurel Canyon Collective | ${Math.round(late(voided))} | ${userName(voided.ownerId)} |`],
    ["orders-top-customers", "names no customer outside the top ten",
      `${topTen}\n\n${ranked[10]!.name} came 11th with ${money(ranked[10]!.revenue).replace(/\.\d\d$/, "")}.`,
      `${topTen}\n11. ${ranked[10]!.name} — ${money(ranked[10]!.revenue)}`],
    ["orders-top-customers", "names no customer outside the top ten",
      `${topTen}\n\nCoastal Roots placed an $85,000 order, but it was before the quarter started.`,
      `${ranked.slice(0, 10).map((r) => r.name).join(", ")} and Coastal Roots.`],
    ["purchasing-unpaid-pos", "lists no purchase order paid in full",
      `${poList}\n\n${overpaid.purchaseNumber} is overpaid, not underpaid.`,
      `Not paid in full: ${[...unpaid, overpaid].map((po) => `${po.purchaseNumber} (${money(purchaseMoney(W, po).remaining)} left)`).join(", ")}.`],
    ["cultivation-harvest-by-strain", "gives no weight for strains not harvested last month",
      `${harvestTable}\n\n${thisMonth.strainName} was harvested this month (${thisMonth.wetWeight.toLocaleString("en-US")} g), so it is not in the table.`,
      `${harvestTable}\n| ${thisMonth.strainName} | ${thisMonth.wetWeight.toLocaleString("en-US")} g |`],
  ];

  test("cover every negative check of every task", () => {
    const negative = tasks.flatMap((t) => t.grade({ answer: "", before: W, after: W }).filter((c) => / no |neither|none of/.test(c.name) && t.kind === "read").map((c) => `${t.id}: ${c.name}`));
    const covered = new Set(cases.map(([id, check]) => `${id}: ${check}`));
    expect(negative.filter((n) => !covered.has(n) && !n.includes("does not credit"))).toEqual([]);
  });

  test.each(cases)("%s, %s: the remark passes", (id, check, ok) => {
    expect(failures(id, ok)).toEqual([]);
    expect(task(id).grade({ answer: ok, before: W, after: W }).find((c) => c.name === check)?.pass).toBe(true);
  });

  test.each(cases)("%s, %s: the item in the answer fails", (id, check, _ok, wrong) => {
    expect(failures(id, wrong)).toContain(check);
  });

  test("crediting someone with a change they did not make to the price", () => {
    const id = "history-price-change-so-1042";
    const order = W.salesOrders.find((o) => o.orderNumber === "SO-1042")!;
    const history = W.actions.filter((a) => a.records.some((r) => r.id === order.id));
    const change = history.find((a) => a.records.some((r) => r.fields.some((f) => f.field === "priceBase")))!;
    const quantity = history.find((a) => a.records.some((r) => r.fields.some((f) => f.field === "quantity")))!;
    const when = longDate(day(change.changedAt));
    expect(failures(id, `${change.actorName} changed the price on ${when}. ${quantity.actorName} changed the quantity, not the price.`)).toEqual([]);
    expect(failures(id, `${quantity.actorName} changed the price on ${when}, after ${change.actorName} had set it up.`)).toContain("does not credit anyone else with the price change");
  });
});

describe("every task", () => {
  test("a read task fails when the world changed", () => {
    const after = written(() => {});
    for (const t of tasks.filter((x) => x.kind === "read")) expect(t.grade({ answer: "", before: W, after }).find((c) => c.name === "leaves the world unchanged")?.pass).toBe(false);
  });

  test("a write task fails when nothing was done", () => {
    for (const t of tasks.filter((x) => x.kind === "write")) expect(t.grade({ answer: "Done.", before: W, after: W }).some((c) => !c.pass)).toBe(true);
  });

  test("grading leaves the world it was given as it was", () => expect(W).toEqual(createWorld(TODAY)));
});
