// Record history and the company activity feed, both read from `world.actions`: what users and systems did,
// and what the MCP write tools did through `recordAction`.
import { addDays, bound, dayIn, inList, normalizeId, normalizeIds, page, sorted, within, zoned, type SortBy } from "../../../src/core/kit.ts";
import { ToolError, defineTool } from "../../../src/core/tool.ts";
import { PREFIX, fullName, type Action, type ActionRow as Row, type Id, type World } from "../world.ts";

type Paging = { limit?: number; cursor?: string };

/** The first rows of an action that an entry reads; the rest are counted and marked truncated. */
const ROW_CAP = 50;
const DAY = 86_400_000;
/** A calendar day lasts 25 hours when the clocks go back, so a span of whole days can run an hour long. */
const CLOCK_CHANGE = 3_600_000;

// ---------- record types ----------

/** A kind of record the world holds: its id prefix, and the name a record of it goes by now. */
type Kind = { prefix: string; nameOf(w: World, id: Id): string | undefined };
const kind = <T extends { id: Id }>(prefix: string, all: (w: World) => T[], name: (x: T) => string): Kind =>
  ({ prefix, nameOf: (w, id) => { const x = all(w).find((r) => r.id === id); return x && name(x); } });

/** The documented record types the world holds records of. Every other type has no record to show. */
const KINDS: Record<string, Kind> = {
  BATCH: kind(PREFIX.batch, (w) => w.batches, (b) => b.batchNumber),
  COMPANY: kind(PREFIX.company, (w) => w.companies, (x) => x.name),
  COMPANY_GROUP: kind(PREFIX.companyGroup, (w) => w.companyGroups, (x) => x.name),
  HARVEST: kind(PREFIX.harvest, (w) => w.harvests, (x) => x.name),
  INVOICE: kind(PREFIX.invoice, (w) => w.invoices, (i) => i.invoiceNumber),
  MENU: kind(PREFIX.menu, (w) => w.menus, (x) => x.name),
  PACKAGE: kind(PREFIX.package, (w) => w.packages, (k) => k.metrcLabel),
  PAYMENT_METHOD: kind(PREFIX.paymentMethod, (w) => w.paymentMethods, (x) => x.name),
  PAYMENT_TERM: kind(PREFIX.paymentTerm, (w) => w.paymentTerms, (x) => x.name),
  PLANT: kind(PREFIX.plant, (w) => w.plants, (p) => p.metrcLabel),
  PLANT_GROUP: kind(PREFIX.plantGroup, (w) => w.plantGroups, (x) => x.name),
  PRODUCT: kind(PREFIX.product, (w) => w.products, (x) => x.name),
  PRODUCT_CATEGORY: kind(PREFIX.category, (w) => w.categories, (x) => x.name),
  PRODUCT_GROUP: kind(PREFIX.group, (w) => w.groups, (x) => x.name),
  PURCHASE: kind(PREFIX.purchaseOrder, (w) => w.purchaseOrders, (p) => p.purchaseNumber),
  SALES_ORDER: kind(PREFIX.salesOrder, (w) => w.salesOrders, (o) => o.orderNumber),
  STOCK_TRANSFER: kind(PREFIX.stockTransfer, (w) => w.stockTransfers, (t) => t.number),
  STRAIN: kind(PREFIX.strain, (w) => w.strains, (x) => x.name),
  TAG: kind(PREFIX.tag, (w) => w.tags, (x) => x.name),
  UNIT_TYPE: kind(PREFIX.unitType, (w) => w.unitTypes, (x) => x.name),
  USER: kind(PREFIX.user, (w) => w.users, (u) => fullName(u)),
};

/** Whether a row is the record's own, rather than one of its lines. */
const own = (r: Row) => r.entity === r.type;

/** `SALES_ORDER` -> `sales order`. */
const words = (type: string) => type.toLowerCase().replaceAll("_", " ");
const sentence = (type: string) => { const s = words(type); return s[0]!.toUpperCase() + s.slice(1); };
/** `ORDER_ITEM` -> `orderItem`, the prefix of a line's field names in the activity feed. */
const camel = (type: string) => type.toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

// ---------- what both tools show of an action ----------

/** Who acted. A system action (an API key, a sync) has no user and shows no actor; `source` and `sourceDetail` name it. */
const actorOf = (a: Action) => (a.actorId ? { id: a.actorId, name: a.actorName, companyName: null } : null);

const entryHead = (a: Action) => ({ id: a.id, changedAt: a.changedAt, actor: actorOf(a), impersonator: null, source: a.source, sourceDetail: a.sourceDetail });

const byChangedAt = (actions: Action[], sortBy: SortBy | undefined) =>
  sorted(actions, sortBy, { CHANGED_AT: (a) => Date.parse(a.changedAt) }, { field: "CHANGED_AT", direction: "DESC" });

// ---------- get-record-history ----------

/** A row as the record's History tab shows it, with its id when the world keeps one for it. */
const historyRow = (r: Row) => ({ entity: r.entity, entityLabel: sentence(r.entity), op: r.op, ...(r.rowId !== null ? { rowId: r.rowId } : {}), rowLabel: r.rowLabel, fields: r.fields });

/** The record's own row first, then its lines, as the documentation orders them. */
const ownRowFirst = (a: Row, b: Row) => Number(!own(a)) - Number(!own(b));

