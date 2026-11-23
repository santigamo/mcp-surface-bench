// Regrading stored runs: from what each run left on disk to a new verdict, with the old one kept.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/core/tool.ts";
import { checkChanges, regrade } from "../src/bench/grade.ts";
import { regradeDir } from "../src/bench/regrading.ts";
import { regradeLine, renderReport } from "../src/bench/render.ts";
import { freshRunDir, readRegrades, readRuns, runDir, saveFinished, writeMeta } from "../src/bench/storage.ts";
import type { RunResult } from "../src/bench/types.ts";
import { fakeMeta, fakeRun } from "./fixtures/fabricate.ts";

type W = { notes: string[] };
const BEFORE: W = { notes: ["seed"] };

/** The grader as fixed: the count may be written as a word. Reports, without requiring, whether the answer was short. */
const addNote: Task<W> = {
  id: "add-note", prompt: "Add a note saying hi and tell me how many notes there are.", source: "test", kind: "write",
  grade: ({ answer, before, after }) => [
    { name: "one note added", pass: after.notes.length === before.notes.length + 1 },
    { name: "answer gives the count", pass: /\b(2|two)\b/i.test(answer), detail: `answer: ${answer}` },
    { name: "short answer", pass: answer.length < 10, required: false },
  ],
};

const by = { at: "2026-11-24T08:00:00.000Z", commit: "fixed00000000000", dirty: false };

function store(root: string, r: RunResult, world?: W) {
  const dir = freshRunDir(root, r);
  if (world) writeFileSync(join(dir, "world.json"), JSON.stringify(world));
  saveFinished(root, r);
}

