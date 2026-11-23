import { describe, expect, test } from "bun:test";
import {
  amount, attributed, diff, firstMentioned, literal, mentions, mentionsCount, named, numbered, numbers, onDay, passages, percentage, quotes,
  sentences, tagged, unchanged, unchangedExcept, valuesNear, weekday, weight,
} from "../suites/erp/grading.ts";

const said = (text: string, accepts: (n: ReturnType<typeof numbers>[0]) => boolean) => numbers(text).some(accepts);

describe("numbers", () => {
  test("reads amounts, percentages and weights as written", () => {
    expect(numbers("$12,345.67")).toEqual([{ value: 12345.67, text: "$12,345.67", percent: false, currency: true, unit: "" }]);
    expect(numbers("12,346 and $12.3k and 1.2M").map((n) => n.value)).toEqual([12346, 12300, 1200000]);
    expect(numbers("36% then 36.2 % then 40 percent").map((n) => [n.value, n.percent])).toEqual([[36, true], [36.2, true], [40, true]]);
    expect(numbers("34.65 kg, 76.4 lbs, 34,650g").map((n) => [n.value, n.unit])).toEqual([[34.65, "kg"], [76.4, "lb"], [34650, "g"]]);
  });

  test("does not split a number or read a kilogram as thousands", () => {
    expect(numbers("1,234,567").map((n) => n.value)).toEqual([1234567]);
    expect(numbers("12 kg")[0]).toMatchObject({ value: 12, unit: "kg" });
  });
});

describe("amounts", () => {
  const target = amount(12345.67, 0.01);
  test.each(["$12,345.67", "12345.67", "12,346", "$12.3k", "USD 12,345"])("accepts %s", (text) => expect(said(text, target)).toBe(true));
  test.each(["$12,600", "12,345%", "12.3 kg", "$1.2k"])("rejects %s", (text) => expect(said(text, target)).toBe(false));
});

describe("percentages", () => {
  test.each(["36%", "36.2 %", "a margin of 35.7", "37.1%"])("accepts %s within a point of 36.2", (text) => expect(said(text, percentage(36.2, 1))).toBe(true));
  test("accepts a fraction only when asked to", () => {
    expect(said("0.362", percentage(36.2, 1))).toBe(false);
    expect(said("0.362", percentage(36.2, 1, true))).toBe(true);
    expect(said("0.362%", percentage(36.2, 1, true))).toBe(false);
  });
  test.each(["38%", "$36.20", "36.2 g"])("rejects %s", (text) => expect(said(text, percentage(36.2, 1, true))).toBe(false));
});

describe("weights", () => {
  const target = weight(34650, 0.01);
  test.each(["34,650 g", "34650", "34.65 kg", "34.7 kilograms", "76.4 lb"])("accepts %s", (text) => expect(said(text, target)).toBe(true));
  test.each(["39,650 g", "34.65 g", "34,650 kg", "$34,650", "34%"])("rejects %s", (text) => expect(said(text, target)).toBe(false));
});

describe("dates", () => {
  const day = onDay("2026-10-21");
  test.each(["2026-10-21", "2026-10-21T14:37:00-07:00", "October 21", "Oct 21, 2026", "Oct. 21st", "10/21/2026", "10/21", "21 October", "21st of Oct 2026", "on oct 21 at 2:37 pm"])(
    "finds %s",
    (text) => expect(mentions(text, day)).toBe(true),
  );
  test.each(["Oct 21, 2025", "10/21/2025", "Oct 2", "Oct 211", "2026-10-22", "11/21/2026", "21 Nov"])("does not take %s for it", (text) => expect(mentions(text, day)).toBe(false));
  test("accepts the phrases an answer may use for the day", () => {
    expect(weekday("2026-11-22")).toBe("Sunday");
    const yesterday = onDay("2026-11-22", "yesterday", "Sunday");
    expect(mentions("it failed yesterday", yesterday)).toBe(true);
    expect(mentions("on Sunday", yesterday)).toBe(true);
    expect(mentions("on Saturday", yesterday)).toBe(false);
  });
});

