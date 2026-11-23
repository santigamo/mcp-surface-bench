# mcp-surface-bench

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/context-per-task-dark.svg">
  <img src="assets/context-per-task-light.svg" alt="Context an agent processes per task on a 114-tool MCP server, median over 25 tasks. Claude Code with Opus 5.5: 467k tokens with every tool upfront, 37k with tools deferred by the client, 26k in code mode. Codex with GPT-6.2 Sol: 370k, 103k and 64k.">
</picture>

A benchmark for one question: when an MCP server has many tools, what does each way of showing them to an
agent cost, and does the agent still get the work done?

It runs the same requests against the same tools and the same data, changing only what the model is shown:

| Arm | What the model is shown |
| --- | --- |
| `direct` | Every tool, with its full definition, from the first request. |
| `direct+search` | The same server, but the client holds the definitions back and the model searches for the tools it needs (Claude Code's tool search; Codex's default behaviour). |
| `code` | Two tools: one searches the server's functions and returns their signatures, the other runs JavaScript that calls them ("code mode"). |

## The server under test

The tools are those of [Distru's MCP server](https://docs.distru.com/mcp), an ERP for the cannabis industry:
114 tools, 38 of them writes. It was chosen because it is large and unusually well documented: every tool
has a public page with the description the model reads, every input and every output field.

This project is not affiliated with Distru and never connects to its server. `bun run catalog` reads the
public documentation and builds the tool list from it; the documentation itself is not redistributed here.
Behind the tools is a made-up company, generated for the day of the run, and handlers written from the
documentation. The tasks are the 25 example prompts in that documentation ("Try asking"), unedited.

## Pilot results

One run per task and arm on 2026-11-23: 75 runs per client. The full reports are in [`pilot/`](pilot).

**Claude Code 2.1.330, `claude-opus-5-5`, effort medium**

| | `direct` | `direct+search` | `code` |
| --- | --- | --- | --- |
| Context in the first request | 155k tokens | 5.3k | 3.2k |
| Context processed per task, median | 467k tokens | 37k | 26k |
| Wall time per task, median | 12 s | 16 s | 18 s |
| Passed / asked / failed, of 25 | 23 / 2 / 0 | 22 / 3 / 0 | 22 / 3 / 0 |

**Codex CLI 0.167.0, `gpt-6.2-sol`, effort medium**

| | `direct` | `direct+search` | `code` |
| --- | --- | --- | --- |
| Context processed per task, median | 370k tokens | 103k | 64k |
| Wall time per task, median | 22 s | 20 s | 22 s |
| Passed / asked / failed, of 25 | 24 / 1 / 0 | 23 / 1 / 1 | 25 / 0 / 0 |

"Context processed" is every token the model read or wrote over the run. "Asked" is a run that stopped to
put a question to the user and changed nothing: neither a pass nor a failure. Codex does not report the
size of its first request.

What these runs show:

1. **Holding the definitions back saves most of the context, and code mode saves more on top.** With every
   tool upfront, 98% of what Claude processed was the tool list, read again on each turn. Deferring it cut
   the median from 467k to 37k tokens; code mode brought it to 26k. Codex went from 370k to 103k and 64k.
2. **The arms got the work done about equally.** One run per task cannot separate them, and none of them
   failed a task on Claude. Codex's single failure comes from the pilot itself: the agent and the mock
   company were in different timezones, which the runner has since fixed.
3. **Two of the 25 example prompts cannot be completed as asked without a follow-up question.**
   "Turn off ordering on the Bay Area menu": there is no such switch. Claude laid out the two closest
   settings and asked which, in all three arms; Codex turned off partner orders, in all three.
   "Record a $2,500 payment against purchase order 1182": a payment method is required and the request names
   none. Five of the six runs asked for it; Codex in code mode used ACH, the method of the order's earlier
   payment.
4. **One thing to replicate.** "What did the public API change yesterday?" was answered by Claude with the
   tools upfront. In both arms where the definitions were held back, it read the question as being about
   changes to the API itself, found nothing and asked what was meant. With the definitions in view, the
   model also has the product in view. This is one run per arm.

What they do not show:

- Anything about pass rates beyond "about equal". That needs repetitions.
- The real server. The schemas are rebuilt from documentation tables, the data is invented, and 63 of the
  114 tools have a handler (the rest are listed, and refuse a call with a clear message; one call in 150 runs
  reached one).
- A production design for code mode. The `code` arm is this project's own, and it runs model-written code in
  `node:vm`, which is not a security boundary.

The graders use no model. They were corrected twice after reading the pilot's answers, because they failed
correct answers that added a helpful remark; the stored runs were then graded again, and each run keeps its
earlier verdicts. [`suites/erp/README.md`](suites/erp/README.md) states every task's rule, its traps and
the readings fixed in advance for the ambiguous prompts.

## How it is built

| Path | What it does |
| --- | --- |
| `src/catalog/` | Builds each tool's name, description and JSON Schema from the vendor's documentation. A test converts every schema back into the documented table to prove no field, type, enum value or required flag is lost. |
| `src/core/` | One runtime carries out every tool call, whatever the arm: it validates the arguments, calls the handler and writes a trace. The arms differ only in what they show the model. |
| `src/surfaces/` | The `direct` and `code` MCP servers. |
| `suites/erp/` | The company, the handlers, and the 25 tasks with their graders. |
| `src/bench/` | The runner and the report: drives Claude Code and Codex headless with the server's tools and nothing else, interleaves the arms, grades each run from the answer and from the data after the run, and can grade stored runs again without a model call. |

## Running it

Needs [Bun](https://bun.sh), and Claude Code or Codex signed in.

```sh
bun install
bun run catalog -- --docs https://docs.distru.com   # fetch the documentation, build the tool list
bun test

bun run bench -- --client claude --model claude-opus-5-5 --effort medium \
  --arms direct,direct+search,code --label my-run
bun run report -- --label my-run
bun run regrade -- --label my-run                   # after changing a grader
```

`--prompt "..."` runs one ungraded request on each arm, which is the quickest way to see the difference.
Real runs spend your subscription or API quota: the `direct` arm sends about 155k tokens on every turn.

## License

MIT
