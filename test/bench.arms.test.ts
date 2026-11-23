import { expect, test } from "bun:test";
import { parseArm, parseArms } from "../src/bench/arms.ts";

const surfaces = ["direct", "code"];

test("arms: a surface alone is tool search off; +search is on, +search=auto is auto", () => {
  expect(parseArm("direct", surfaces)).toEqual({ name: "direct", surface: "direct", toolSearch: "off" });
  expect(parseArm("direct+search", surfaces)).toEqual({ name: "direct+search", surface: "direct", toolSearch: "on" });
  expect(parseArm("code+search=auto", surfaces)).toEqual({ name: "code+search=auto", surface: "code", toolSearch: "auto" });
});

test("arms: a list keeps the order it was given in, spaces and empty items ignored", () => {
  expect(parseArms(" code , direct+search,,direct ", surfaces).map((a) => a.name)).toEqual(["code", "direct+search", "direct"]);
});

test("arms: refused, with what would have been accepted", () => {
  expect(() => parseArm("nope+search", surfaces)).toThrow('"nope" is not a surface; known: direct, code');
  expect(() => parseArm("+search", surfaces)).toThrow("is not a surface");
  expect(() => parseArm("direct+serch", surfaces)).toThrow('unknown modifier "+serch"; known: +search, +search=auto');
  expect(() => parseArm("direct+search=on", surfaces)).toThrow("unknown modifier");
  expect(() => parseArm("direct+", surfaces)).toThrow('unknown modifier "+"');
  expect(() => parseArm("direct+search+search=auto", surfaces)).toThrow("sets tool search twice");
  expect(() => parseArms("direct,code,direct", surfaces)).toThrow('names "direct" twice');
  expect(() => parseArms(",", surfaces)).toThrow("at least one arm");
});
