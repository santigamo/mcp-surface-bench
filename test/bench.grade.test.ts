import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/core/tool.ts";
import { askedInstead, isOffer, questionOf } from "../src/bench/asked.ts";
import { failedChecks, runChecks, statusOf, verdictOf, worldAfter, worldChanged } from "../src/bench/grade.ts";

type W = { notes: string[] };
const createWorld = (today: string): W => ({ notes: [today] });

/** Asks for one note to be added and the new count to be stated. */
const addNote: Task<W> = {
  id: "add-note", prompt: "Add a note saying hi and tell me how many notes there are.", source: "test", kind: "write",
  grade: ({ answer, before, after }) => [
    { name: "one note added", pass: after.notes.length === before.notes.length + 1, detail: `${before.notes.length} -> ${after.notes.length}` },
    { name: "the note says hi", pass: after.notes.at(-1) === "hi" },
    { name: "answer gives the count", pass: answer.includes(String(after.notes.length)) },
  ],
};

test("grading: the world the run saved against the world it started from", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-grade-"));
  try {
    const before = createWorld("2026-11-23");
    expect(worldAfter(before, join(dir, "world.json"))).toEqual(before); // nothing written: untouched

    writeFileSync(join(dir, "world.json"), JSON.stringify({ notes: ["2026-11-23", "hi"] }));
    const after = worldAfter(before, join(dir, "world.json"));
    const good = runChecks(addNote, { answer: "Done: there are 2 notes.", before, after });
    expect(good.every((c) => c.pass)).toBe(true);
    expect(statusOf({ limitHit: false, timedOut: false, checks: good })).toBe("pass");

    const vague = runChecks(addNote, { answer: "Done.", before, after });
    expect(vague.filter((c) => !c.pass).map((c) => c.name)).toEqual(["answer gives the count"]);
    expect(statusOf({ limitHit: false, timedOut: false, checks: vague })).toBe("fail");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("grading: a grader that throws or checks nothing is a failed check, not a crash", () => {
  const throws: Task<W> = { ...addNote, grade: () => { throw new Error("boom"); } };
  const empty: Task<W> = { ...addNote, grade: () => [] };
  const run = { answer: "", before: { notes: [] }, after: { notes: [] } };
  expect(runChecks(throws, run)).toEqual([{ name: "grader", pass: false, detail: "the grader threw: boom" }]);
  expect(runChecks(empty, run)[0]!.pass).toBe(false);
});

test("status: limit, then timeout, then the checks; a client error fails only failing checks", () => {
  const pass = [{ name: "a", pass: true }], fail = [{ name: "a", pass: false }];
  expect(statusOf({ limitHit: true, timedOut: true, checks: pass })).toBe("limit");
  expect(statusOf({ limitHit: false, timedOut: true, checks: pass })).toBe("timeout");
  expect(statusOf({ limitHit: false, timedOut: false, error: "exit 1", checks: fail })).toBe("error");
  expect(statusOf({ limitHit: false, timedOut: false, error: "exit 1", checks: pass })).toBe("pass");
  expect(statusOf({ limitHit: false, timedOut: false, checks: null })).toBe("ungraded");
  expect(statusOf({ limitHit: false, timedOut: false, error: "no result event", checks: null })).toBe("error");
});

test("informative checks: reported, never deciding the run, and not part of the verdict", () => {
  const checks = [{ name: "right answer", pass: true }, { name: "ranked in order", pass: false, required: false }];
  expect(statusOf({ limitHit: false, timedOut: false, checks })).toBe("pass");
  expect(statusOf({ limitHit: false, timedOut: false, checks: [{ name: "a", pass: false }, { name: "b", pass: true, required: false }] })).toBe("fail");
  expect(statusOf({ limitHit: false, timedOut: false, error: "exit 1", checks })).toBe("pass");
  expect(failedChecks([...checks, { name: "said the count", pass: false, required: true }])).toEqual(["said the count"]);
});

test("informative checks: a task whose checks are all informative cannot pass a run", () => {
  const onlyInformative: Task<W> = { ...addNote, grade: () => [{ name: "polite", pass: true, required: false }] };
  const checks = runChecks(onlyInformative, { answer: "", before: { notes: [] }, after: { notes: [] } });
  expect(checks.at(-1)).toEqual({ name: "grader", pass: false, detail: "the task returned no required check" });
  expect(statusOf({ limitHit: false, timedOut: false, checks })).toBe("fail");
});

// ---------- asked: a run that put a question to the user instead of acting ----------

// The questions of the pilot runs that stopped to ask (results/opus-medium and results/codex-medium), as they end
// their answers, and the offers that end answers which did the work.
const ASKS = [
  "If you want ordering stopped completely, option 1 does that. Which would you like?",
  "Should I deactivate it? If you only want to block connected apps, I'll turn off partner orders instead.",
  "The menu can't stay viewable while blocking all orders. Hiding prices doesn't block orders either. Which one do you want: deactivate it (option 1), turn off partner orders only (option 2), or both?",
  "**Which payment method should I use: ACH, Check or Cash?** Also tell me if you want:\n- a payment date other than today\n- a note, such as a check number",
  "I found PO-1182, but I need one thing from you before I record the payment: **which payment method was used?**\n\n**About the PO**\n- Supplier: Humboldt Family Farms",
  "How was the $2,500 paid: **Cash, Check, or ACH**? If you don't say otherwise, I'll date it today and leave the note blank.",
  "What payment method should I use for the $2,500 payment on [PO-1182](https://app.distru.com/purchases/25) to Humboldt Family Farms: ACH, check, or cash? Distru requires a payment method.",
  "What \"public API\" do you mean?\n\n1. **Your own project's API:** point me to the repo, or paste the diff or changelog.",
  "- **Changes in your Distru data yesterday**: I can pull those from the transaction history reports.\n\nWhich did you mean?",
];
const OFFERS = [
  "Want me to import the Gelato and Sour Diesel packages using their suggested products?",
  "I can import any of these packages if you tell me which product to use for the three that aren't mapped yet.",
  "Times are Pacific, your company's timezone. Want me to mark any of these done or move their due dates?",
  "Would you like me to draft purchase orders to the three vendors?",
  "Do you want me to break this down by category?",
  "Should I tag the inactive ones too?",
  "If that helps, want the full list?",
  "Anything else?",
  "## Why did it fail?\nMetrc rejected it.",
  "> Which products are sold out?\n\nFour are.",
  "Run `git log --since=yesterday?` there, or see [the docs](https://example.com/a?b=1).",
];

test("asked: a question to the user, not an offer of more", () => {
  for (const answer of ASKS) expect(questionOf(answer), answer).not.toBeNull();
  for (const answer of OFFERS) expect(questionOf(answer), answer).toBeNull();
  expect(questionOf(ASKS[4]!)).toBe("I found PO-1182, but I need one thing from you before I record the payment: which payment method was used?");
  expect(questionOf(ASKS[6]!)).toBe("What payment method should I use for the $2,500 payment on PO-1182 to Humboldt Family Farms: ACH, check, or cash?");
  expect(isOffer("Which would you like me to do: deactivate it or close partner orders?")).toBe(false);
});

test("asked: only a run that changed nothing and did not pass its checks", () => {
  const failed = [{ name: "records the payment", pass: false }], passed = [{ name: "records the payment", pass: true }];
  const question = "Which payment method should I use: ACH, Check or Cash?";
  expect(askedInstead({ answer: question, checks: failed, worldChanged: false })).toBe(question);
  // It wrote something: whatever it asks, it acted.
  expect(askedInstead({ answer: question, checks: failed, worldChanged: true })).toBeNull();
  // It passed: a pass whatever it asks or offers.
  expect(askedInstead({ answer: question, checks: passed, worldChanged: false })).toBeNull();
  // A failed answer that ends with an offer did not ask for anything it needed.
  expect(askedInstead({ answer: `Five are unpaid. ${OFFERS[0]}`, checks: failed, worldChanged: false })).toBeNull();
  // An informative check that fails is not what the run was asked to do.
  expect(askedInstead({ answer: question, checks: [...passed, { name: "polite", pass: false, required: false }], worldChanged: false })).toBeNull();
});

test("asked: the status, after a pass and a client error, before a fail", () => {
  const failed = [{ name: "a", pass: false }];
  expect(statusOf({ limitHit: false, timedOut: false, checks: failed, question: "Which one?" })).toBe("asked");
  expect(statusOf({ limitHit: false, timedOut: false, checks: failed, question: null })).toBe("fail");
  expect(statusOf({ limitHit: false, timedOut: false, error: "exit 1", checks: failed, question: "Which one?" })).toBe("error");
  expect(statusOf({ limitHit: false, timedOut: true, checks: failed, question: "Which one?" })).toBe("timeout");
  expect(verdictOf({ timedOut: false, checks: failed, answer: "Which one do you want?", worldChanged: false })).toEqual({ status: "asked", question: "Which one do you want?" });
  expect(verdictOf({ timedOut: false, checks: failed, answer: "Which one do you want?", worldChanged: true })).toEqual({ status: "fail" });
  expect(verdictOf({ timedOut: false, checks: [{ name: "a", pass: true }], answer: "Which one do you want?", worldChanged: false })).toEqual({ status: "pass" });
});

test("asked: the world is unchanged when it is the same data, whatever the order of its keys", () => {
  expect(worldChanged({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(false);
  expect(worldChanged({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 3 }] })).toBe(true);
  expect(worldChanged({ a: 1 }, { a: 1, b: undefined })).toBe(false); // as world.json would hold it
  expect(worldChanged({ a: 1 }, { a: 1, b: null })).toBe(true);
  expect(worldChanged([1, 2], [2, 1])).toBe(true);
});
