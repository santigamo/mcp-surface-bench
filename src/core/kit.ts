// Conventions every tool shares, written once: paging, sorting, dates, ids and money.
import { ToolError } from "./tool.ts";

// ---------- ids ----------

/** `com_12`. Ids carry a prefix that says what they are. */
export const makeId = (prefix: string, n: number) => `${prefix}_${n}`;

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

function offsetMinutes(tz: string, at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
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
export const dayIn = (tz: string, at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

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

// ---------- text ----------

/** Case-insensitive substring over several fields. */
export const matches = (search: string | undefined, ...fields: (string | null | undefined)[]) =>
  !search || fields.some((f) => f?.toLowerCase().includes(search.toLowerCase()));

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
  if (rowLimit < 1) throw new ToolError("maxRowsLimit must be at least 1.");
  const offset = readCursor(args.cursor);
  const slice = rows.slice(offset, offset + rowLimit);
  const truncated = offset + rowLimit < rows.length;
  return {
    meta: { report: info.report, dateRange: info.dateRange, rowLimit, offset, rowCount: slice.length, totalRowCount: rows.length, truncated, ...(info.columns ? { columns: info.columns } : {}) },
    rows: slice,
    ...(truncated ? { nextCursor: Buffer.from(String(offset + rowLimit)).toString("base64url") } : {}),
  };
}

/** Looks a record up by id or raises the error the model would get for an id that does not exist. */
export function need<T extends { id: string }>(items: T[], id: string, what: string): T {
  const found = items.find((i) => i.id === id);
  if (!found) throw new ToolError(`No ${what} with id ${id}.`);
  return found;
}
