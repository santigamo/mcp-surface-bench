# The ERP suite

A made-up cannabis distributor and grower in California, Tidewater Cannabis Co., with about a year of sales,
purchasing, inventory, compliance and cultivation history. The benchmark serves the vendor's documented tools
(Distru's MCP server, 114 tools, specified by the pages in `vendor/`); this suite is the data behind them, the
handlers that answer 63 of them, and 25 tasks graded without a model.

This page is for judging whether the suite is fair: what the world holds, how a handler must behave, how each
task is graded, what each task tests, and what the world leaves out.

## Files

| File | What it holds |
| --- | --- |
| `world.ts` | The `World` type, and every value derived from the data that tools and graders share: stock (`activeQuantity`, `availableQuantity`, `batchStock`, `incomingQuantity`, `passedTestingQuantity`), money (`orderTotal`, `invoiceMoney`, `orderMoney`, `purchaseMoney`), when a record last changed (`lastChanged`), whether a plant group is active |
| `seed.ts` | `createWorld(today)`: the whole company as of a day, and `clock(today)`, the instant of a run |
| `tools/<area>.ts` | The handlers of one area, exported as `tools`. No area file imports another |
| `tools/shared.ts` | What several areas render the same way: users, lookups by id, products and the product filters, custom fields, record URLs, and `recordAction`, which logs a write |
| `grading.ts` | The text matching graders are built from: names, numbers, dates, and the rule for negative checks |
| `tasks.ts` | The 25 tasks, how each is graded, and `preflight`, which says when a day's world cannot grade them fairly |
| `index.ts` | Puts the suite together |
| `src/core/kit.ts` | Conventions that are not about this company: ids, paging (`page`, `report`), sorting, dates and the reports' default range, list and status filters, and the one text search (`matches`, `closeness`, `ranked`, `like`) |

## The world

`createWorld(today)` builds the company from the day and a fixed random seed: the same day always gives the same
world, and every relative fact ("yesterday", "last quarter", "this year") has data on any day. A run happens at
10:00 company time (`America/Los_Angeles`). On 2026-11-23 the world holds 5 users, 2 licenses (distribution and
cultivation) with 6 locations, 39 products (1 inactive), 18 customers and 6 vendors with 31 contacts, 104 sales orders with 100 invoices, 28 purchase orders, 4 menus,
23 Metrc packages, 12 Metrc activities, 3 manifests, 35 plants in 5 groups, 8 harvests and 14 logged actions.

Facts a task asks for are placed by hand (the four sold-out products, the failed adjustment, PO-1182, SO-1042's
price change); the rest is generated around them. Totals a task ranks or compares are planned so that they are
far enough apart to grade: customer revenue last quarter (`customerPlan`) and what each vendor was ordered this year
(`vendorPlan`, at least 5% apart once the hand-placed purchase orders are counted).

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
   text the model reads. Where the page says how an input behaves (a default, what a filter matches, what is
   refused, how a search ranks), the handler does that, and no more: a search the page calls a substring is not
   made fuzzy.
2. **The result matches the documented shape exactly.** Tests call handlers through a runtime that refuses a result
   with a missing `Always` field, a wrong type or a field the page does not list. When a tool documents several
   result shapes, the handler returns the one the arguments select.
3. **`supports` is a promise.** Every input listed there is honoured as documented. A documented input left out is
   refused by the runtime with a clear message (`unsupported_input`), which is honest but costs the model a turn.
   Handlers support every input a sensible agent would reach for on the tasks, and leave out only what the world
   has no data for (custom-field filters, QuickBooks and LeafLink fields, and the like). A tool with no handler
   is listed to the model like any other and answers `unimplemented`.
4. **Data comes from the world, through one definition.** A value derived from the data comes from `world.ts`, never
   recomputed; a value several tools render the same way comes from `tools/shared.ts`; a convention comes from
   `src/core/kit.ts`. A documented field the world has no data for gets a fixed, plausible value (`null` where the
   field can be null, otherwise an empty list, `"0"`, `false`), with a comment saying so. No handler invents data
   that could change the answer to a task.
5. **Shared conventions.** Ids are accepted with or without their prefix and refused with a wrong one. Amounts and
   quantities are decimal strings where the page says `string`. Instants are printed as stored: ISO 8601 with the
   company's UTC offset. Search tools page with `limit` (10, at most 100) and an opaque `cursor`; report tools with
   `maxRowsLimit` (500, at most 5000) and `cursor`. A report with no date range covers the last 30 days, today
   included, and says so in `meta.dateRange`.
6. **Text search has one implementation.** `matches` is the case-insensitive substring most pages document.
   `closeness` and `ranked` are for the pages that promise ranking by similarity or a fuzzy match: a substring
   match scores the characters the field has beyond the term (exact first, then the shortest containing value),
   and a field the page calls fuzzy also matches word by word within one typo per four letters, after every
   substring match. `tiers` ranks one kind of match after another ("label matches first, then product names").
7. **Errors are `ToolError`s in plain words**, written as the real server would word them: what was wrong and what
   to send instead.
8. **A write changes the world in place and calls `recordAction` once**, with one row per record or line it wrote.
   A row names the record whose history it belongs to (`type`, `id`, of the documented record types) and what the
   row is (`entity`, with `rowId` when the world has one): a purchase payment is a `PURCHASE_PAYMENT` line of its
   `PURCHASE`, a contact a `CONTACT` line of its `COMPANY`, a tag on a product a `PRODUCT_TAG` line of the `PRODUCT`.
   A write checks what the page says it checks before changing anything, so a refused call leaves the world as it
   was.
9. **Sort fields are the documented ones.** Every value of the tool's `sortBy.field` enum that the world can order
   by is mapped; the default order is the one the page gives.

## Tests

`test/helpers.ts` gives a fresh world and a strict runtime that checks every result against the documented shape:

```ts
const { call, error, world } = bench();          // a fresh world and a strict runtime
call("search-users", { search: "reyes" });       // must succeed, result checked against the documented shape
error("search-users", { limit: 500 });           // must fail; returns "<outcome>: <message>"
```

- `test/erp.<area>.test.ts`: each handler with no arguments (or its required ones), with every input in `supports`,
  across a page boundary, and with the wrong input that should be refused. Behaviour a task depends on is asserted
  on the data, not just on the shape.
- `test/erp.grading.test.ts`: the matchers of `grading.ts`.
- `test/erp.tasks.test.ts`: for each task, a correct answer passes and wrong ones fail on the check they should;
  for each negative check, a careful answer that mentions a wrong item passes and one that includes it fails;
  `preflight` on every day of 2026 and 2027.
- `test/erp.flows.test.ts`: for each task, the tool calls a competent agent would make, through the strict runtime,
  ending in the task's own grader; both routes where a task has two (a report, or paging through a search).

## How tasks are graded

A task's grader returns named checks. A run passes when every required check passes. A check marked
`required: false` is informative: it is reported, but does not decide the run. It measures a quality the prompt
did not strictly ask for.

**Read tasks** are graded on the final answer, by deterministic text matching (no model), and on the world, which
must be exactly as it was. **Write tasks** are graded on the world after the run, compared with the world before:
what must have changed, and that nothing else did (`unchangedExcept`: the logged action and id counters aside);
the answer text is not read.

Every fact a grader expects is computed from the world the run started from, so the graders follow the day.

### Matching

- **Names** match whole, in any case, however the answer punctuates or spaces them, with a plural s: "Blue Dream
  3.5g" also matches "blue dream (3.5 g)", but never "Blue Dream 7g" or "Blue Dream 35g".
- **Document numbers** match with their prefix, another listed prefix, `#`, or bare ("INV-4484", "SO-4484",
  "#4484", "4484"), never inside an amount ("$4,484").
- **Metrc tags** match in full or by their last five or more characters; `preflight` makes sure no two tags a task
  can confuse share their last five.
- **Dates** match in the usual formats (2026-10-21, 10/21/2026, Oct 21, 21 October), with the right year if one is
  given.
- **Numbers** are read with their marks ($, %, k, kg, g, lb). A value counts only in a passage of its label: after
  the label up to the next label, or on the label's own line or table row. "Flower 35%, Pre-Rolls 45%" gives each
  its number; "Flower and Pre-Rolls: 35% and 45%" gives neither.
- **Tolerances**: THC 0.05 points; margin 1 point, or profit 1%; inventory value 0.5% (at unit price or unit cost);
  harvest weight 1% (grams, kilograms or pounds); vendor spend 1%; an invoice is "more than 30 days overdue" when
  its due instant is more than 30 × 24 hours before the run. `preflight` makes sure no two values a check must
  tell apart fall within its tolerance.

### Negative checks

A negative check ("names no product of the main menu that is in stock") fails an answer that presents a wrong
item as part of its answer. It passes an answer that mentions the item while saying it is not part of the answer:
"The other 14 products are in stock. The lowest are Blue Dream Cartridge 1g with 65 available and Blue Dream 3.5g
with 70" is a correct answer to "which products are sold out?".

The rule (`namesNone` in `grading.ts`): a wrong item counts as named when the answer mentions it at least once
without excusing it. What excuses a mention is the task's statement of why the item is left out (`excuse` in
`tasks.ts`), in two strengths:

