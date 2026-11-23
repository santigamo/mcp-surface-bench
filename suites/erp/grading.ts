// The answer checks the ERP graders are built from. Plain text matching, no model: it accepts the usual ways of
// writing a fact (amounts, dates, percentages, names in any case, prose, lists or tables) and ties a number or a
// name to the label it belongs to rather than looking for it anywhere in the answer.
import type { Check } from "../../src/core/tool.ts";

// ---------- what an answer refers to ----------

/** Something an answer can mention: how a check names it, and the pattern that finds it (always global). */
export type Ref = { label: string; pattern: RegExp };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A name, matched whole, in any case and however the answer punctuates or spaces it: "Blue Dream 3.5g" also
 * matches "blue dream (3.5 g)", "Pre-Rolls" also "pre rolls", and a plural s is accepted. Digits are never run
 * together, so "Run 3" does not match "Run 31", nor "3.5g" "35g".
 */
export function named(label: string, ...aliases: string[]): Ref {
  const one = (name: string) =>
    (name.toLowerCase().match(/[a-z]+|\d+/g) ?? [])
      .map((t, i, all) => (i === 0 ? "" : /\d/.test(all[i - 1]!) && /\d/.test(t) ? "[^a-z0-9\\n]{1,3}" : "[^a-z0-9\\n]{0,3}") + t)
      .join("");
  return { label, pattern: new RegExp(`(?<![a-z0-9])(?:${[label, ...aliases].map(one).join("|")})s?(?![a-z0-9])`, "gi") };
}

/**
 * A document number such as "INV-4484": with its own prefix or one of `prefixes` ("SO-4484"), with "#", or bare
 * ("4484"). Never inside an amount: "$4,484" and "4484.00" are not the document.
 */
export function numbered(number: string, ...prefixes: string[]): Ref {
  const [, prefix, digits] = /^([A-Z]+)-(\d+)$/.exec(number) ?? [];
  if (!prefix || !digits) throw new Error(`"${number}" is not a document number like INV-4484.`);
  const any = [prefix, ...prefixes].map(escape).join("|");
  return { label: number, pattern: new RegExp(`(?<![\\w$.,-])(?:(?:${any})[\\s#:-]{0,2}|#)?${digits}(?!\\w|[.,]\\d)`, "gi") };
}

/** A Metrc tag such as "1A406030000A4E2000030771", written in full or by its last five or more characters. */
export function tagged(label: string): Ref {
  const suffixes = Array.from({ length: label.length - 4 }, (_, i) => escape(label.slice(i)));
  return { label, pattern: new RegExp(`(?<![a-z0-9])(?:${suffixes.join("|")})(?![a-z0-9])`, "gi") };
}

/** Text matched as written, in any case: an email address. */
export const literal = (text: string): Ref => ({ label: text, pattern: new RegExp(`(?<![\\w.+-])${escape(text)}(?![\\w-]|\\.\\w)`, "gi") });

// ---------- dates ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The weekday of a calendar day: "Saturday". */
export const weekday = (ymd: string) => WEEKDAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]!;

/**
 * A calendar day in any common format: 2026-10-21, 10/21/2026, 10/21, Oct 21, 2026, October 21st, 21 October.
 * A year, when the answer gives one, must be the right one. `phrases` are other words that mean the same day
 * in this answer ("yesterday", "Saturday").
 */
export function onDay(ymd: string, ...phrases: string[]): Ref {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const month = MONTHS[m - 1]!;
  const names = `(?:${month}|${month.slice(0, 3)}${month === "september" ? "t?" : ""}\\.?)`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  const year = `(?:,?\\s*${y})?(?!,?\\s*\\d{4})`;
  const forms = [
    `(?<!\\d)${y}[-/.]0?${m}[-/.]0?${d}(?!\\d)`,
    `(?<![\\d/])0?${m}/0?${d}(?:/(?:${y}|${y % 100}))?(?!\\d|/\\d)`,
    `(?<![a-z])${names}\\s*${day}(?!\\d)${year}`,
    `(?<![\\d])${day}\\s+(?:of\\s+)?${names}(?![a-z])${year}`,
    ...phrases.map((p) => `(?<![a-z])${escape(p)}(?![a-z])`),
  ];
  return { label: ymd, pattern: new RegExp(forms.join("|"), "gi") };
}

