// Conventions every tool shares, written once: paging, sorting, dates, ids, money, filters and text search.
// Nothing here is about the benchmark company: what its data means lives in the suite.
import { ToolError } from "./tool.ts";

// ---------- ids ----------

/** Accepts a prefixed id or the bare number; refuses an id of another kind, as the documentation says. */
export function normalizeId(value: string, prefix: string): string {
  const m = /^(?:([a-z]+)_)?(\w+)$/.exec(value);
  if (!m) throw new ToolError(`"${value}" is not a valid id.`);
  if (m[1] && m[1] !== prefix) throw new ToolError(`"${value}" is not a ${prefix}_ id.`);
  return `${prefix}_${m[2]}`;
}
export const normalizeIds = (values: string[] | undefined, prefix: string) => values?.map((v) => normalizeId(v, prefix));

// ---------- money and quantities ----------

/** Amounts and quantities travel as decimal strings. */
export const money = (n: number) => n.toFixed(2);
export const qty = (n: number) => String(Math.round(n * 10000) / 10000);

// ---------- dates ----------

/** Building a formatter is slow, and a world prints thousands of instants: one formatter per timezone and kind. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, kind: "parts" | "day"): Intl.DateTimeFormat {
  const key = `${kind} ${tz}`;
  let f = formatters.get(key);
  if (!f) {
    f = kind === "parts"
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(key, f);
  }
  return f;
}

function offsetMinutes(tz: string, at: Date): number {
  const p = Object.fromEntries(formatter(tz, "parts").formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** The instant a wall-clock time happens in a timezone. */
export function zoned(tz: string, ymd: string, time = "00:00:00"): Date {
  const guess = new Date(`${ymd}T${time}Z`);
  const first = new Date(guess.getTime() - offsetMinutes(tz, guess) * 60000);
  return new Date(guess.getTime() - offsetMinutes(tz, first) * 60000);
}

/** The calendar day of an instant in a timezone, as YYYY-MM-DD. */
export const dayIn = (tz: string, at: Date) => formatter(tz, "day").format(at);

/** ISO 8601 with the timezone's UTC offset: `2026-09-01T00:00:00-07:00`. */
export function isoIn(tz: string, at: Date): string {
  const off = offsetMinutes(tz, at);
  const local = new Date(at.getTime() + off * 60000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+", abs = Math.abs(off);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Shifts a calendar day by whole days. */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A date filter bound. `YYYY-MM-DD` is read in the company timezone (start of day for a lower bound, end of day
 * for an upper one); a timestamp must carry its UTC offset.
 */
export function bound(value: string | undefined, edge: "after" | "before", tz: string): number | undefined {
  if (value === undefined) return undefined;
  if (YMD.test(value)) return edge === "after" ? zoned(tz, value).getTime() : zoned(tz, value, "23:59:59").getTime() + 999;
  if (WITH_OFFSET.test(value)) return new Date(value).getTime();
  throw new ToolError(`"${value}" is not a date: use YYYY-MM-DD or ISO 8601 with a UTC offset, e.g. 2026-09-01T00:00:00-07:00.`);
}

/** True when an instant (ISO string, or absent) lies within inclusive bounds. An absent value never matches a set bound. */
export function within(iso: string | null | undefined, after?: number, before?: number): boolean {
  if (after === undefined && before === undefined) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return (after === undefined || t >= after) && (before === undefined || t <= before);
}

/** A timestamp input that must carry its offset. */
export function instant(value: string): Date {
  if (!WITH_OFFSET.test(value)) throw new ToolError(`"${value}" needs a full ISO 8601 timestamp with its UTC offset.`);
  return new Date(value);
}

// ---------- filters ----------

/** No list means no filter; a list matches a value in it, never a missing one. */
export const inList = <T>(list: readonly T[] | undefined, value: T | null | undefined) => !list || (value !== null && value !== undefined && list.includes(value));

/** No list means no filter; a list matches when any of the values is in it. */
export const anyInList = <T>(list: readonly T[] | undefined, values: readonly (T | null)[]) => !list || values.some((v) => v !== null && list.includes(v));

export type Status = "ACTIVE" | "ANY" | "INACTIVE";

/** The `status` filter of the tools that take ACTIVE, ANY or INACTIVE: ACTIVE unless the call says otherwise. */
export const inStatus = (status: Status | undefined, active: boolean) => (status ?? "ACTIVE") === "ANY" || ((status ?? "ACTIVE") === "ACTIVE") === active;

// ---------- text ----------

type Text = string | null | undefined;

/** Case-insensitive substring over several fields. */
export const matches = (search: string | undefined, ...fields: Text[]) =>
  !search || fields.some((f) => f?.toLowerCase().includes(search.toLowerCase()));

/** The `search` of the payment tools: a case-insensitive substring where % matches any run of characters and _ any one character. */
export function like(term: string, ...fields: Text[]): boolean {
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*").replaceAll("_", "."), "i");
  return fields.some((f) => !!f && pattern.test(f));
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** Every word of the term within a typo (one per four letters) of a word of the field: the summed distance, else undefined. */
function typoDistance(term: string, field: string): number | undefined {
  const termWords = words(term), fieldWords = words(field);
  if (!termWords.length || !fieldWords.length) return undefined;
  let total = 0;
  for (const t of termWords) {
    const d = Math.min(...fieldWords.map((f) => editDistance(t, f)));
    if (d > Math.floor(t.length / 4)) return undefined;
    total += d;
  }
  return total;
}

/** A score above any closeness, so that `tiers` can rank one kind of match after another. */
const TIER = 1e12;
const TYPO = 1e6;

/**
 * How closely a search term names a record: lower is closer, undefined when it does not match. A case-insensitive
 * substring of any of `fields` scores the characters the field has beyond the term, so an exact match scores 0 and
 * the shortest containing value ranks first. `fuzzy` are fields that also match word by word within a typo; such a
 * match ranks after every substring match. This is the one similarity ranking every search tool uses.
 */
export function closeness(term: string, fields: Text[], fuzzy: Text[] = []): number | undefined {
  const t = term.toLowerCase();
  const all = [...fields, ...fuzzy].filter((f): f is string => !!f);
  const contained = all.filter((f) => f.toLowerCase().includes(t)).map((f) => f.length - t.length);
  if (contained.length) return Math.min(...contained);
  const typos = fuzzy.flatMap((f) => (f ? [typoDistance(t, f)] : [])).filter((d): d is number => d !== undefined);
  return typos.length ? TYPO + Math.min(...typos) : undefined;
}

/** The first score that is defined, ranked after every score of the tiers before it: label matches, then name matches. */
export function tiers(...scores: (number | undefined)[]): number | undefined {
  const i = scores.findIndex((s) => s !== undefined);
  return i < 0 ? undefined : i * TIER + scores[i]!;
}

/** The items a search matches, closest first; `score` is undefined for an item that does not match. Ties keep their order. */
export function ranked<T>(items: T[], score: (item: T) => number | undefined): T[] {
  return items.flatMap((item) => { const s = score(item); return s === undefined ? [] : [{ item, s }]; }).sort((a, b) => a.s - b.s).map((x) => x.item);
}

// ---------- sorting and paging ----------

export type SortBy = { field: string; direction: "ASC" | "DESC" };

/** Sorts by one of a tool's named sort fields. `fields` maps each documented field to the value it compares. */
export function sorted<T>(items: T[], sortBy: SortBy | undefined, fields: Record<string, (item: T) => string | number | null | undefined>, fallback: SortBy): T[] {
  const { field, direction } = sortBy ?? fallback;
  const get = fields[field];
  if (!get) throw new ToolError(`This benchmark world cannot sort by ${field}. It sorts by: ${Object.keys(fields).join(", ")}.`);
  const sign = direction === "ASC" ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = get(a) ?? "", y = get(b) ?? "";
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sign;
  });
}

