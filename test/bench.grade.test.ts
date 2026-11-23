import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/core/tool.ts";
import { failedChecks, runChecks, statusOf, worldAfter } from "../src/bench/grade.ts";

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
