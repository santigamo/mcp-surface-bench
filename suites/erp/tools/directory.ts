// Customers, vendors, the signed-in company, their contacts, and the team's tasks.
import { bound, closeness, inList, isoIn, matches, money, normalizeId, normalizeIds, page, ranked, sorted, within, zoned, type SortBy } from "../../../src/core/kit.ts";
import { defineTool, ToolError } from "../../../src/core/tool.ts";
import { fullName, invoiceMoney, lastChanged, newId, PREFIX, type ActionRow, type Company, type Contact, type Id, type Task, type World } from "../world.ts";
import { customFieldValues, find, named, recordAction, stamp, userRef, type C } from "./shared.ts";

// ---------- companies ----------

/**
 * A company as the directory lists it. `world.companies` holds the counterparties; the signed-in company is built
 * from `world.company`, which has no owner, payment terms, group or address.
 */
type Listed = Omit<Company, "relationship" | "city" | "zip"> & { mine: boolean; city: string | null; zip: string | null };

function listed(w: World): Listed[] {
  const own: Listed = {
    id: w.company.id, name: w.company.name, legalName: w.company.legalName, mine: true, ownerId: null, invoiceEmail: null, phone: null, city: null, state: w.company.state, zip: null,
    licenseNumber: null, groupId: null, paymentTermId: null,
    // The world does not say when the company joined; it predates every counterparty.
    createdAt: w.companies.map((c) => c.createdAt).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)),
  };
  return [own, ...w.companies.map((c) => ({ ...c, mine: false }))];
}

const licenseNumbers = (w: World, c: Listed) => (c.mine ? w.licenses.map((l) => l.licenseNumber) : c.licenseNumber ? [c.licenseNumber] : []);

/** Unpaid invoice money: all of it, and the part of delivered or completed orders due before today, which never exceeds it. */
function balances(w: World, c: Listed) {
  const startOfToday = zoned(w.timezone, w.today).getTime();
  let outstanding = 0, pastDue = 0;
  for (const inv of w.invoices.filter((i) => i.customerId === c.id && !i.voided)) {
    const { remaining } = invoiceMoney(w, inv);
    const order = w.salesOrders.find((o) => o.id === inv.salesOrderId)!;
    outstanding += remaining;
    if ((order.status === "DELIVERED" || order.status === "COMPLETED") && Date.parse(inv.dueDatetime) < startOfToday) pastDue += remaining;
  }
  return { outstanding, pastDue: Math.min(pastDue, outstanding) };
}

/** The order date of the company's latest sales order that was not canceled. */
const lastOrderDate = (w: World, c: Listed) =>
  w.salesOrders.filter((o) => o.customerId === c.id && o.status !== "CANCELED").map((o) => o.orderDatetime).reduce<string | null>((a, b) => (!a || Date.parse(b) > Date.parse(a) ? b : a), null);

/** A user as company and contact records embed one: `{ id, fullName }`. */
const ownerOf = (w: World, id: Id | null) => {
  const u = userRef(w, id);
  return u ? { id: u.id, fullName: u.profile.fullName } : null;
};

/** The search-companies summary of a company. */
function companySummary(w: World, c: Listed) {
  const { outstanding, pastDue } = balances(w, c);
  const term = c.paymentTermId ? w.paymentTerms.find((t) => t.id === c.paymentTermId) : undefined;
  return {
    id: c.id, name: c.name, isMyCompany: c.mine, customFields: customFieldValues(w, "COMPANY"), legalBusinessName: c.legalName,
    // Company categories, relationship types and credits are lists the world does not hold.
    category: null, creditBalance: money(0),
    outstandingBalance: money(outstanding), pastDueBalance: money(pastDue),
    outstandingBalanceThreshold: null, invoiceEmail: c.invoiceEmail, defaultPaymentTerm: term ? { id: term.id, name: term.name } : null,
    owner: ownerOf(w, c.ownerId), defaultInventoryLocation: null, lastOrderDate: lastOrderDate(w, c), relationshipType: null,
    group: named(w.companyGroups, c.groupId), email: null, phone: c.phone, website: null,
    qbCustomerId: null, qbCustomer: null, qbVendorId: null, qbVendor: null, leaflinkBrandId: null, leaflinkCustomerId: null,
  };
}

