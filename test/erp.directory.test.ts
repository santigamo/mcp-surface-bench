import { describe, expect, test } from "bun:test";
import { invoiceMoney, type World } from "../suites/erp/world.ts";
import { bench, TODAY } from "./helpers.ts";

const company = (w: World, name: string) => w.companies.find((c) => c.name === name)!;
const NOW = "2026-11-23T10:00:00-08:00";

describe("search-companies", () => {
  test("lists the counterparties and the signed-in company, across pages", () => {
    const { call, world } = bench();
    const first = call("search-companies");
    expect(first.totalCount).toBe(world.companies.length + 1);
    const seen = [...first.items];
    for (let r = first; r.hasMore; ) { r = call("search-companies", { cursor: r.nextCursor }); seen.push(...r.items); }
    expect(new Set(seen.map((c: any) => c.id)).size).toBe(25);
    expect(seen.filter((c: any) => c.isMyCompany).map((c: any) => c.name)).toEqual(["Tidewater Cannabis Co."]);
    // Greenleaf's phone changed yesterday, the latest change to any company.
    expect(seen[0].name).toBe("Greenleaf Collective");
  });

  test("Sunset finds both Sunset companies with their own reps and invoice emails", () => {
    const { call } = bench();
    const r = call("search-companies", { search: "Sunset" });
    expect(r.items.map((c: any) => [c.name, c.owner.fullName, c.invoiceEmail])).toEqual([
      ["Sunset Dispensary", "Daniel Reyes", "dana.whitlock@sunsetdispensary.example"],
      ["Sunset Wellness Collective", "Priya Nair", "paul.dunn@sunsetwellnesscollective.example"],
    ]);
    expect(r.items[0]).toMatchObject({ isMyCompany: false, legalBusinessName: "Sunset Dispensary LLC", group: { name: "Southern California" }, defaultPaymentTerm: { name: "Net 30" } });
    expect(r.items[0].customFields).toEqual([{ customField: { id: "cf_3", name: "Delivery window", fieldType: "TEXT" }, value: null }]);
    expect(call("search-companies", { search: "sunet dispensary" }).items[0].name).toBe("Sunset Dispensary");
    expect(call("search-companies", { search: "zzzz" }).totalCount).toBe(0);
  });

  test("isMyCompany picks the signed-in company or the counterparties", () => {
    const { call, world } = bench();
    expect(call("search-companies", { isMyCompany: true }).items.map((c: any) => [c.id, c.name, c.isMyCompany])).toEqual([["com_0", "Tidewater Cannabis Co.", true]]);
    expect(call("search-companies", { isMyCompany: false }).totalCount).toBe(world.companies.length);
  });

  test("balances come from the invoices", () => {
    const { call, world } = bench();
    const harbor = company(world, "Harbor Lights Cannabis");
    const owed = world.invoices.filter((i) => i.customerId === harbor.id && !i.voided).reduce((n, i) => n + invoiceMoney(world, i).remaining, 0);
    const item = call("search-companies", { ids: [harbor.id] }).items[0];
    expect(item.outstandingBalance).toBe(owed.toFixed(2));
    expect(+item.pastDueBalance).toBeGreaterThan(0);
    expect(+item.pastDueBalance).toBeLessThanOrEqual(+item.outstandingBalance);
    const owing = call("search-companies", { hasOutstandingBalance: true, limit: 100 }).items;
    expect(owing.every((c: any) => +c.outstandingBalance > 0)).toBe(true);
    expect(call("search-companies", { hasOutstandingBalance: false, limit: 100 }).totalCount).toBe(25 - owing.length);
    const top = call("search-companies", { sortBy: { field: "OUTSTANDING_BALANCE", direction: "DESC" }, limit: 3 }).items.map((c: any) => +c.outstandingBalance);
    expect([...top].sort((a, b) => b - a)).toEqual(top);
    const late = call("search-companies", { sortBy: { field: "PAST_DUE_BALANCE", direction: "DESC" }, limit: 1 }).items[0];
    expect(+late.pastDueBalance).toBeGreaterThan(0);
  });

  test("filters by city, zip, license, group and last order date", () => {
    const { call, world } = bench();
    const names = (args: Record<string, unknown>) => call("search-companies", { limit: 100, ...args }).items.map((c: any) => c.name).sort();
    expect(names({ city: "san francisco" })).toEqual(["Golden Gate Greens", "Marina Green Dispensary", "Sunset Dispensary"]);
    expect(names({ zip: "94130" })).toEqual(["Sunset Dispensary"]);
    expect(names({ zip: "9413" })).toEqual([]);
    expect(names({ licenseNumber: "c10-1000170" })).toEqual(["Sunset Dispensary"]);
    expect(names({ licenseNumber: "C11-0000482" })).toEqual(["Tidewater Cannabis Co."]);
    expect(names({ groupIds: ["cgr_1"] })).toEqual(world.companies.filter((c) => c.groupId === "cgr_1").map((c) => c.name).sort());
    const recent = names({ lastOrderDateAfter: "2026-11-19" });
    expect(recent).toContain("Bayside Botanicals");
    expect(recent).not.toContain("Humboldt Family Farms");
    expect(names({ lastOrderDateBefore: "2025-01-01" })).toEqual([]);
  });

  test("sorts by each documented field", () => {
    const { call } = bench();
    const names = (field: string, direction: string, limit = 2) => call("search-companies", { sortBy: { field, direction }, limit }).items.map((c: any) => c.name);
    expect(names("NAME", "ASC")).toEqual(["Bayside Botanicals", "Cali Vape Works"]);
    expect(names("INSERTED_AT", "ASC")).toEqual(["Tidewater Cannabis Co.", "Humboldt Family Farms"]);
    expect(names("UPDATED_AT", "DESC", 1)).toEqual(["Greenleaf Collective"]);
    expect(names("LAST_ORDER_DATE", "DESC", 1)).toEqual(["Emerald Coast Dispensary"]);
    // Vendors and the signed-in company have no sales orders and come last in both directions.
    const asc = call("search-companies", { sortBy: { field: "LAST_ORDER_DATE", direction: "ASC" }, limit: 100 }).items;
    expect(asc.at(-1).lastOrderDate).toBeNull();
    expect(asc[0].lastOrderDate).not.toBeNull();
  });

  test("refuses what it should", () => {
    const { error } = bench();
    expect(error("search-companies", { ids: ["usr_1"] })).toContain("tool_error");
    expect(error("search-companies", { lastOrderDateAfter: "yesterday" })).toContain("tool_error");
    expect(error("search-companies", { relationshipTypeIds: ["1"] })).toContain("unsupported_input");
    expect(error("search-companies", { sortBy: { field: "NAME" } })).toContain("invalid_arguments");
  });
});