test("regrade: a run that flips from fail to pass keeps its history; informative checks never flip a status", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-regrade-"));
  try {
    writeMeta(root, fakeMeta(), BEFORE);
    const added = { notes: ["seed", "hi"] };
    // Failed under the old grader, which wanted the digit.
    store(root, fakeRun("add-note", "direct", 1, { status: "fail", answer: "Added it; there are two notes now.", checks: [{ name: "one note added", pass: true }, { name: "answer gives the count", pass: false }] }), added);
    // Passed, and passes again; the new informative check fails on it.
    store(root, fakeRun("add-note", "code", 1, { status: "pass", answer: "There are 2 notes now, after adding yours.", checks: [{ name: "one note added", pass: true }, { name: "answer gives the count", pass: true }] }), added);
    // Wrote nothing: graded against the world it started from, and still fails.
    store(root, fakeRun("add-note", "direct+search", 1, { status: "fail", answer: "2", checks: [{ name: "one note added", pass: false }, { name: "answer gives the count", pass: true }] }));
    // A timeout stays a timeout whatever its checks say.
    store(root, fakeRun("add-note", "direct", 2, { status: "timeout", answer: "two", checks: [{ name: "one note added", pass: false }] }), added);
    store(root, fakeRun("gone", "code", 1, { status: "fail" }));
    store(root, fakeRun("prompt-1", "code", 1, { status: "ungraded", checks: [] }));

    const first = regradeDir(root, [addNote], by);
    const after = new Map(readRuns(root).map((r) => [`${r.task} ${r.arm} ${r.rep}`, r]));

    const flipped = after.get("add-note direct 1")!;
    expect(flipped.status).toBe("pass");
    expect(flipped.graded).toEqual(by);
    expect(flipped.history).toEqual([{ at: "2026-11-23T09:30:00.000Z", commit: "abcdef1234567890", dirty: false, status: "fail", failed: ["answer gives the count"], replacedAt: by.at }]);
    expect(JSON.parse(readFileSync(join(runDir(root, flipped), "result.json"), "utf8"))).toEqual(flipped);

    const informative = after.get("add-note code 1")!;
    expect(informative.status).toBe("pass");
    expect(informative.checks.find((c) => c.name === "short answer")).toEqual({ name: "short answer", pass: false, required: false });
    expect(informative.history).toBeUndefined();
    expect(informative.graded.commit).toBe("abcdef1234567890"); // its verdict did not change, so neither did who gave it

    expect(after.get("add-note direct+search 1")!.status).toBe("fail");
    expect(after.get("add-note direct 2")!).toMatchObject({ status: "timeout", history: [{ status: "timeout", failed: ["one note added"] }] });
    expect(after.get("gone code 1")!.status).toBe("fail");
    expect(after.get("prompt-1 code 1")!.status).toBe("ungraded");

    expect(first.changes.map((c) => [`${c.run.task} / ${c.run.arm} #${c.run.rep}`, c.from, c.run.status])).toEqual([
      ["add-note / direct #1", "fail", "pass"],
      ["add-note / direct #2", "timeout", "timeout"],
    ]);
    expect(first.changes[0]!.why).toEqual(["now passes: answer gives the count", "new check (informative): short answer, fails"]);
    expect(first.skipped).toEqual(["gone / code #1: the suite has no task gone any more"]);
    expect(first.pass).toMatchObject({ runs: 5, changed: [{ task: "add-note", arm: "direct", rep: 1, from: "fail", to: "pass" }, { task: "add-note", arm: "direct", rep: 2, from: "timeout", to: "timeout" }] });

    // runs.jsonl is rewritten with one line per run, not appended to.
    expect(readFileSync(join(root, "runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(6);

    // The same graders again change nothing, and add no history.
    const second = regradeDir(root, [addNote], { ...by, at: "2026-11-24T09:00:00.000Z" });
    expect(second.changes).toEqual([]);
    expect(readRuns(root).find((r) => r.arm === "direct" && r.rep === 1)!.history).toHaveLength(1);

    const regrades = readRegrades(root);
    expect(regrades).toHaveLength(2);
    expect(regradeLine(regrades)).toBe("**Regraded** 2 times, last on 2026-11-24 09:00 UTC at commit fixed00000: 0 of 5 verdicts changed (0 statuses); 2 runs changed over all regrades. Each run that changed keeps its earlier verdicts in its result.json.");
    const md = renderReport(fakeMeta(), readRuns(root), regrades);
    expect(md).toContain("**Regraded** 2 times");
    expect(md).not.toContain("short answer: "); // an informative check is not listed among a run's failures
    expect(md).toContain("| add-note | short answer | 1/2 | 1/1 | 0/1 |");
    expect(md).toContain("- **add-note / direct #2**: timeout\n"); // its failed checks changed, its status did not
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("regrade: one run, pure; a run that errored passes once its checks do, as on the first grading", () => {
  const r = fakeRun("t", "code", 1, { status: "error", error: "the client exited with 1", checks: [{ name: "a", pass: false }] });
  const { result, changed } = regrade(r, [{ name: "a", pass: true }], by, { worldChanged: true });
  expect([changed, result.status, result.error]).toEqual([true, "pass", "the client exited with 1"]);
  const same = regrade(r, [{ name: "a", pass: false, detail: "reworded" }], by, { worldChanged: true });
  expect([same.changed, same.result.status, same.result.checks[0]!.detail, same.result.history]).toEqual([false, "error", "reworded", undefined]);
  // A required check turned informative changes the verdict; the other way round as well.
  const relaxed = regrade(r, [{ name: "a", pass: false, required: false }, { name: "b", pass: true }], by, { worldChanged: true });
  expect([relaxed.changed, relaxed.result.status]).toEqual([true, "pass"]);
  expect(checkChanges(r.checks, relaxed.result.checks)).toEqual(["now informative: a", "new check: b, passes"]);
});

test("regrade: a stored failure that asked instead of acting becomes asked, with its question; one that wrote stays failed", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-regrade-asked-"));
  try {
    writeMeta(root, fakeMeta(), BEFORE);
    const question = "Which note should I add: hi or hello?";
    const failed = [{ name: "one note added", pass: false }, { name: "answer gives the count", pass: false }];
    // Wrote nothing and asked.
    store(root, fakeRun("add-note", "direct", 1, { status: "fail", answer: `I haven't added anything yet. ${question}`, checks: failed }));
    // Asked, but changed the world first: it acted, and failed.
    store(root, fakeRun("add-note", "code", 1, { status: "fail", answer: question, checks: failed }), { notes: ["seed", "hey", "ho"] });
    // Wrote nothing and only offered more.
    store(root, fakeRun("add-note", "direct+search", 1, { status: "fail", answer: "I could not add it. Want me to try again?", checks: failed }));

    const { changes } = regradeDir(root, [addNote], by);
    const after = new Map(readRuns(root).map((r) => [r.arm, r]));
    expect(after.get("direct")).toMatchObject({ status: "asked", question, history: [{ status: "fail", failed: ["one note added", "answer gives the count"] }] });
    expect(after.get("code")!.status).toBe("fail");
    expect(after.get("code")!.question).toBeUndefined();
    expect(after.get("direct+search")!.status).toBe("fail");
    expect(changes.map((c) => [c.run.arm, c.from, c.run.status])).toEqual([["direct", "fail", "asked"]]);
    expect(changes[0]!.why).toContain(`asked the user, having changed nothing: "${question}"`);
    expect(renderReport(fakeMeta(), readRuns(root))).toContain(`- **add-note / direct #1** (regraded; was fail): "${question}"`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