const contactView = (w: World, k: Contact) => ({
  id: k.id, firstName: k.firstName, lastName: k.lastName, title: k.title, description: null, email: k.email, phone: k.phone, workPhone: null,
  owner: ownerOf(w, k.ownerId), driverLicenseNumber: null, driverLicenseIssuingState: null, customFields: customFieldValues(w, "CONTACT"),
});

// The world keeps one city, state and zip per counterparty and no street, so a company has one address, with no
// street, under an id made from the company's number. Licenses likewise: a counterparty's one license number.
const companyNumber = (c: Listed) => c.id.split("_")[1]!;

const addresses = (c: Listed) =>
  c.city === null ? [] : [{ id: `cloc_${companyNumber(c)}`, name: c.name, streetAddress: "", city: c.city, state: c.state, zip: c.zip ?? "", country: "US", license: c.licenseNumber ? { id: `clic_${companyNumber(c)}`, licenseNumber: c.licenseNumber } : null }];

function licenses(w: World, c: Listed) {
  const endOf = (ymd: string) => isoIn(w.timezone, zoned(w.timezone, ymd, "23:59:59"));
  if (c.mine) return w.licenses.map((l) => ({ id: l.id, licenseNumber: l.licenseNumber, licenseType: l.kind, complianceType: l.complianceType, isActive: l.active, issueDatetime: null, expiryDatetime: endOf(l.expiryDate) }));
  // The world records no dates for a counterparty's license; its expiry is shown as the end of next year.
  const expiryDatetime = endOf(`${+w.today.slice(0, 4) + 1}-12-31`);
  return c.licenseNumber ? [{ id: `clic_${companyNumber(c)}`, licenseNumber: c.licenseNumber, licenseType: "", complianceType: "METRC" as const, isActive: true, issueDatetime: null, expiryDatetime }] : [];
}

type CompanySearch = {
  limit?: number; cursor?: string; ids?: string[]; search?: string; isMyCompany?: boolean; city?: string; zip?: string; licenseNumber?: string; groupIds?: string[];
  hasOutstandingBalance?: boolean; lastOrderDateAfter?: string; lastOrderDateBefore?: string; sortBy?: SortBy;
};

function searchCompanies(w: World, args: CompanySearch) {
  const ids = normalizeIds(args.ids, PREFIX.company), groupIds = normalizeIds(args.groupIds, PREFIX.companyGroup);
  const after = bound(args.lastOrderDateAfter, "after", w.timezone), before = bound(args.lastOrderDateBefore, "before", w.timezone);
  const hits = listed(w).filter((c) =>
    inList(ids, c.id) &&
    (args.isMyCompany === undefined || c.mine === args.isMyCompany) &&
    matches(args.city, c.city) &&
    (args.zip === undefined || c.zip?.toLowerCase() === args.zip.toLowerCase()) &&
    (args.licenseNumber === undefined || matches(args.licenseNumber, ...licenseNumbers(w, c))) &&
    inList(groupIds, c.groupId) &&
    (args.hasOutstandingBalance === undefined || balances(w, c).outstanding > 0 === args.hasOutstandingBalance) &&
    within(lastOrderDate(w, c), after, before));
  if (args.search) return ranked(hits, (c) => closeness(args.search!, [], [c.name, c.legalName]));
  const fields = {
    NAME: (c: Listed) => c.name, INSERTED_AT: (c: Listed) => Date.parse(c.createdAt), UPDATED_AT: (c: Listed) => Date.parse(lastChanged(w, "COMPANY", c.id, c.createdAt)),
    OUTSTANDING_BALANCE: (c: Listed) => balances(w, c).outstanding, PAST_DUE_BALANCE: (c: Listed) => balances(w, c).pastDue,
    LAST_ORDER_DATE: (c: Listed) => Date.parse(lastOrderDate(w, c)!),
  };
  // Companies with no sales orders come last whichever way LAST_ORDER_DATE sorts.
  const [dated, undated] = args.sortBy?.field === "LAST_ORDER_DATE" ? [hits.filter((c) => lastOrderDate(w, c)), hits.filter((c) => !lastOrderDate(w, c))] : [hits, []];
  return [...sorted(dated, args.sortBy, fields, { field: "UPDATED_AT", direction: "DESC" }), ...undated];
}