describe("get-company", () => {
  test("returns the summary and, when asked, contacts with titles and emails, addresses and licenses", () => {
    const { call, world } = bench();
    const sunset = company(world, "Sunset Dispensary");
    const bare = call("get-company", { id: sunset.id }).company;
    expect(bare).toMatchObject({ name: "Sunset Dispensary", owner: { fullName: "Daniel Reyes" }, usState: "CA", invoiceEmail: "dana.whitlock@sunsetdispensary.example" });
    expect(bare.contacts).toBeUndefined();
    const full = call("get-company", { id: sunset.id.split("_")[1], includeContacts: true, includeLocations: true, includeLicenses: true }).company;
    expect(full.contacts.map((k: any) => [k.firstName, k.lastName, k.title, k.email])).toEqual([
      ["Marcus", "Bell", "Buyer", "marcus.bell@sunsetdispensary.example"],
      ["Dana", "Whitlock", "Accounts Payable", "dana.whitlock@sunsetdispensary.example"],
    ]);
    expect(full.locations).toEqual([{ id: "cloc_11", name: "Sunset Dispensary", streetAddress: "", city: "San Francisco", state: "CA", zip: "94130", country: "US", license: { id: "clic_11", licenseNumber: "C10-1000170-LIC" } }]);
    expect(full.licenses.map((l: any) => l.licenseNumber)).toEqual(["C10-1000170-LIC"]);
  });

  test("returns the signed-in company with its own licenses", () => {
    const { call } = bench();
    const mine = call("get-company", { id: "com_0", includeContacts: true, includeLocations: true, includeLicenses: true }).company;
    expect(mine).toMatchObject({ id: "com_0", isMyCompany: true, name: "Tidewater Cannabis Co.", legalBusinessName: "Tidewater Cannabis Company, Inc.", owner: null, contacts: [], locations: [] });
    expect(mine.licenses.map((l: any) => [l.id, l.licenseNumber, l.licenseType])).toEqual([["lic_1", "C11-0000482-LIC", "DISTRIBUTION"], ["lic_2", "CCL19-0003371", "CULTIVATION"]]);
  });

  test("answers an unknown id with null and refuses another kind of id", () => {
    const { call, error } = bench();
    expect(call("get-company", { id: "com_999" }).company).toBeNull();
    expect(error("get-company", { id: "con_1" })).toContain("tool_error");
    expect(error("get-company", {})).toContain("invalid_arguments");
  });
});