// ---------- finding mentions ----------

type Span = { ref: number; start: number; end: number };

/** Every mention of `refs`, in order. A mention inside a longer one belongs to the longer: "yesterday" inside "day before yesterday". */
function spans(answer: string, refs: Ref[]): Span[] {
  const all = refs.flatMap((r, ref) => [...answer.matchAll(r.pattern)].map((m) => ({ ref, start: m.index, end: m.index + m[0].length })));
  return all
    .filter((s) => !all.some((o) => o !== s && o.start <= s.start && o.end >= s.end && o.end - o.start > s.end - s.start))
    .sort((a, b) => a.start - b.start);
}

export const mentions = (text: string, ref: Ref) => spans(text, [ref]).length > 0;

function lineOf(answer: string, at: number): [number, number] {
  const end = answer.indexOf("\n", at);
  return [answer.lastIndexOf("\n", at - 1) + 1, end < 0 ? answer.length : end];
}

/**
 * The passages of an answer that speak about each ref, given every ref the answer might mention: after each
 * mention, the text up to the next mention of any ref; and the line around it (a table row, a bullet), when no
 * other ref shares that line.
 */
export function passages(answer: string, refs: Ref[]): string[][] {
  const found = spans(answer, refs);
  const out = refs.map((): string[] => []);
  found.forEach((s, i) => {
    out[s.ref]!.push(answer.slice(s.end, found[i + 1]?.start ?? answer.length));
    const [start, end] = lineOf(answer, s.start);
    if (found.every((o) => o.ref === s.ref || o.end <= start || o.start >= end)) out[s.ref]!.push(`${answer.slice(start, s.start)} ${answer.slice(s.end, end)}`);
  });
  return out;
}

/**
 * Which of `candidates` the answer ties to each mention of each ref (undefined when none). The ref's own line
 * decides when it names a candidate: the first one on it when no other ref shares the line, else the first one
 * after the ref on that line. Otherwise the answer's layout decides: when every such mention is followed by a
 * candidate before the next ref, details follow the ref ("INV-4484" then "Rep: Priya Nair"); else a candidate
 * heads the refs below it ("Priya Nair:" then a list of invoices), and the nearest one before the mention counts.
 */
export function attributed(answer: string, refs: Ref[], candidates: Ref[]): (number | undefined)[][] {
  const found = spans(answer, [...refs, ...candidates]);
  const isRef = (s: Span) => s.ref < refs.length;
  const candidate = (s: Span | undefined) => (s ? s.ref - refs.length : undefined);
  const out = refs.map((): (number | undefined)[] => []);
  const undecided: { ref: number; before?: number; after?: number }[] = [];
  found.forEach((s, i) => {
    if (!isRef(s)) return;
    const [start, end] = lineOf(answer, s.start);
    const onLine = found.filter((o) => o.start >= start && o.end <= end);
    const nextRef = onLine.find((o) => isRef(o) && o.ref !== s.ref && o.start > s.start);
    const own = onLine.every((o) => !isRef(o) || o.ref === s.ref)
      ? onLine.find((o) => !isRef(o))
      : onLine.find((o) => !isRef(o) && o.start > s.start && (!nextRef || o.start < nextRef.start));
    if (own) {
      out[s.ref]!.push(candidate(own));
      return;
    }
    const next = found[i + 1];
    const before = found.slice(0, i).reverse().find((o) => !isRef(o));
    undecided.push({ ref: s.ref, before: candidate(before), after: next && !isRef(next) ? candidate(next) : undefined });
  });
  const detailsFollow = undecided.every((u) => u.after !== undefined);
  for (const u of undecided) out[u.ref]!.push(detailsFollow ? u.after : u.before ?? u.after);
  return out;
}

