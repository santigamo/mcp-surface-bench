import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelMismatch, reportedModels, resumeProblems } from "../src/bench/resume.ts";
import { readMeta, writeMeta } from "../src/bench/storage.ts";
import { ARMS, fakeMeta, fakeRun } from "./fixtures/fabricate.ts";

const runs = [fakeRun("t1", "direct", 1), fakeRun("t1", "code", 1)];

test("resume: the same benchmark resumes", () => {
  expect(resumeProblems(fakeMeta(), fakeMeta({ startedAt: "later", git: { commit: "other", dirty: true } }), runs)).toEqual([]);
});

test("resume: changed arms are refused, and the same arms in another order say how to pass them", () => {
  const reordered = fakeMeta({ arms: [ARMS[2]!, ARMS[0]!, ARMS[1]!] });
  expect(resumeProblems(fakeMeta(), reordered, runs)).toEqual(["the same arms in another order: the order sets the run order and the report's; pass --arms direct,direct+search,code"]);
  const fewer = fakeMeta({ arms: [ARMS[0]!, ARMS[2]!] });
  expect(resumeProblems(fakeMeta(), fewer, runs)).toEqual(["different arms: this label has direct,direct+search,code; given direct,code"]);
  const remapped = fakeMeta({ arms: ARMS.map((a) => (a.name === "direct+search" ? { ...a, setting: "something else" } : a)) });
  expect(resumeProblems(fakeMeta(), remapped, runs)).toEqual(["the same arms resolve to different client settings"]);
});

test("resume: a different model is refused, naming the model the runs ran", () => {
  const pinned = fakeMeta();
  pinned.options = { ...pinned.options, model: "claude-sonnet-5" };
  expect(resumeProblems(fakeMeta(), pinned, runs)).toEqual(["a different model: this label asked for the client's default, which ran claude-opus-5-5; given claude-sonnet-5"]);
  const mixed = [...runs, fakeRun("t2", "code", 1, { model: "claude-sonnet-5" })];
  expect(resumeProblems(fakeMeta(), fakeMeta(), mixed)).toEqual(["its runs already ran several models (claude-opus-5-5, claude-sonnet-5)"]);
});

test("resume: a different effort is refused, the client's default included", () => {
  const medium = fakeMeta();
  medium.options = { ...medium.options, effort: "medium" };
  expect(resumeProblems(fakeMeta(), medium, runs)).toEqual(["a different effort: this label asked for the client's default; given medium"]);
  const high = fakeMeta();
  high.options = { ...high.options, effort: "high" };
  expect(resumeProblems(medium, high, runs)).toEqual(["a different effort: this label asked for medium; given high"]);
  expect(resumeProblems(medium, medium, runs)).toEqual([]);
});

test("resume: other options, the client version, the listings and the starting world are compared too", () => {
  const next = fakeMeta({ client: { name: "claude", version: "2.2.0", setup: [] }, world: { sha256: "w1" } });
  next.options = { ...next.options, n: 3 };
  expect(resumeProblems(fakeMeta(), next, runs)).toEqual(["different n", "a different client", "a different starting world (the suite's seed changed)"]);
});

test("model: a run that reports another model than the label's cannot join it; an unreported one is not compared", () => {
  const established = reportedModels(runs);
  expect(established).toEqual(["claude-opus-5-5"]);
  expect(modelMismatch(established, fakeRun("t2", "code", 1))).toBeNull();
  expect(modelMismatch(established, fakeRun("t2", "code", 1, { model: "claude-sonnet-5" }))).toStartWith("the client ran claude-sonnet-5, but this label's runs ran claude-opus-5-5");
  expect(modelMismatch(established, fakeRun("t2", "code", 1, { model: "claude default", modelSource: "default" }))).toBeNull();
  expect(modelMismatch([], fakeRun("t2", "code", 1, { model: "anything" }))).toBeNull();
  expect(reportedModels([fakeRun("t1", "code", 1, { model: "codex default", modelSource: "default" })])).toEqual([]);
});

test("layout: meta.json of the first runner (results/x-empty) is refused, not misread", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-layout-"));
  try {
    writeFileSync(join(root, "meta.json"), JSON.stringify({ label: "x-empty", options: { surfaces: ["direct", "code"], toolSearch: "off" } }));
    expect(() => readMeta(root)).toThrow("the first version of the runner");
    writeMeta(root, fakeMeta(), { notes: [] });
    expect(readMeta(root)!.options.arms).toEqual(["direct", "direct+search", "code"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