describe("search-contacts", () => {
  test("companyIds gives a company's contacts with title, email and owner", () => {
    const { call, world } = bench();
    const sunset = company(world, "Sunset Dispensary");
    const r = call("search-contacts", { companyIds: [sunset.id], sortBy: { field: "FULL_NAME", direction: "ASC" } });
    expect(r.items.map((k: any) => [k.firstName, k.title, k.email, k.company.name, k.owner.fullName])).toEqual([
      ["Dana", "Accounts Payable", "dana.whitlock@sunsetdispensary.example", "Sunset Dispensary", "Daniel Reyes"],
      ["Marcus", "Buyer", "marcus.bell@sunsetdispensary.example", "Sunset Dispensary", "Daniel Reyes"],
    ]);
  });

  test("search matches name, company and email, closest first, with typos on names", () => {
    const { call } = bench();
    const names = (search: string) => call("search-contacts", { search, limit: 100 }).items.map((k: any) => `${k.firstName} ${k.lastName}`);
    expect(names("marcus bell")).toEqual(["Marcus Bell"]);
    expect(names("sunset")).toEqual(["Marcus Bell", "Dana Whitlock", "Irene Castillo", "Paul Dunn"]);
    expect(names("dana.whitlock@")).toEqual(["Dana Whitlock"]);
    expect(names("marcos bell")).toEqual(["Marcus Bell"]);
  });

  test("pages, sorts and filters by ids", () => {
    const { call, world } = bench();
    const first = call("search-contacts", { limit: 20 });
    expect(first.totalCount).toBe(world.contacts.length);
    const next = call("search-contacts", { limit: 20, cursor: first.nextCursor });
    expect(new Set([...first.items, ...next.items].map((k: any) => k.id)).size).toBe(world.contacts.length);
    expect(call("search-contacts", { ids: ["con_14", "15"] }).items.map((k: any) => k.id).sort()).toEqual(["con_14", "con_15"]);
    expect(call("search-contacts", { sortBy: { field: "INSERTED_AT", direction: "ASC" }, limit: 1 }).items[0].firstName).toBe("Caleb");
    expect(call("search-contacts", { sortBy: { field: "UPDATED_AT", direction: "DESC" }, limit: 1 }).items[0].updatedAt).toBeDefined();
  });

  test("refuses what it should", () => {
    const { error } = bench();
    expect(error("search-contacts", { companyIds: ["con_1"] })).toContain("tool_error");
    expect(error("search-contacts", { customFields: [{ customFieldId: "cf_1", contains: "x" }] })).toContain("unsupported_input");
  });
});