/** The sentences and lines of a text. */
export const sentences = (text: string) => text.split(/\n|[.;!?](?=\s|$)/).filter((s) => s.trim());

/** The first of `refs` a text mentions, if any. */
export function firstMentioned(text: string, refs: Ref[]): Ref | undefined {
  const [first] = spans(text, refs);
  return first && refs[first.ref];
}

/** Whether the text quotes `n` consecutive words of `source`, leaving out runs it shares with `others` (a common preamble). */
export function quotes(text: string, source: string, others: string[] = [], n = 4): boolean {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const runs = (s: string) => new Set(words(s).map((_, i, all) => all.slice(i, i + n).join(" ")).filter((r) => r.split(" ").length === n));
  const shared = new Set(others.flatMap((o) => [...runs(o)]));
  const said = ` ${words(text).join(" ")} `;
  return [...runs(source)].some((r) => !shared.has(r) && said.includes(` ${r} `));
}

// ---------- the context of a mention ----------

const LIST_ITEM = /^(\s*)(?:[-*+•]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}/;
/** Clause breaks inside a sentence: a semicolon, a dash, or a comma before a contrasting conjunction. */
const CLAUSE_BREAK = /;\s*|\s+[—–]\s+|\s+--\s+|,\s+(?=(?:but|while|whereas|though|although|yet|however)\b)/gi;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=\S)/g;
/**
 * A clause or sentence that goes on speaking about what the one before it named: it opens with a pronoun ("but it is
 * only on the Spring Menu"), or with "but" and no subject of its own ("but only on the Spring Menu", "but by users").
 */
const CONTINUES = new RegExp([
  String.raw`^\s*(?:(?:but|and|while|though|although|yet|so|however|whereas)[,\s]+)?(?:it|its|it's|they|their|they're|that|which|this|these|those|both|each|neither|all of them|none of them)\b`,
  String.raw`^\s*(?:but|though|although|yet)[,\s]+(?:only|just|not|also|still|already|by|on|in|at|through|via|from|for|with|under|over|after|before|since)\b`,
].join("|"), "i");

/** The pieces of `text` between the matches of `breaks`, with where each starts. */
function pieces(text: string, breaks: RegExp): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let at = 0;
  for (const m of text.matchAll(breaks)) {
    out.push({ start: at, text: text.slice(at, m.index) });
    at = m.index + m[0].length;
  }
  out.push({ start: at, text: text.slice(at) });
  return out;
}

const clausesOf = (line: string) => pieces(line, SENTENCE_BREAK).flatMap((sentence) => pieces(sentence.text, CLAUSE_BREAK).map((c) => ({ start: sentence.start + c.start, text: c.text })));

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * Where a mention sits in an answer: the block it belongs to (a table, a list, or one clause of prose), and the text
 * that speaks about it, its context:
 * - in a table row, the row, each cell read with its column header ("Imported: Yes");
 * - in a list item, the clause of the item, and the line that introduces the list (a heading, "Still in stock:");
 * - in prose, the clause of the sentence, and the clauses after it on the same line that go on about it (`CONTINUES`).
 * `own` is the context without the introducing line: what the item or row says about itself.
 */