describe("names", () => {
  test("match in any case, spacing and punctuation", () => {
    for (const text of ["Blue Dream 3.5g", "BLUE DREAM 3.5G", "blue dream (3.5 g)", "**Blue Dream 3.5g**", "| Blue Dream 3.5g |"]) expect(mentions(text, named("Blue Dream 3.5g"))).toBe(true);
    expect(mentions("pre rolls and prerolls", named("Pre-Rolls"))).toBe(true);
    expect(mentions("Edibles", named("Edible"))).toBe(true);
  });

  test("do not match a different name that shares a prefix", () => {
    expect(mentions("Blue Dream 7g", named("Blue Dream 3.5g"))).toBe(false);
    expect(mentions("Blue Dream 35g", named("Blue Dream 3.5g"))).toBe(false);
    expect(mentions("Sunset Wellness Collective", named("Sunset Dispensary"))).toBe(false);
    expect(mentions("OG Kush Run 31", named("OG Kush Run 3"))).toBe(false);
    expect(mentions("Gelato Cartridge 1g", named("Gelato 1g Pre-Roll"))).toBe(false);
  });

  test("an email is matched as written, in any case", () => {
    const email = literal("marcus.bell@sunsetdispensary.example");
    expect(mentions("Email: Marcus.Bell@SunsetDispensary.example.", email)).toBe(true);
    expect(mentions("dana.whitlock@sunsetdispensary.example", email)).toBe(false);
    expect(mentions("xmarcus.bell@sunsetdispensary.example", email)).toBe(false);
  });
});

describe("document numbers", () => {
  const invoice = numbered("INV-4484", "SO");
  test.each(["INV-4484", "inv 4484", "SO-4484", "SO4484", "#4484", "invoice 4484", "(4484)"])("find %s", (text) => expect(mentions(text, invoice)).toBe(true));
  test.each(["$4,484", "4484.00", "$4484", "INV-44841", "PO-4484", "14484"])("do not take %s for it", (text) => expect(mentions(text, invoice)).toBe(false));
});

describe("Metrc tags", () => {
  const tag = tagged("1A406030000A4E2000030771");
  test.each(["1A406030000A4E2000030771", "1a406030000a4e2000030771", "ending 30771", "…30771", "000030771"])("find %s", (text) => expect(mentions(text, tag)).toBe(true));
  test.each(["30772", "0771", "1A406030000A4E2000030771X", "1A406030000A4E2000130771"])("do not take %s for it", (text) => expect(mentions(text, tag)).toBe(false));
});

describe("values near their labels", () => {
  const rows = [
    { ref: named("Flower"), accepts: percentage(35.3, 1), shows: "35.3%" },
    { ref: named("Pre-Rolls"), accepts: percentage(45.2, 1), shows: "45.2%" },
  ];
  const near = (answer: string) => valuesNear("margins", answer, rows).pass;

  test.each([
    ["prose", "Flower ran at a 35.3% margin, while Pre-Rolls reached 45.2%."],
    ["bullets", "- Flower: 35.3%\n- Pre-Rolls: 45.2%"],
    ["a table", "| Category | Margin |\n| --- | --- |\n| Flower | 35.3% |\n| Pre-Rolls | 45.2% |"],
    ["a table with the label last", "| Margin | Category |\n| --- | --- |\n| 35.3% | Flower |\n| 45.2% | Pre-Rolls |"],
    ["a heading per label", "**Flower**\nRevenue $228,725\nMargin 35.3%\n\n**Pre-Rolls**\nRevenue $224,164\nMargin 45.2%"],
  ])("finds them in %s", (_, answer) => expect(near(answer)).toBe(true));

  test("a number next to the wrong label does not count", () => {
    expect(near("- Flower: 45.2%\n- Pre-Rolls: 35.3%")).toBe(false);
    expect(near("Flower and Pre-Rolls: 35.3% and 45.2%")).toBe(false);
    expect(near("Margins were 35.3% and 45.2%.")).toBe(false);
  });

  test("a label that is a prefix of another keeps its own number", () => {
    const blue = [{ ref: named("Blue Dream 3.5g"), accepts: percentage(24.6, 0.05), shows: "24.6%" }];
    const others = [named("Blue Dream 7g")];
    expect(valuesNear("thc", "Blue Dream 7g 26.1%, Blue Dream 3.5g 24.6%", blue, others).pass).toBe(true);
    expect(valuesNear("thc", "Blue Dream 3.5g: n/a\nBlue Dream 7g: 24.6%", blue, others).pass).toBe(false);
  });

  test("the detail says what was expected and what was found", () => {
    expect(valuesNear("margins", "- Flower: 45.2%", rows).detail).toBe("Flower: expected 35.3%, found 45.2%; Pre-Rolls not mentioned");
  });

  test("passages leave out the label's own digits", () => {
    expect(passages("| Jack Herer 14g | 19.4% |", [named("Jack Herer 14g")])[0]!.flatMap(numbers).map((n) => n.value)).toEqual([19.4, 19.4]);
  });
});