/** The company an id names, the signed-in one included, or undefined. */
const companyById = (w: World, id: string) => listed(w).find((c) => c.id === normalizeId(id, PREFIX.company));

// ---------- contacts ----------

type ContactFields = { lastName?: string | null; title?: string | null; email?: string | null; phone?: string | null; ownerId?: string | null };
type ContactArgs = ContactFields & { action: "CREATE" | "UPDATE" | "DELETE"; id?: string; companyId?: string; firstName?: string };

const LABELS: Record<keyof ContactFields | "firstName", string> = { firstName: "First name", lastName: "Last name", title: "Title", email: "Email", phone: "Phone", ownerId: "Owner" };

/** Checks the values a CREATE or UPDATE sets, and returns them as stored. */
function contactValues(w: World, args: ContactArgs): Partial<Contact> {
  const values: Partial<Contact> = {};
  if (args.firstName !== undefined) {
    if (!args.firstName.trim()) throw new ToolError("firstName cannot be blank.");
    values.firstName = args.firstName.trim();
  }
  for (const key of ["lastName", "title", "email", "phone"] as const) if (args[key] !== undefined) values[key] = args[key]?.trim() || null;
  if (args.ownerId !== undefined) values.ownerId = args.ownerId === null ? null : find(w.users, normalizeId(args.ownerId, PREFIX.user), "user").id;
  return values;
}

function contactChanges(before: Partial<Contact>, after: Partial<Contact>) {
  return (Object.keys(LABELS) as (keyof typeof LABELS)[])
    .filter((k) => (before[k] ?? null) !== after[k])
    .map((k) => ({ field: k, label: LABELS[k], oldValue: before[k] ?? null, newValue: after[k] ?? null }));
}

/** A contact is a line of its company: a change to it is a CONTACT row in the company's history. */
function contactRow(w: World, contact: Contact, op: ActionRow["op"], fields: ActionRow["fields"]): ActionRow {
  const company = companyById(w, contact.companyId)!;
  return { type: "COMPANY", id: company.id, name: company.name, entity: "CONTACT", rowId: contact.id, op, rowLabel: fullName(contact), fields };
}

function createContact(c: C, args: ContactArgs) {
  const w = c.world;
  if (args.companyId === undefined || args.firstName === undefined) throw new ToolError("CREATE needs companyId and firstName.");
  const company = companyById(w, args.companyId);
  if (!company) throw new ToolError(`No company found with id ${args.companyId}. Resolve it via distru-search-companies.`);
  const values = contactValues(w, args);
  const contact: Contact = { id: newId(w, PREFIX.contact), companyId: company.id, firstName: "", lastName: null, title: null, email: null, phone: null, ownerId: null, createdAt: stamp(c), ...values };
  w.contacts.push(contact);
  recordAction(c, [contactRow(w, contact, "INSERT", contactChanges({}, contact))]);
  return { contact: contactView(w, contact) };
}

function updateContact(c: C, args: ContactArgs, contact: Contact) {
  if (args.companyId !== undefined && normalizeId(args.companyId, PREFIX.company) !== contact.companyId) throw new ToolError("A contact's companyId cannot change. Create the contact at the other company and delete this one.");
  const values = contactValues(c.world, args);
  const before = { ...contact };
  Object.assign(contact, values);
  recordAction(c, [contactRow(c.world, contact, "UPDATE", contactChanges(before, contact))]);
  return { contact: contactView(c.world, contact) };
}

function deleteContact(c: C, contact: Contact) {
  c.world.contacts.splice(c.world.contacts.indexOf(contact), 1);
  recordAction(c, [contactRow(c.world, contact, "DELETE", contactChanges(contact, {}))]);
  return { id: contact.id };
}