export function placeOf(answer: string, at: number): { block: string; context: string; own: string } {
  const lines = answer.split("\n");
  const starts = lines.map((_, i) => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0));
  const row = Math.max(0, starts.findLastIndex((s) => s <= at));
  const line = lines[row]!, column = at - starts[row]!;
  if (TABLE_ROW.test(line)) {
    let top = row;
    while (top > 0 && TABLE_ROW.test(lines[top - 1]!)) top--;
    const header = top + 1 < lines.length && TABLE_RULE.test(lines[top + 1]!) && top !== row ? cells(lines[top]!) : [];
    const context = cells(line).map((c, i) => (header[i] ? `${header[i]}: ${c}` : c)).join(" | ");
    return { block: `table ${top}`, context, own: context };
  }
  const item = LIST_ITEM.exec(line);
  if (item) {
    const indent = item[1]!.length;
    // The list runs up through items (blank lines between them included) to the line that introduces it.
    let up = row - 1;
    for (; up >= 0; up--) {
      const above = lines[up]!;
      if (!above.trim()) continue;
      const nested = LIST_ITEM.exec(above);
      if (!nested || nested[1]!.length < indent) break;
    }
    const own = clauseText(line, column);
    return { block: `list ${up}`, context: up >= 0 ? `${own} | ${lines[up]}` : own, own };
  }
  const clauses = clausesOf(line);
  const i = clauses.findLastIndex((c) => c.start <= column);
  const own = clauseText(line, column);
  return { block: `clause ${row}.${i}`, context: own, own };
}

/** The clause of a line holding position `at`, with the clauses and sentences after it that go on about the same thing. */
function clauseText(line: string, at: number): string {
  const clauses = clausesOf(line);
  const i = clauses.findLastIndex((c) => c.start <= at);
  const kept = [clauses[i]!.text];
  for (const next of clauses.slice(i + 1)) {
    if (!CONTINUES.test(next.text)) break;
    kept.push(next.text);
  }
  return kept.join(" ");
}

// ---------- what excuses a mention ----------

/**
 * Words that turn a statement around, or make it a prospect rather than a fact, when they come just before it:
 * "not imported", "hasn't been paid in full", "waiting to be imported".
 */
const NEGATED = String.raw`(?<!\b(?:not|never|no longer|hardly|isn't|aren't|wasn't|weren't|hasn't|haven't|doesn't|don't|didn't|won't|cannot|can't|to|can|could|should|must|will|would|may|might)\s+(?:(?:yet|been|be|really|fully|quite|actually|currently|even)\s+){0,2})`;
/** A value that says the opposite when a column or label is followed by it: "In stock: No", "Imported? 0". */
const DENIED = String.raw`(?!\W{0,3}(?:no|none|false|n/a|0(?![.,\d]))(?![\w.]))`;

/**
 * What lets an answer mention a wrong item without naming it as part of its answer, in the task's terms: `says` is
 * the statement ("it is in stock"). `states` are explicit statements that the item is not part of the answer
 * ("in stock", "overpaid", "outside the top ten"); `facts` are plain facts that show it (65 available, $0 left), which
 * excuse a mention only outside the part of the answer that gives the answer.
 */
export type Excuse = { says: string; states: RegExp; facts: RegExp | null };

/** Plain statements that an item is not part of the answer, which excuse a mention on every task. */
const LEFT_OUT = [
  String.raw`(?:\bnot|n't) (?:included|counted|listed|part of)`,
  String.raw`(?:does|do|did)(?:n't| not) (?:count|qualify|belong)`, String.raw`excluded`, String.raw`left (?:it |them )?out`, String.raw`not (?:on|in) (?:this|the|that) list`,
].map((p) => new RegExp(p));

/** A string is a statement that counts only when not negated just before it nor denied just after it; a RegExp is taken as written. */
type Phrase = string | RegExp;
const union = (phrases: Phrase[]) =>
  new RegExp(phrases.map((p) => `(?:${typeof p === "string" ? `${NEGATED}(?<![\\w'])(?:${p})(?![\\w'])${DENIED}` : p.source})`).join("|"), "i");

/**
 * An excuse made of phrases. A string phrase counts only when it is not negated just before it and not denied just
 * after it ("in stock", but not "not in stock" or "In stock: No"); a RegExp is taken as written, for a statement that
 * is itself a negation ("not overdue") or a name.
 */
