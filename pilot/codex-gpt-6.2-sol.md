# Pilot: Codex CLI, gpt-6.2-sol, effort medium

75 finished runs on 2026-11-23 (the machine's date: these runs were started before the runner set the clients' timezone, so the clients were told the machine's date, and Codex its timezone, rather than the company's): 1 rep(s) of each task on each arm, the arms in a random order in each (task, rep) block, seed 69472687. Commit d401f2c531. Catalog: 114 tools from https://docs.distru.com.

- Client codex codex-cli 0.167.0: **gpt-6.2-sol** in 75 runs (as requested; the client does not report it); asked for gpt-6.2-sol. Effort **medium** in 75 runs (as requested; the client does not report it); asked for medium.

**Regraded** 1 time, last on 2026-11-23 12:20 UTC at commit d401f2c531 (uncommitted changes): 2 of 75 verdicts changed (2 statuses). Each run that changed keeps its earlier verdicts in its result.json.

Each figure is followed by the number of runs behind it in brackets. With a handful of runs a median moves with a single run: read differences between arms as indications, not measurements.

## Arms

| Arm | Surface | Tool search | Client setting |
| --- | --- | --- | --- |
| direct | direct | off | MCP tools registered directly (omit_tools_from code_mode and deferred) |
| direct+search | direct | on | MCP tools deferred inside Codex's code mode (its default) |
| code | code | off | MCP tools registered directly (omit_tools_from code_mode and deferred) |

## Summary

| Arm | Runs | Passed | Asked | Failed | Server calls, median | Server calls, mean | Model tool calls, median | Context processed, median | Output tokens, median | Wall time, median | Cost, median | Tool listing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| direct | 25 | 24/25 | 1/25 | 0/25 | 3 [25] | 3.6 [25] | 3 [25] | 370k [25] | 427 [25] | 22 s [25] | – | 114 tools, 381k bytes (≈95k tokens at 4 bytes each) |
| direct+search | 25 | 23/25 | 1/25 | 1/25 | 2 [25] | 2.8 [25] | 2 [25] | 103k [25] | 413 [25] | 20 s [25] | – | 114 tools, 381k bytes (≈95k tokens at 4 bytes each) |
| code | 25 | 25/25 | 0/25 | 0/25 | 2 [25] | 3.0 [25] | 4 [25] | 64k [25] | 528 [25] | 22 s [25] | – | 2 tools, 1.7k bytes (≈419 tokens at 4 bytes each) |

Each graded run has one of three outcomes. **Passed**: its required checks passed. **Asked**: it failed them having left the world unchanged, and its answer puts a question to the user (a choice, or something it needed); in a headless run nobody answers, so the run ended there. An answer that only offers more ("Want me to…?") does not count as asking, and a run that passed is a pass whatever it asks. **Failed**: any other graded run (a failed check, a timeout or a client error). The runs that asked are listed with their question below, apart from the failed ones.

Server calls are the calls the mock answered, from its trace: on `code` each `api.*` call inside an execute counts. Model tool calls are the calls the model itself made, the client's tool searches included. Context processed is input + cache read + cache creation + output tokens, summed over the run's requests; its parts are in their own section below. The listing size is approximate; the model sees the tools as the client wraps them.

Cost is the client's estimate (on a subscription, not a charge), shown only for an arm where every run reported one. It depends on cache warmth: a run that follows another of the same arm within the cache's lifetime reads the prompt prefix that run wrote instead of writing it again, so an arm's cost depends on the order its runs happened to fall in, not only on the arm. Compare context processed, which does not.

## What the model started with

- **direct**: 125 tools at start, 114 of them the server's; the client does not report its first request's size, so whether tool definitions were in it is not in the data.
- **direct+search**: 11 tools at start, none of them the server's; the client does not report its first request's size, so whether tool definitions were in it is not in the data.
- **code**: 13 tools at start, 2 of them the server's; the client does not report its first request's size, so whether tool definitions were in it is not in the data.

| Arm | Tools at start, median | Server tools at start, median | First request's context, median | Tools from outside the server |
| --- | --- | --- | --- | --- |
| direct | 125 [25] | 114 [25] | – | collaboration.followup_task, collaboration.interrupt_agent, collaboration.list_agents, collaboration.send_message, collaboration.spawn_agent, collaboration.wait_agent, functions.exec, functions.request_user_input, functions.request_user_input_async, functions.send_message_to_user_async, functions.wait |
| direct+search | 11 [25] | 0 [25] | – | collaboration.followup_task, collaboration.interrupt_agent, collaboration.list_agents, collaboration.send_message, collaboration.spawn_agent, collaboration.wait_agent, functions.exec, functions.request_user_input, functions.request_user_input_async, functions.send_message_to_user_async, functions.wait |
| code | 13 [25] | 2 [25] | – | collaboration.followup_task, collaboration.interrupt_agent, collaboration.list_agents, collaboration.send_message, collaboration.spawn_agent, collaboration.wait_agent, functions.exec, functions.request_user_input, functions.request_user_input_async, functions.send_message_to_user_async, functions.wait |

From the runs, not from the options: the tools the client said the model had, and the prompt tokens of its first request. Tool definitions the first request does not hold were deferred by the client.

## Context processed, by kind

| Arm | Uncached input, median | Cache creation, median | Cache read, median | Output, median | Context processed, median | Cache read, share of the arm's total |
| --- | --- | --- | --- | --- | --- | --- |
| direct | 75k [25] | 0 [25] | 294k [25] | 427 [25] | 370k [25] | 84% |
| direct+search | 34k [25] | 0 [25] | 74k [25] | 413 [25] | 103k [25] | 70% |
| code | 19k [25] | 0 [25] | 48k [25] | 528 [25] | 64k [25] | 72% |

