# The ERP suite

A made-up cannabis distributor and grower in California, Tidewater Cannabis Co., with about a year of sales,
purchasing, inventory, compliance and cultivation history. The tools the benchmark serves are the vendor's
documented tools; this suite is the data behind them and the handlers that answer the calls.

## Files

| File | What it holds |
| --- | --- |
| `world.ts` | The `World` type, and the derived values (stock, totals, payment status) that tools and graders share |
| `seed.ts` | `createWorld(today)`: the whole company as of a day. Same day, same world |
| `tools/<area>.ts` | The handlers of one area, exported as `tools` |
| `tools/shared.ts` | What several areas need: user references, lookups by id, logging a write |
| `tasks.ts` | The 25 tasks and how each is graded |
| `index.ts` | Puts the suite together |

## How a handler is written

```ts
defineTool<World>({
  name: "search-users",                                   // the tool name without the vendor prefix
  supports: ["limit", "cursor", "ids", "search", "sortBy"], // the tool's own top-level inputs this handler honours
  run(args, { world, now }) { ... },                       // returns the documented result, or throws ToolError
})
```

`tools/session.ts` is the reference. The rules:

1. **The documentation page is the specification.** `vendor/tools/<name>.md` gives the inputs, the output and the
   text the model reads. Read all three before writing the handler. Where the page says how an input behaves
   (a default, what a filter matches, what is refused), the handler does that.
2. **The result matches the documented shape exactly.** Tests call handlers through a runtime that refuses a result
   with a missing `Always` field, a wrong type or a field the page does not list. When a tool documents several
   result shapes, return the one the arguments select.
3. **`supports` is a promise.** Every input listed there is honoured as documented. An input left out is refused
   by the runtime with a clear message when a call uses it, which is honest but costs the model a turn. So
   support every input a sensible agent would reach for on the tasks below (ids, search, status, dates, sort,
   paging, the `include…` switches) and leave out only what this world has no data for (custom-field filters,
   QuickBooks and LeafLink fields, and the like).
4. **Data comes from the world.** Quantities, totals and payment status come from the helpers in `world.ts`
   (`activeQuantity`, `availableQuantity`, `orderTotal`, `invoiceMoney`, `purchaseMoney`), never recomputed
   differently. A documented field the world has no data for gets a fixed, plausible value (`null` where the
   field can be null, otherwise an empty list, `"0"`, `false`), with a short comment when the choice is not
   obvious. Never invent data that could change the answer to a task.
5. **Shared conventions come from `src/core/kit.ts`.** Paging (`page`, `report`), sorting (`sorted`), date filters
   (`bound`, `within`), ids (`normalizeId`, `normalizeIds`), amounts (`money`, `qty`), text search (`matches`).
   Ids are accepted with or without their prefix and refused with a wrong one. Amounts and quantities are
   decimal strings where the page says `string`. Instants are printed as stored: ISO 8601 with the company's
   UTC offset.
6. **Errors are `ToolError`s in plain words**, written as the real server would word them: what was wrong and what
   to send instead.
7. **A write changes the world in place** and calls `recordAction` once. It checks what the page says it checks
   (a missing record, a quantity above stock, a duplicate name) before changing anything, so a refused call
   leaves the world untouched.
8. **Sort fields are the documented ones.** Map every value of the tool's `sortBy.field` enum that the world can
   order by; the default order is the one the page gives.

## Tests

One file per area, `test/erp.<area>.test.ts`, built on `test/helpers.ts`:

```ts
const { call, error, world } = bench();          // a fresh world and a strict runtime
call("search-users", { search: "reyes" });       // must succeed, result checked against the documented shape
error("search-users", { limit: 500 });           // must fail; returns "<outcome>: <message>"
```

Each handler is called with no arguments (or its required ones), with every input in `supports`, across a page
boundary when it pages, and with the wrong input that should be refused. Behaviour that a task depends on is
asserted on the data, not just on the shape.

## The tasks

The 25 example prompts from the vendor's documentation, one page per area, unedited.

| Area | Prompt |
| --- | --- |
| Catalog | Add a Lab dropdown to packages with the options SC Labs and Steep Hill. |
| Catalog | Tag every pre-roll as Summer promo. |
| Commerce | Which products on our main wholesale menu are sold out? |
| Commerce | What does the Spring menu show for THC on each flower product? |
| Commerce | Turn off ordering on the Bay Area menu. |
| Compliance | Which Metrc packages haven't been imported into Distru yet? |
| Compliance | Did yesterday's Metrc adjustments all go through? |
| Compliance | Show me the packages on incoming manifest 0001234567. |
| Costing | What is our inventory worth today? |
| Costing | What was our margin by product category last quarter? |
| Cultivation | Which plants are in veg right now? |
| Cultivation | How much did we harvest last month, by strain? |
| Directory | Who is the sales rep on Sunset Dispensary, and what's the buyer's email? |
| Directory | Which of my tasks are overdue? |
| Directory | Add Jane Lee, purchasing manager, as a contact at Sunset Dispensary. |
| History | Who changed the price on SO-1042, and when? |
| History | What did the public API change yesterday? |
| Inventory | Which products are below their minimum stock level? |
| Inventory | Move 20 units of Blue Dream 3.5g from the vault to the shipping room. |
| Orders | Which invoices are more than 30 days overdue, and who is the sales rep on each? |
| Orders | Who were our top 10 customers by revenue last quarter? |
| Orders | Email the invoice for order 4512 to the buyer. |
| Purchasing | How much did we spend with each vendor this year? |
| Purchasing | Which purchase orders haven't been paid in full? |
| Purchasing | Record a $2,500 payment against purchase order 1182. |