export function excuse(says: string, states: Phrase[], facts: Phrase[] = []): Excuse {
  return { says, states: union([...states, ...LEFT_OUT]), facts: facts.length ? union(facts) : null };
}

/** A mention of a ref: where it is in the answer and what the text around it says. */
export type Mention = { ref: number; start: number; end: number; block: string; context: string; own: string };

/** Every mention of `refs` in an answer, with its place. Curly apostrophes read as straight ones. */
export function mentionsOf(answer: string, refs: Ref[]): Mention[] {
  const text = answer.replaceAll("’", "'");
  return spans(text, refs).map((s) => ({ ...s, ...placeOf(text, s.start) }));
}

/**
 * Whether a mention is excused. In a block that names a right item too (`answerBlocks`), that is the table, list or
 * clause that gives the answer, only an explicit statement on the item's own row or item excuses it. Anywhere else
 * a statement or a plain fact does, read with the line introducing its list.
 */
export function excused(m: Mention, why: Excuse, answerBlocks: Set<string> = new Set()): boolean {
  if (answerBlocks.has(m.block)) return why.states.test(m.own);
  return why.states.test(m.context) || !!why.facts?.test(m.context);
}

/**
 * The negative check: the answer names none of `refs` as part of its answer. A ref counts as named when the answer
 * mentions it at least once without excusing it (see `excused`); `right` are the items the answer should give,
 * which mark the part of the answer that gives it.
 */
export function namesNone(name: string, answer: string, refs: Ref[], unless: Excuse, right: Ref[] = []): Check {
  const blocks = new Set(mentionsOf(answer, right).map((m) => m.block));
  const named = [...new Set(mentionsOf(answer, refs).filter((m) => !excused(m, unless, blocks)).map((m) => refs[m.ref]!.label))];
  return check(name, named.length === 0, `names ${list(named)} without saying ${unless.says}`);
}

// ---------- numbers ----------

export type Num = { value: number; text: string; percent: boolean; currency: boolean; unit: "" | "g" | "kg" | "lb" };

const NUMBER = /(?<![\w.,])(\$|USD ?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?: ?(thousand|million|[kK]|M)(?![a-zA-Z]))?( ?%| ?percent)?(?: ?(kilograms?|kilos?|kg|grams?|g|pounds?|lbs?)(?![a-zA-Z]))?/g;
const UNIT: Record<string, Num["unit"]> = { kilogram: "kg", kilo: "kg", kg: "kg", gram: "g", g: "g", pound: "lb", lb: "lb" };

/** The numbers a text gives, with what marks them: $12,345.67, 12,346, $12.3k, 36.2 %, 34.65 kg. */
export function numbers(text: string): Num[] {
  return [...text.matchAll(NUMBER)].map((m) => {
    const scale = !m[4] ? 1 : /^(k|thousand)$/i.test(m[4]) ? 1e3 : 1e6;
    return {
      value: Number(`${m[2]!.replaceAll(",", "")}${m[3] ?? ""}`) * scale,
      text: m[0].trim(),
      percent: !!m[5],
      currency: !!m[1],
      unit: m[6] ? UNIT[m[6].toLowerCase().replace(/s$/, "")]! : "",
    };
  });
}

const EPSILON = 1e-9;

/** An amount of money within `tolerance` (a fraction of it) of `target`. */
export const amount = (target: number, tolerance: number) => (n: Num) => !n.percent && !n.unit && Math.abs(n.value - target) <= Math.abs(target) * tolerance + EPSILON;

/** A percentage within `points` of `target`: 36%, 36.2 % or a bare 36.2; with `fraction`, also 0.362. */
export const percentage = (target: number, points: number, fraction = false) => (n: Num) =>
  !n.currency && !n.unit && (Math.abs(n.value - target) <= points + EPSILON || (fraction && !n.percent && n.value <= 1 && Math.abs(n.value * 100 - target) <= points + EPSILON));