Cache creation is context written to the cache: sent once, on the request that first holds it. Cache read is context already cached and read again by every later request of the run, so it grows with the number of turns times the size of what the model was given. Uncached input is the rest. The split between creation and read depends on cache warmth (an earlier run may have written the prefix); their sum does not. Medians of the parts need not add up to the median of the whole. Codex reports cached input but not cache writes.

## The client's tool search

| Arm | Runs that show it | Tool searches, median | Searches before the first server call, median | Server calls, median | Model tool calls, median |
| --- | --- | --- | --- | --- | --- |
| direct+search | 0/25 | – | – | 2 [25] | 2 [25] |

Tool searches are the model's calls to the client's own search for deferred tools, from the client's events; a client whose events do not show them has none counted. They are among the model tool calls and never reach the server.

## Outcomes by task

Runs passed of the runs graded, and how many asked when any did; the rest failed.

| Task | direct | direct+search | code |
| --- | --- | --- | --- |
| catalog-lab-dropdown | 1/1 | 1/1 | 1/1 |
| catalog-tag-prerolls | 1/1 | 1/1 | 1/1 |
| commerce-bay-area-ordering | 1/1 | 1/1 | 1/1 |
| commerce-main-menu-sold-out | 1/1 | 1/1 | 1/1 |
| commerce-spring-flower-thc | 1/1 | 1/1 | 1/1 |
| compliance-manifest-packages | 1/1 | 1/1 | 1/1 |
| compliance-unimported-packages | 1/1 | 1/1 | 1/1 |
| compliance-yesterday-adjustments | 1/1 | 1/1 | 1/1 |
| costing-category-margin | 1/1 | 1/1 | 1/1 |
| costing-inventory-value | 1/1 | 1/1 | 1/1 |
| cultivation-harvest-by-strain | 1/1 | 1/1 | 1/1 |
| cultivation-plants-in-veg | 1/1 | 1/1 | 1/1 |
| directory-add-contact | 1/1 | 1/1 | 1/1 |
| directory-my-overdue-tasks | 1/1 | 1/1 | 1/1 |
| directory-sunset-rep-buyer | 1/1 | 1/1 | 1/1 |
| history-price-change-so-1042 | 1/1 | 1/1 | 1/1 |
| history-public-api-yesterday | 1/1 | 0/1 | 1/1 |
| inventory-below-minimum | 1/1 | 1/1 | 1/1 |
| inventory-move-blue-dream | 1/1 | 1/1 | 1/1 |
| orders-email-invoice | 1/1 | 1/1 | 1/1 |
| orders-overdue-invoices | 1/1 | 1/1 | 1/1 |
| orders-top-customers | 1/1 | 1/1 | 1/1 |
| purchasing-record-payment | 0/1 (1 asked) | 0/1 (1 asked) | 1/1 |
| purchasing-unpaid-pos | 1/1 | 1/1 | 1/1 |
| purchasing-vendor-spend | 1/1 | 1/1 | 1/1 |

## Paired comparison

A description of these runs, not a significance test: with 1 rep per task, a single run can decide a task. For each pair of arms, over the tasks both finished (with a graded run on each), the arm that passed a larger share of its runs wins the task.

| Arm A | Arm B | Tasks both finished | Won by A | Won by B | Tied |
| --- | --- | --- | --- | --- | --- |
| direct | direct+search | 25 | 1 (history-public-api-yesterday) | 0 | 24 (purchasing-record-payment (direct asked, direct+search asked)) |
| direct | code | 25 | 0 | 1 (purchasing-record-payment (direct asked)) | 24 |
| direct+search | code | 25 | 0 | 2 (history-public-api-yesterday, purchasing-record-payment (direct+search asked)) | 23 |

A run that asked counts here as not passed, like a failed one: a task that one arm passed and the other asked on is won by the arm that passed, and a task neither passed is tied whether its runs asked or failed. Every task where an arm asked is marked with it, among the wins and among the ties, so a win over an ask can be told from a win over a failure.

## Runs that asked

Each stopped to put a question to the user, having changed nothing; the question is quoted from its answer.

- **purchasing-record-payment / direct #1** (regraded; was fail): "What payment method should I use for the $2,500 payment on PO-1182 to Humboldt Family Farms: ACH, check, or cash?"
  - checks it did not pass: records exactly one purchase payment; the payment is $2,500; it is against PO-1182; it is not voided and uses an existing payment method
- **purchasing-record-payment / direct+search #1** (regraded; was fail): "Which payment method was used for the $2,500 payment on PO-1182 to Humboldt Family Farms: ACH, check, or cash?"
  - checks it did not pass: records exactly one purchase payment; the payment is $2,500; it is against PO-1182; it is not voided and uses an existing payment method

## Failed runs

- **history-public-api-yesterday / direct+search #1**: fail
  - names no record the public API changed on another day: lists Jack Herer Cartridge 1g with the right items without saying that it happened on another day

## Informative checks

Checks a task reports without letting them decide the run (`required: false`): how often each passed, over the graded runs that carry it. They are not among the failures above.

| Task | Check | direct | direct+search | code |
| --- | --- | --- | --- | --- |
| compliance-yesterday-adjustments | mentions the adjustments still queued behind it | 1/1 | 1/1 | 1/1 |
| orders-top-customers | names the ten in descending order of revenue | 1/1 | 1/1 | 1/1 |

## What the mock could not serve

Every call reached a tool and inputs the mock implements.