- **an explicit statement**: "in stock", "overpaid", "outside the top ten", "not overdue", "under the threshold",
  "already imported", and on every task "not included", "excluded" and the like;
- **a plain fact that shows it**: "65 available", "$0 left", "on the Spring Menu", "this morning", another
  manifest's number, another user's name.

Where the mention is decides which one is needed. The part of the answer that gives the answer is the table, the
list, or the clause that also names a right item. A wrong item there is excused only by an explicit statement on
its own row or item ("| Blue Dream 7g | In stock |"). Anywhere else, in a remark, another list or a separate
clause, a fact is enough too. So "Sold out: Gelato 3.5g, Blue Dream 7g (65 available)" fails, and "Gelato 3.5g is
sold out. Blue Dream 7g has 65 available" passes.

What counts as the context of a mention:

- in a table row: the row, each cell read with its column header ("Imported: Yes", "Status: In stock");
- in a list item: the item's clause, plus the line that introduces the list ("**In stock, but running low**"),
  except in the answer's own list, where only the item counts;
- in prose: the clause (sentences split at `. ! ?`, clauses at `;`, a dash, or a comma before "but", "while",
  "though" and the like), plus the clauses and sentences after it on the same line that go on about it: those that
  open with a pronoun ("…, but it is only on the Spring Menu") or with "but" and no subject of their own ("…, but
  only on the Spring Menu", "…, but by users").

A statement does not count when it is negated just before it or denied just after it: "not in stock", "hasn't been
paid in full", "waiting to be imported" and "In stock: No" excuse nothing.

`test/erp.tasks.test.ts` proves the rule on every negative check: an answer worded as a careful assistant would word
it ("X is due later today, so it is not overdue", "Laurel Canyon Collective came 11th with $27,024", "INV-4488 is 27
days overdue, under the threshold", "PO-1176 is overpaid, not underpaid", and the run's answer quoted above)
passes; the same item put in the answer's list or table fails.

Known limits, each a consequence of matching text without a model:

- A statement in the same clause excuses an item even when it is about the others: "Besides Blue Dream 7g, everything
  is in stock" passes, though it says Blue Dream 7g is not in stock. (A heading such as "Sold out (everything else is
  in stock):" does not excuse the items of the answer's own list below it.)
- An explicit statement in the answer's own list excuses the item even when the list contradicts it: "Not paid in
  full: …, PO-1176 (overpaid)" passes. The answer says the right thing about the item, in the wrong place.
- A fact stated only in an earlier sentence about a group is not carried over: "The other 14 are in stock. The
  lowest are X (65) and Y (70)" fails for X and Y, since "(65)" says nothing by itself.
- Context is followed only forward and on the same line, and only into a clause that opens with a pronoun or a
  subjectless "but".
- The vocabulary is English and finite. An excuse worded in a way none of the task's phrases covers is not
  recognised, and the answer fails the check.

### Informative checks

- `orders-top-customers`: the ten customers are named in descending order of revenue (first mentions in order).
- `compliance-yesterday-adjustments`: the adjustments queued behind the failed one are mentioned.

### Preflight

`preflight(world)` lists what makes a day's world unable to grade the tasks fairly: a fact a task asks for that the
day does not have, a trap the seed places that is missing, or values a check could not tell apart. The runner
refuses to start on a day with problems. `test/erp.tasks.test.ts` runs it on every day of 2026 and 2027: it is clean
on all of them except January 1 to 20 of each year. In a year's first 20 days the seed places no regular purchase
orders (their payments would fall after the day of the run), so "this year" holds at most two vendors and
`purchasing-vendor-spend` has nothing to compare.

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

### What each task tests

For each task: the reading fixed in advance where the prompt is ambiguous, what is graded, and the traps the seed
places, with why they are there. "Last quarter" and "last month" are the previous calendar quarter and month;
"this year" is the calendar year; "yesterday" and "today" are days in company time.

**`catalog-lab-dropdown`** (write). Graded: exactly one custom field added, for `PACKAGE`, named Lab, a `DROPDOWN`,
with exactly the options SC Labs and Steep Hill; nothing else changed. Trap: packages already have a dropdown
(Storage zone); adding the options to it fails.

**`catalog-tag-prerolls`** (write). Reading: every active product in the Pre-Rolls category; tagging the
discontinued one as well is allowed. Graded: each active pre-roll carries Summer promo, keeps the tags it had, gets
no other tag, and no other product changes. Traps: some pre-rolls already carry other tags, and one already carries
Summer promo; `bulk-update-products` `tagIds` replaces the whole list, `addTagIds` keeps it.

**`commerce-main-menu-sold-out`** (read). Reading: "sold out" is what the menu shows as sold out, available quantity
(on hand minus what open orders hold) at or below zero. Graded: names the four; names no other product of the
Main Wholesale Menu; names no product sold out only on another menu. Traps: Blue Dream Cartridge 1g has 110 on hand
but 45 held by open orders (65 available, not sold out); Jack Herer 14g is sold out but only on the Spring Menu.

**`commerce-spring-flower-thc`** (read). Reading: the products of the Spring Menu in the FLOWER category, and the THC
the menu shows (the product's total THC; a fraction such as 0.246 is accepted). Graded: each one's THC next to its
name, within 0.05 points. Trap: other Blue Dream and Wedding Cake products with close names and their own THC.

**`commerce-bay-area-ordering`** (write). Reading: the tools have no single ordering switch; deactivating the menu,
turning off partner orders, or hiding prices from everyone each stops buyers ordering, and each is accepted (the
detail says which was taken). Graded: one of those changed on the Bay Area Menu, nothing else on it, no other menu
or record. Trap: hiding prices only from visitors leaves ordering on.

**`compliance-unimported-packages`** (read). Reading: Metrc packages with import status UNIMPORTED, on either license.
Graded: every one named (full tag or last five); none that is imported. Trap: `search-metrc-packages` takes one
license at a time, and two of the five are on the cultivation license.

**`compliance-yesterday-adjustments`** (read). The documented queue: a license's activities sync one at a time and a
failed one holds back every later one. The day before yesterday everything completed; yesterday two adjustments and
other changes completed, then an adjustment failed at 14:05, and what was queued after it (another adjustment and a
move yesterday, an adjustment this morning) is QUEUED. Graded: the answer reports the failure by its package (full
tag or last five) or by four consecutive words of its error after the preamble every Metrc rejection shares
("Metrc rejected the adjustment:"); the word "no" alone is not enough. Informative: mentions the queued adjustment.

**`compliance-manifest-packages`** (read). Graded: every package of manifest 0001234567; none of another manifest.
Traps: a second incoming manifest arriving the day after, and an outgoing one.

**`costing-inventory-value`** (read). Reading: the active stock of active products, valued at unit price or at unit
cost; either is accepted (the detail says which matched), within 0.5%. Trap: the discontinued product still has
stock, and counting it misses the figure.

**`costing-category-margin`** (read). Reading: lines of COMPLETED orders dated last quarter, per category; margin as a
percentage (1 point) or gross profit (1%) both answer it. Trap: a canceled order in the quarter.

**`cultivation-plants-in-veg`** (read). Graded: the plants with status VEGETATIVE, by their tags, or by their groups
together with the count; no group without plants in veg. Trap: OG Kush Run 3 is in the Veg Room but its plants are
immature.

**`cultivation-harvest-by-strain`** (read). Reading: the wet weight of the harvests dated last month, summed per
strain, within 1%. Graded: each such strain's weight next to it; no weight for a strain harvested only in other
months unless the answer says it was another month. Traps: a harvest twelve days before the month, and harvests in
the current month (once the month is four days old), one of a strain also harvested last month.

**`directory-sunset-rep-buyer`** (read). Reading: the sales rep is the company's owner; the buyer is its contact titled
Buyer. Graded: the rep's name; the buyer's email; neither of Sunset Wellness Collective's. Traps: Sunset Wellness
Collective, with its own rep and buyer; Sunset Dispensary's accounts payable contact.

**`directory-my-overdue-tasks`** (read). Reading: tasks owned by the signed-in user, ACTIVE, due before the run.
Graded: names every one (by its first four words); none of the user's that is done or not yet due; none of another
user's. Traps: a task due at 17:00 today (not yet overdue at 10:00), a completed one, future ones, and colleagues'
overdue tasks.

**`directory-add-contact`** (write). Graded: one contact, Jane Lee, title "purchasing manager" (any case), at Sunset
Dispensary; nothing else. Trap: Sunset Wellness Collective.

**`history-price-change-so-1042`** (read). Graded: who changed the price (Priya Nair), the day of the change, and no
sentence that ties the price change to anyone else. Trap: the order's creation and four other changes by three
other people (the quantity on the same line, the status twice, the due date); "Daniel Reyes changed the quantity,
not the price" is allowed.

**`history-public-api-yesterday`** (read). Reading: actions with source PUBLIC_API on yesterday's calendar day, and the
records they wrote. Graded: names each; names no record the public API changed only on another day; names no record
only users changed yesterday. Traps: a price change at 18:22 two days ago and one at 08:02 today; yesterday's
changes by users, a low-stock alert through MCP and an order status in the web app.

**`inventory-below-minimum`** (read). Reading: available quantity (on hand minus reserved) below the low-stock alert.
Graded: names every one; none at or above its minimum or without one. Traps: Blue Dream Cartridge 1g is below its
minimum only once reserved units are taken off; Milk Chocolate Bar 100mg is low but has no minimum.

**`inventory-move-blue-dream`** (write). Graded: the Vault holds 20 fewer units of Blue Dream 3.5g and the Shipping
Room 20 more, its total is unchanged, one stock transfer of 20 units from the Vault to the Shipping Room is
recorded, and no other stock changes. Traps: the product is batch-tracked, so `move-stock` needs its batch; Blue
Dream 7g is a different, package-tracked product.

**`orders-overdue-invoices`** (read). Reading: invoices not voided with a balance left, due more than 30 days before
the run. Graded: lists every one, gives each one's sales rep (the invoice owner, read from the same row, line or
heading), and lists no invoice 30 days overdue or less, paid or voided. Traps: invoices 27 and 12 days overdue, a
voided one 60 days past due, paid invoices long past their due date; `preflight` keeps every invoice at least a day
away from the 30-day line.

**`orders-top-customers`** (read). Reading: revenue is the total of non-canceled sales orders dated in the quarter.
Graded: names the ten; names no other customer. Informative: in descending order. Traps: an $85,000 order placed six
days before the quarter, and a canceled $60,000 order inside it, each of which would change the ten if counted;
`preflight` keeps the 10th at least 3% above the 11th.

**`orders-email-invoice`** (write). Reading: the invoice of SO-4512, emailed to the customer's contact titled Buyer.
Graded: exactly one email, the INVOICE document of that invoice, to that address only. Trap: the customer's accounts
payable contact; the order slip is the wrong document.

**`purchasing-vendor-spend`** (read). Reading: what was ordered from each vendor (purchase order totals) on orders
dated this year, within 1%. Graded: each vendor's total next to its name, the name first. Traps: purchase orders of
late last year; payments, which differ from what was ordered on the partly paid, overpaid and unpaid orders.

**`purchasing-unpaid-pos`** (read). Reading: payment status NOT_PAID or PARTIALLY_PAID; an overpaid order is paid in
full. Graded: lists every one; none paid in full. Traps: an overpaid order, partly paid ones.

**`purchasing-record-payment`** (write). Graded: exactly one purchase payment of $2,500, against PO-1182, not voided,
with an existing payment method; nothing else. Trap: the neighbouring purchase orders, and a required payment
method the prompt does not name (any is accepted).

## What the world does not model

Documented behaviour the world leaves out. Where a page documents a field for it, the field carries a fixed value
(`null`, `[]`, `"0"`, `false`) and a comment in the handler says so.

- **Tools.** 51 of the 114 tools have no handler and answer `unimplemented`: invoices and invoice payments, voiding
  payments, custom field edits, sales and purchase order edits, tasks, companies, licenses and locations, batch and
  package edits, inventory adjustments and costs, Metrc imports,
  package moves and splits, assemblies, teardowns, returns, credits, QuickBooks, lab test results, Metrc items and
  tags, the inventory and cultivation transaction reports, harvest outputs, order fulfillment and the plant
  lifecycle report. None of the 25 tasks needs one.
- **Money.** No taxes, charges, discounts, price tiers, credits or returns: order totals are the sum of their lines.
  No partial receipts of purchase orders: an order that is not COMPLETED counts as incoming in full.
- **Stock.** No assemblies, bills of materials, bins, expirations or harvest dates on stock; one cost per product
  (actual and default costs are the same figure); no cost entries, so cost breakdowns are null; packages are never
  hidden in Distru, and none is a sample.
- **Compliance.** Metrc item and room ids are numbered by the world; activities keep one attempt each; no package is
  ignored for import; manifests are never voided, matched to orders, or partly accepted; counterparties' license
  dates are a placeholder (the end of next year).
- **Cultivation.** No teardowns, weighings, costs, destruction dates, or Metrc ids for plants and harvests.
- **Records.** No custom field values: every record lists the fields defined for its type, each unset. No
  addresses beyond a counterparty's city and zip, and none for rooms. No images, menu collections, selling by
  potency, notes in record history, or record-only orders. Users carry no timestamps, so the order they were added
  in stands in for both.
- **Access.** One signed-in user, an admin: no permissions, teams, linked accounts or `account` input; rate limits
  are not enforced.