const PER_GRAM = { g: 1, kg: 1000, lb: 453.59237 };

/** A weight within `tolerance` (a fraction) of `grams`, in grams, kilograms or pounds. A number with no unit may be any of them. */
export const weight = (grams: number, tolerance: number) => (n: Num) =>
  !n.percent && !n.currency && (Object.entries(PER_GRAM) as [Num["unit"], number][]).some(([unit, per]) => (!n.unit || n.unit === unit) && Math.abs(n.value - grams / per) <= (grams / per) * tolerance + EPSILON);

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** Whether the text gives the count `n`, in digits or, up to twenty, in words. */
export const mentionsCount = (text: string, n: number) =>
  numbers(text).some((x) => x.value === n && !x.percent && !x.currency && !x.unit) || (n < WORDS.length && mentions(text, named(WORDS[n]!)));

// ---------- checks ----------

/** A check whose `detail`, saying what was wrong, is kept only when it fails. */
export const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, ...(detail && !pass ? { detail } : {}) });

/** A check that is reported but does not decide the run: a quality worth measuring that the request did not strictly ask for. */
export const informative = (name: string, pass: boolean, detail?: string): Check => ({ ...check(name, pass, detail), required: false });

export const list = (items: string[], most = 8, separator = ", ") =>
  items.length > most ? `${items.slice(0, most).join(separator)} and ${items.length - most} more` : items.join(separator);

export function mentionsAll(name: string, answer: string, refs: Ref[]): Check {
  const missing = refs.filter((r) => !mentions(answer, r)).map((r) => r.label);
  return check(name, missing.length === 0, `missing: ${list(missing)}`);
}

export type Expected = { ref: Ref; accepts: (n: Num) => boolean; /** The expected value, as the detail shows it. */ shows: string };

/** Each expected ref is mentioned with an accepted number in one of its passages. `others` are refs that also end a passage. */
export function valuesNear(name: string, answer: string, expected: Expected[], others: Ref[] = []): Check {
  const refs = [...expected.map((e) => e.ref), ...others.filter((o) => !expected.some((e) => e.ref.label === o.label))];
  const near = passages(answer, refs);
  const wrong = expected.flatMap((e, i) => {
    const said = near[i]!.flatMap(numbers);
    if (said.some(e.accepts)) return [];
    if (!near[i]!.length) return [`${e.ref.label} not mentioned`];
    return [`${e.ref.label}: expected ${e.shows}, found ${said.length ? [...new Set(said.map((n) => n.text))].join(", ") : "no number"}`];
  });
  return check(name, wrong.length === 0, list(wrong, 6, "; "));
}

// ---------- world changes ----------

/** The paths at which two JSON values differ, such as "products.3.tagIds". */
export function diff(a: unknown, b: unknown, path: string[] = []): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k]));
  }
  return [path.join(".") || "(the whole value)"];
}

/** Whether `pattern` covers `path`: `*` stands for any one key, `+` for an array element added after `before`. */
function covers(pattern: string, path: string, before: unknown): boolean {
  const want = pattern.split("."), got = path.split(".");
  if (want.length > got.length) return false;
  let at: unknown = before;
  return want.every((w, i) => {
    const ok = w === "*" || w === got[i] || (w === "+" && Array.isArray(at) && Number(got[i]) >= at.length);
    at = (at as Record<string, unknown> | undefined)?.[got[i]!];
    return ok;
  });
}

/** Nothing differs between `before` and `after` apart from the paths `allowed` covers ("actions", "products.*.tagIds", "contacts.+"). */
export function unchangedExcept(name: string, before: unknown, after: unknown, allowed: string[]): Check {
  const changed = diff(before, after).filter((p) => !allowed.some((a) => covers(a, p, before)));
  return check(name, changed.length === 0, `changed: ${list(changed)}`);
}

export const unchanged = (before: unknown, after: unknown) => unchangedExcept("leaves the world unchanged", before, after, []);