function recordHistory(w: World, recordType: string, recordId: string) {
  const k = KINDS[recordType];
  // A type the world holds no records of is found only through the actions that name it, by the id they give.
  const id = k ? normalizeId(recordId, k.prefix) : recordId;
  const rowsIn = (a: Action) => a.records.filter((r) => r.type === recordType && r.id === id).sort(ownRowFirst);
  const actions = w.actions.filter((a) => rowsIn(a).length);
  // A deleted record keeps its history.
  if (!actions.length && k?.nameOf(w, id) === undefined) throw new ToolError(`No ${words(recordType)} found with id ${id}.`);
  return { actions, rowsIn };
}

// ---------- search-activity ----------

/** An action's rows grouped by record, in the order the records first appear. */
function byRecord(rows: Row[]): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.type} ${r.id}`, [...(groups.get(`${r.type} ${r.id}`) ?? []), r]);
  return [...groups.values()];
}

/** INSERT or DELETE when the action wrote the record's own row that way; a change to its lines alone is an UPDATE. */
const recordOp = (rows: Row[]) => rows.find(own)?.op ?? "UPDATE";

const changedFields = (rows: Row[]) => [...new Set(rows.flatMap((r) => r.fields.map((f) => (own(r) ? f.field : `${camel(r.entity)}.${f.field}`))))];

/** A record of an entry, by its current name. A record that is gone keeps the name it last had and shows no type. */
function activityRecord(w: World, rows: Row[], read: Set<Row>) {
  const { type, id, name } = rows[0]!;
  const k = KINDS[type];
  const current = k?.nameOf(w, id);
  const gone = k !== undefined && current === undefined;
  return { type: gone ? null : type, id, name: current ?? name, op: recordOp(rows), changedFields: changedFields(rows), rowCount: rows.length, truncated: rows.some((r) => !read.has(r)) };
}

function countByType(records: Row[][]) {
  const counts = new Map<string, number>();
  for (const [r] of records) counts.set(r!.type, (counts.get(r!.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
}

function activityEntry(w: World, a: Action, rows: Row[]) {
  const records = byRecord(rows);
  const read = new Set(rows.slice(0, ROW_CAP));
  return {
    ...entryHead(a), rowCount: rows.length, truncated: rows.length > ROW_CAP, recordCounts: countByType(records),
    records: records.filter((g) => g.some((r) => read.has(r))).map((g) => activityRecord(w, g, read)),
  };
}

type Range = { start?: string; end?: string };

/**
 * The `changedAt` bounds as instants. Default the last 7 days, or no bounds when actions are asked for by id.
 * Only an end reaches back 365 days; only a start may be up to 367 days ago; both may span 366 days.
 */
function changedRange(range: Range | undefined, byIds: boolean, w: World, now: Date): [number | undefined, number | undefined] {
  const after = bound(range?.start, "after", w.timezone), before = bound(range?.end, "before", w.timezone);
  if (after === undefined && before === undefined) return byIds ? [undefined, undefined] : [now.getTime() - 7 * DAY, now.getTime()];
  if (after === undefined) return [before! - 365 * DAY, before];
  if (before === undefined) {
    const earliest = addDays(dayIn(w.timezone, now), -367);
    if (after < zoned(w.timezone, earliest).getTime()) throw new ToolError(`changedAt.start can be at most 367 days ago (${earliest} or later). For older activity, send an end too.`);
    return [after, undefined];
  }
  if (after > before) throw new ToolError("changedAt.start is after changedAt.end.");
  if (before - after > 366 * DAY + CLOCK_CHANGE) throw new ToolError("changedAt can span at most 366 days. Split the range into shorter ones.");
  return [after, before];
}

type ActivitySearch = Paging & { changedAt?: Range; ids?: string[]; userIds?: string[]; sources?: string[]; ops?: string[]; recordTypes?: string[]; sortBy?: SortBy };

function searchActivity(args: ActivitySearch, w: World, now: Date) {
  const ids = normalizeIds(args.ids, PREFIX.action), userIds = normalizeIds(args.userIds, PREFIX.user);
  const [after, before] = changedRange(args.changedAt, ids !== undefined, w, now);
  const actions = w.actions.filter((a) => inList(ids, a.id) && inList(userIds, a.actorId) && inList(args.sources, a.source) && within(a.changedAt, after, before));
  return byChangedAt(actions, args.sortBy)
    .map((a) => ({ a, rows: a.records.filter((r) => inList(args.recordTypes, r.type)) }))
    .filter(({ rows }) => rows.length && (!args.ops || byRecord(rows).some((g) => args.ops!.includes(recordOp(g)))));
}

// ---------- tools ----------

export const tools = [
  defineTool<World>({
    name: "get-record-history",
    supports: ["limit", "cursor", "recordType", "recordId", "sortBy"],
    run(args: Paging & { recordType: string; recordId: string; sortBy?: SortBy }, { world: w }) {
      const { actions, rowsIn } = recordHistory(w, args.recordType, args.recordId);
      return page(byChangedAt(actions, args.sortBy), args, (a) => {
        const rows = rowsIn(a);
        // The world keeps no notes or events: every entry is a CHANGE with no events.
        return { type: "CHANGE", ...entryHead(a), rowCount: rows.length, truncated: rows.length > ROW_CAP, rows: rows.slice(0, ROW_CAP).map(historyRow), events: [] };
      });
    },
  }),

  defineTool<World>({
    name: "search-activity",
    supports: ["limit", "cursor", "changedAt", "ids", "userIds", "sources", "ops", "recordTypes", "sortBy"],
    run(args: ActivitySearch, { world: w, now }) {
      return page(searchActivity(args, w, now), args, ({ a, rows }) => activityEntry(w, a, rows));
    },
  }),
];