describe("attribution", () => {
  const refs = [numbered("INV-4484", "SO"), numbered("INV-4465", "SO"), numbered("INV-4449", "SO")];
  const reps = [named("Priya Nair"), named("Maya Okafor")];
  const PRIYA = 0, MAYA = 1;
  const owners = (answer: string) => attributed(answer, refs, reps).map((r) => r[0]);

  test.each([
    ["a table", "| Invoice | Rep |\n|---|---|\n| INV-4484 | Priya Nair |\n| INV-4465 | Priya Nair |\n| INV-4449 | Maya Okafor |"],
    ["a table naming each invoice twice", "| INV-4484 | SO-4484 | Priya Nair |\n| INV-4465 | SO-4465 | Priya Nair |\n| INV-4449 | SO-4449 | Maya Okafor |"],
    ["a table with the rep first","| Priya Nair | INV-4484 |\n| Priya Nair | INV-4465 |\n| Maya Okafor | INV-4449 |"],
    ["one line", "INV-4484 (Priya Nair), INV-4465 (Priya Nair) and INV-4449 (Maya Okafor)."],
    ["invoices grouped under their rep", "**Priya Nair**\n- INV-4484\n- INV-4465\n\n**Maya Okafor**\n- INV-4449"],
    ["details below each invoice", "**INV-4484**\n- Rep: Priya Nair\n\n**INV-4465**\n- Rep: Priya Nair\n\n**INV-4449**\n- Rep: Maya Okafor"],
  ])("reads %s", (_, answer) => expect(owners(answer)).toEqual([PRIYA, PRIYA, MAYA]));

  test("the rep on an invoice's own line wins over its neighbours", () => {
    expect(owners("**Priya Nair**\n- INV-4484\n- INV-4465 — Maya Okafor\n- INV-4449")).toEqual([PRIYA, MAYA, MAYA]);
  });

  test("an invoice with no rep anywhere is tied to nobody", () => {
    expect(owners("INV-4484, INV-4465 and INV-4449.")).toEqual([undefined, undefined, undefined]);
  });
});

describe("sentences, first mentions and quotes", () => {
  test("splits sentences but not amounts", () => {
    expect(sentences("Priya changed it from $24.00 to $19.50. Daniel created it; Maya closed it\nDone")).toEqual(["Priya changed it from $24.00 to $19.50", " Daniel created it", " Maya closed it", "Done"]);
  });

  test("finds the first of several names", () => {
    const [priya, daniel] = [named("Priya Nair"), named("Daniel Reyes")];
    expect(firstMentioned("Daniel Reyes created it, Priya Nair priced it", [priya, daniel])).toBe(daniel);
    expect(firstMentioned("nobody", [priya, daniel])).toBeUndefined();
  });

  test("a quote needs four words of its own", () => {
    const error = "Metrc rejected the adjustment: the quantity removed is more than the package holds in Metrc.";
    const other = "Metrc rejected the adjustment: the adjustment date is before the package's last modified date.";
    expect(quotes("It failed: the quantity removed is more than it holds.", error, [other])).toBe(true);
    expect(quotes("Metrc rejected the adjustment.", error, [other])).toBe(false);
    expect(quotes("the quantity was wrong", error, [other])).toBe(false);
  });

  test("counts in digits or words", () => {
    expect(mentionsCount("12 plants", 12)).toBe(true);
    expect(mentionsCount("twelve plants", 12)).toBe(true);
    expect(mentionsCount("12% of plants", 12)).toBe(false);
    expect(mentionsCount("Gelato Run 14", 12)).toBe(false);
  });
});

describe("world changes", () => {
  const before = { products: [{ tagIds: ["a"], name: "x" }, { tagIds: [], name: "y" }], contacts: [{ id: 1 }], actions: [] as unknown[] };

  test("diff lists the changed paths", () => {
    const after = structuredClone(before);
    after.products[1]!.tagIds.push("b");
    after.contacts.push({ id: 2 });
    expect(diff(before, after)).toEqual(["products.1.tagIds.0", "contacts.1"]);
    expect(diff(before, structuredClone(before))).toEqual([]);
  });

  test("unchangedExcept allows the paths it is given, with * for any key and + for added elements", () => {
    const after = structuredClone(before);
    after.products[1]!.tagIds.push("b");
    after.contacts.push({ id: 2 });
    after.actions.push({ what: "logged" });
    expect(unchangedExcept("ok", before, after, ["products.*.tagIds", "contacts.+", "actions"]).pass).toBe(true);
    expect(unchangedExcept("not ok", before, after, ["products.0.tagIds", "contacts.+", "actions"])).toEqual({ name: "not ok", pass: false, detail: "changed: products.1.tagIds.0" });
    const edited = structuredClone(before);
    edited.contacts[0]!.id = 9;
    expect(unchangedExcept("not ok", before, edited, ["contacts.+"]).detail).toBe("changed: contacts.0.id");
  });

  test("unchanged passes only on an identical world", () => {
    expect(unchanged(before, structuredClone(before))).toEqual({ name: "leaves the world unchanged", pass: true });
    expect(unchanged(before, { ...before, actions: [1] }).pass).toBe(false);
  });
});