// ---------- tasks ----------

/** The record-id filters of search-tasks, with the related type and id prefix each one matches. */
const TASK_LINKS = {
  companyIds: { type: "COMPANY", prefix: PREFIX.company }, salesOrderIds: { type: "SALES_ORDER", prefix: PREFIX.salesOrder }, purchaseOrderIds: { type: "PURCHASE_ORDER", prefix: PREFIX.purchaseOrder },
  invoiceIds: { type: "INVOICE", prefix: PREFIX.invoice }, productIds: { type: "PRODUCT", prefix: PREFIX.product },
} as const;
type TaskLink = keyof typeof TASK_LINKS;

type TaskSearch = { [K in TaskLink]?: string[] } & {
  limit?: number; cursor?: string; ids?: string[]; search?: string; statuses?: Task["status"][]; ownerIds?: string[]; dueDateAfter?: string; dueDateBefore?: string; relatedTypes?: string[]; sortBy?: SortBy;
};

/** The one record-id filter a search-tasks call sets, as the related type and ids it matches. */
function taskLink(args: TaskSearch): { type: string; ids: string[] } | undefined {
  const set = (Object.keys(TASK_LINKS) as TaskLink[]).filter((k) => args[k] !== undefined);
  if (set.length > 1) throw new ToolError(`Pass at most one record ID filter; this call sets ${set.join(", ")}.`);
  if (set.length && args.relatedTypes) throw new ToolError(`relatedTypes cannot be combined with ${set[0]}.`);
  const key = set[0];
  return key ? { type: TASK_LINKS[key].type, ids: normalizeIds(args[key], TASK_LINKS[key].prefix)! } : undefined;
}

function taskView(w: World, t: Task) {
  const linked = (type: string) => (t.related?.type === type ? t.related.id : null);
  const order = w.salesOrders.find((o) => o.id === linked("SALES_ORDER"));
  const purchase = w.purchaseOrders.find((p) => p.id === linked("PURCHASE_ORDER"));
  const invoice = w.invoices.find((i) => i.id === linked("INVOICE"));
  const product = w.products.find((p) => p.id === linked("PRODUCT"));
  return {
    // No tool changes a task, so it last changed when it was created.
    id: t.id, name: t.name, description: t.description, status: t.status, dueDate: t.dueDate, color: null, insertedAt: t.createdAt, updatedAt: t.createdAt,
    relatedType: t.related?.type ?? null, company: named(w.companies, linked("COMPANY")),
    salesOrder: order ? { id: order.id, orderNumber: order.orderNumber } : null,
    purchaseOrder: purchase ? { id: purchase.id, purchaseNumber: purchase.purchaseNumber } : null,
    invoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber } : null,
    product: product ? { id: product.id, name: product.name, sku: product.sku } : null,
    batch: null, contact: null, assembly: null, return: null,
    owner: userRef(w, t.ownerId), creator: userRef(w, t.creatorId), location: null, customFields: customFieldValues(w, "TASK"),
  };
}

function searchTasks(w: World, args: TaskSearch) {
  const ids = normalizeIds(args.ids, PREFIX.task), ownerIds = normalizeIds(args.ownerIds, PREFIX.user), link = taskLink(args);
  const after = bound(args.dueDateAfter, "after", w.timezone), before = bound(args.dueDateBefore, "before", w.timezone);
  const hits = w.tasks.filter((t) =>
    inList(ids, t.id) &&
    inList(args.statuses, t.status) &&
    inList(ownerIds, t.ownerId) &&
    within(t.dueDate, after, before) &&
    (!args.relatedTypes || (t.related !== null && args.relatedTypes.includes(t.related.type))) &&
    (!link || (t.related?.type === link.type && link.ids.includes(t.related.id))));
  if (args.search) return ranked(hits, (t) => closeness(args.search!, [t.name]));
  return sorted(hits, args.sortBy, {
    DUE_DATE: (t) => Date.parse(t.dueDate), INSERTED_AT: (t) => Date.parse(t.createdAt), NAME: (t) => t.name, UPDATED_AT: (t) => Date.parse(t.createdAt),
  }, { field: "UPDATED_AT", direction: "DESC" });
}