describe("mutate-company-contact", () => {
  test("CREATE adds Jane Lee, purchasing manager, at Sunset Dispensary", () => {
    const { call, world } = bench();
    const sunset = company(world, "Sunset Dispensary");
    const before = { contacts: world.contacts.length, actions: world.actions.length };
    const r = call("mutate-company-contact", { action: "CREATE", companyId: sunset.id, firstName: "Jane", lastName: "Lee", title: "Purchasing Manager" });
    expect(r.contact).toMatchObject({ id: "con_32", firstName: "Jane", lastName: "Lee", title: "Purchasing Manager", email: null, owner: null });
    expect(world.contacts).toHaveLength(before.contacts + 1);
    expect(world.contacts.at(-1)).toEqual({ id: "con_32", companyId: sunset.id, firstName: "Jane", lastName: "Lee", title: "Purchasing Manager", email: null, phone: null, ownerId: null, createdAt: NOW });
    expect(world.actions).toHaveLength(before.actions + 1);
    // A contact is a line of its company, so the change shows in the company's history.
    expect(world.actions.at(-1)!.records[0]).toMatchObject({ type: "COMPANY", id: sunset.id, name: "Sunset Dispensary", entity: "CONTACT", rowId: "con_32", rowLabel: "Jane Lee", op: "INSERT" });
    expect(world.actions.at(-1)!.records[0]!.fields.map((f) => f.field)).toEqual(["firstName", "lastName", "title"]);
    const listed = call("get-company", { id: sunset.id, includeContacts: true }).company.contacts.map((k: any) => k.firstName);
    expect(listed).toEqual(["Marcus", "Dana", "Jane"]);
  });

  test("CREATE takes the optional fields and the signed-in company", () => {
    const { call } = bench();
    const r = call("mutate-company-contact", { action: "CREATE", companyId: "com_0", firstName: "Ana", email: "ana@tidewatercannabis.example", phone: "(415) 555-0100", ownerId: "usr_3" });
    expect(r.contact).toMatchObject({ firstName: "Ana", email: "ana@tidewatercannabis.example", phone: "(415) 555-0100", owner: { id: "usr_3", fullName: "Priya Nair" } });
    expect(call("search-contacts", { companyIds: ["com_0"] }).items[0].company).toEqual({ id: "com_0", name: "Tidewater Cannabis Co." });
  });

  test("UPDATE changes only the fields sent, and null clears", () => {
    const { call, world } = bench();
    const r = call("mutate-company-contact", { action: "UPDATE", id: "con_14", email: "m.bell@sunsetdispensary.example", title: null }).contact;
    expect(r).toMatchObject({ firstName: "Marcus", lastName: "Bell", email: "m.bell@sunsetdispensary.example", title: null, owner: { fullName: "Daniel Reyes" } });
    expect(world.actions.at(-1)!.records[0]!.fields).toEqual([
      { field: "title", label: "Title", oldValue: "Buyer", newValue: null },
      { field: "email", label: "Email", oldValue: "marcus.bell@sunsetdispensary.example", newValue: "m.bell@sunsetdispensary.example" },
    ]);
    expect(call("search-contacts", { sortBy: { field: "UPDATED_AT", direction: "DESC" }, limit: 1 }).items[0]).toMatchObject({ id: "con_14", updatedAt: NOW });
  });

  test("DELETE removes the contact and returns its id", () => {
    const { call, world } = bench();
    expect(call("mutate-company-contact", { action: "DELETE", id: "con_15" })).toEqual({ id: "con_15" });
    expect(world.contacts.find((k) => k.id === "con_15")).toBeUndefined();
    expect(world.actions.at(-1)!.records[0]).toMatchObject({ type: "COMPANY", entity: "CONTACT", rowId: "con_15", op: "DELETE" });
  });

  test("refuses what its page requires, and leaves the world untouched", () => {
    const { error, world } = bench();
    const before = JSON.stringify(world);
    expect(error("mutate-company-contact", { action: "CREATE", firstName: "Jane" })).toContain("companyId");
    expect(error("mutate-company-contact", { action: "CREATE", companyId: "com_11" })).toContain("firstName");
    expect(error("mutate-company-contact", { action: "CREATE", companyId: "com_11", firstName: "  " })).toContain("blank");
    expect(error("mutate-company-contact", { action: "CREATE", companyId: "com_999", firstName: "Jane" })).toContain("No company");
    expect(error("mutate-company-contact", { action: "CREATE", companyId: "com_11", firstName: "Jane", ownerId: "usr_99" })).toContain("No user");
    expect(error("mutate-company-contact", { action: "UPDATE", title: "Buyer" })).toContain("id");
    expect(error("mutate-company-contact", { action: "UPDATE", id: "con_999", title: "Buyer" })).toContain("No contact");
    expect(error("mutate-company-contact", { action: "UPDATE", id: "con_14", companyId: "com_21" })).toContain("cannot change");
    expect(error("mutate-company-contact", { action: "DELETE" })).toContain("id");
    expect(error("mutate-company-contact", { action: "CREATE", companyId: "com_11", firstName: "Jane", workPhone: "1" })).toContain("unsupported_input");
    expect(error("mutate-company-contact", { action: "RENAME" })).toContain("invalid_arguments");
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("search-tasks", () => {
  test("my overdue tasks: three active ones due before now", () => {
    const { call, world } = bench();
    const r = call("search-tasks", { ownerIds: [world.me], statuses: ["ACTIVE"], dueDateBefore: NOW, sortBy: { field: "DUE_DATE", direction: "ASC" } });
    expect(r.items.map((t: any) => t.name)).toEqual(["Review the wholesale price list", "Call Sunset Dispensary about the late payment", "Reconcile Metrc package counts"]);
    expect(r.items[1]).toMatchObject({ relatedType: "COMPANY", company: { name: "Sunset Dispensary" }, owner: { profile: { fullName: "Maya Okafor" } }, salesOrder: null });
    // Due later today is not overdue yet; a whole-day bound for today would include it.
    expect(call("search-tasks", { ownerIds: [world.me], statuses: ["ACTIVE"], dueDateBefore: TODAY }).totalCount).toBe(4);
    expect(call("search-tasks", { ownerIds: [world.me], statuses: ["COMPLETED"] }).items.map((t: any) => t.name)).toEqual(["Send monthly statements"]);
    expect(call("search-tasks", { statuses: ["ACTIVE"], dueDateBefore: NOW }).totalCount).toBe(5);
  });

  test("pages, searches, sorts and filters by due date and ids", () => {
    const { call } = bench();
    const first = call("search-tasks");
    expect(first).toMatchObject({ totalCount: 10, hasMore: false });
    const page1 = call("search-tasks", { limit: 6 });
    expect(call("search-tasks", { limit: 6, cursor: page1.nextCursor }).items).toHaveLength(4);
    expect(call("search-tasks", { search: "metrc" }).items.map((t: any) => t.name)).toEqual(["Reconcile Metrc package counts"]);
    expect(call("search-tasks", { dueDateAfter: "2026-11-24" }).totalCount).toBe(2);
    expect(call("search-tasks", { ids: ["tsk_1", "2"] }).totalCount).toBe(2);
    expect(call("search-tasks", { sortBy: { field: "NAME", direction: "ASC" }, limit: 1 }).items[0].name).toBe("Approve this week's purchase orders");
    expect(call("search-tasks", { sortBy: { field: "INSERTED_AT", direction: "DESC" }, limit: 1 }).items[0].name).toBe("Renew the distribution license paperwork");
    expect(call("search-tasks", { sortBy: { field: "UPDATED_AT", direction: "ASC" }, limit: 1 }).items[0].name).toBe("Send monthly statements");
  });

  test("filters by linked record", () => {
    const { call, world } = bench();
    const sunset = company(world, "Sunset Dispensary");
    expect(call("search-tasks", { companyIds: [sunset.id] }).items.map((t: any) => t.name)).toEqual(["Call Sunset Dispensary about the late payment"]);
    expect(call("search-tasks", { relatedTypes: ["COMPANY"] }).totalCount).toBe(2);
    for (const filter of ["salesOrderIds", "purchaseOrderIds", "invoiceIds", "productIds"]) {
      const prefix = { salesOrderIds: "so", purchaseOrderIds: "po", invoiceIds: "inv", productIds: "prd" }[filter];
      expect(call("search-tasks", { [filter]: [`${prefix}_1`] }).totalCount).toBe(0);
    }
  });

  test("refuses what it should", () => {
    const { error } = bench();
    expect(error("search-tasks", { companyIds: ["com_1"], productIds: ["prd_1"] })).toContain("at most one");
    expect(error("search-tasks", { companyIds: ["com_1"], relatedTypes: ["COMPANY"] })).toContain("cannot be combined");
    expect(error("search-tasks", { ownerIds: ["com_1"] })).toContain("tool_error");
    expect(error("search-tasks", { contactIds: ["con_1"] })).toContain("unsupported_input");
    expect(error("search-tasks", { statuses: ["OPEN"] })).toContain("invalid_arguments");
  });
});