const MAX_LIMIT = 100;
/** The most rows a report returns per page, whatever maxRowsLimit asks for. */
const MAX_REPORT_ROWS = 5000;

function readCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  if (!Number.isInteger(n) || n < 0) throw new ToolError("Invalid cursor: pass the nextCursor of the previous call unchanged.");
  return n;
}

/** The page shape of every search tool: `limit` (10 by default, 100 at most) and an opaque `cursor`. */
export function page<T, R>(all: T[], args: { limit?: number; cursor?: string }, render: (item: T) => R) {
  const limit = args.limit ?? 10;
  if (limit < 1 || limit > MAX_LIMIT) throw new ToolError(`limit must be between 1 and ${MAX_LIMIT}.`);
  const start = readCursor(args.cursor);
  const hasMore = start + limit < all.length;
  return {
    items: all.slice(start, start + limit).map(render),
    hasMore,
    ...(hasMore ? { nextCursor: Buffer.from(String(start + limit)).toString("base64url") } : {}),
    totalCount: all.length,
  };
}

/** A date range a report takes: either end may be left out. */
export type DateSpan = { start?: string; end?: string };

/** The date range a report covers when the call sends none: the last `days` calendar days, today included. */
export const lastDays = (today: string, days = 30): DateSpan => ({ start: addDays(today, 1 - days), end: today });

/** `meta.dateRange` of a report: `orderDatetime 2026-07-01 to 2026-09-30; dueDatetime ...`, naming each date filter it applied. */
export function describeRanges(ranges: [string, DateSpan | undefined][]): string {
  const set = ranges.filter((r): r is [string, DateSpan] => r[1] !== undefined);
  return set.map(([name, s]) => `${name} ${s.start ?? "any"} to ${s.end ?? "any"}`).join("; ") || "all dates";
}

/**
 * The page shape of every report tool: `meta`, `rows` and a `nextCursor` only when the report was cut short.
 * `columns` lists the report's columns for the tools that document `meta.columns`.
 */
export function report<R>(
  info: { report: string; dateRange: string; columns?: { key: string; label: string }[] },
  rows: R[],
  args: { maxRowsLimit?: number; cursor?: string },
  defaultLimit = 500,
) {
  const rowLimit = args.maxRowsLimit ?? defaultLimit;
  if (rowLimit < 1 || rowLimit > MAX_REPORT_ROWS) throw new ToolError(`maxRowsLimit must be between 1 and ${MAX_REPORT_ROWS}.`);
  const offset = readCursor(args.cursor);
  const slice = rows.slice(offset, offset + rowLimit);
  const truncated = offset + rowLimit < rows.length;
  return {
    meta: { report: info.report, dateRange: info.dateRange, rowLimit, offset, rowCount: slice.length, totalRowCount: rows.length, truncated, ...(info.columns ? { columns: info.columns } : {}) },
    rows: slice,
    ...(truncated ? { nextCursor: Buffer.from(String(offset + rowLimit)).toString("base64url") } : {}),
  };
}