// ---------- tools ----------

export const tools = [
  defineTool<World>({
    name: "search-companies",
    supports: ["limit", "cursor", "ids", "search", "isMyCompany", "city", "zip", "licenseNumber", "groupIds", "hasOutstandingBalance", "lastOrderDateAfter", "lastOrderDateBefore", "sortBy"],
    run: (args: CompanySearch, { world: w }) => page(searchCompanies(w, args), args, (c) => companySummary(w, c)),
  }),

  defineTool<World>({
    name: "get-company",
    supports: ["id", "includeContacts", "includeLocations", "includeLicenses"],
    run(args: { id: string; includeContacts?: boolean; includeLocations?: boolean; includeLicenses?: boolean }, { world: w }) {
      const c = companyById(w, args.id);
      if (!c) return { company: null };
      return {
        company: {
          ...companySummary(w, c),
          usState: c.state, description: null, defaultSalesOrderNotes: null, defaultPurchaseOrderNotes: null,
          // The world keeps one email per company, the one invoices go to.
          salesOrderEmail: null, orderShipmentEmail: null, purchaseOrderEmail: null,
          ...(args.includeContacts ? { contacts: w.contacts.filter((k) => k.companyId === c.id).map((k) => contactView(w, k)) } : {}),
          ...(args.includeLocations ? { locations: addresses(c) } : {}),
          ...(args.includeLicenses ? { licenses: licenses(w, c) } : {}),
        },
      };
    },
  }),

  defineTool<World>({
    name: "search-contacts",
    supports: ["limit", "cursor", "ids", "companyIds", "search", "sortBy"],
    run(args: { limit?: number; cursor?: string; ids?: string[]; companyIds?: string[]; search?: string; sortBy?: SortBy }, { world: w }) {
      const ids = normalizeIds(args.ids, PREFIX.contact), companyIds = normalizeIds(args.companyIds, PREFIX.company);
      const companyName = (k: Contact) => companyById(w, k.companyId)?.name ?? null;
      const updatedAt = (k: Contact) => lastChanged(w, "CONTACT", k.id, k.createdAt);
      const hits = w.contacts.filter((k) => inList(ids, k.id) && inList(companyIds, k.companyId));
      const ordered = args.search
        ? ranked(hits, (k) => closeness(args.search!, [k.email], [fullName(k), companyName(k)]))
        : sorted(hits, args.sortBy, { FULL_NAME: fullName, INSERTED_AT: (k) => Date.parse(k.createdAt), UPDATED_AT: (k) => Date.parse(updatedAt(k)) }, { field: "UPDATED_AT", direction: "DESC" });
      return page(ordered, args, (k) => ({ ...contactView(w, k), company: { id: k.companyId, name: companyName(k) }, insertedAt: k.createdAt, updatedAt: updatedAt(k) }));
    },
  }),

  defineTool<World>({
    name: "mutate-company-contact",
    supports: ["action", "id", "companyId", "firstName", "lastName", "title", "email", "phone", "ownerId"],
    run(args: ContactArgs, c) {
      if (args.action === "CREATE") return createContact(c, args);
      if (args.id === undefined) throw new ToolError(`${args.action} needs the contact's id. Resolve it via distru-search-contacts.`);
      const contact = find(c.world.contacts, normalizeId(args.id, PREFIX.contact), "contact");
      return args.action === "UPDATE" ? updateContact(c, args, contact) : deleteContact(c, contact);
    },
  }),

  defineTool<World>({
    name: "search-tasks",
    supports: ["limit", "cursor", "ids", "search", "statuses", "ownerIds", "dueDateAfter", "dueDateBefore", "relatedTypes", "companyIds", "salesOrderIds", "purchaseOrderIds", "invoiceIds", "productIds", "sortBy"],
    run: (args: TaskSearch, { world: w }) => page(searchTasks(w, args), args, (t) => taskView(w, t)),
  }),
];
