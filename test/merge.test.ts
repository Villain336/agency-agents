import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3, resolveSegments } from "../src/merge.ts";

const L = (...l: string[]) => l.join("\n");

test("non-overlapping edits merge cleanly", () => {
  const base = L("a", "b", "c", "d", "e");
  const r = merge3(base, L("A", "b", "c", "d", "e"), L("a", "b", "c", "d", "E"));
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, L("A", "b", "c", "d", "E"));
});

test("identical edits on both sides do not conflict", () => {
  const r = merge3("a\nb", "a\nX", "a\nX");
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, "a\nX");
});

test("overlapping different edits conflict and can be resolved", () => {
  const r = merge3(L("a", "b", "c"), L("a", "ours", "c"), L("a", "theirs", "c"));
  assert.equal(r.conflicts, 1);
  assert.equal(resolveSegments(r.segments, ["both"]), L("a", "ours", "theirs", "c"));
  assert.equal(resolveSegments(r.segments, [{ text: "merged" }]), L("a", "merged", "c"));
});

test("insertions at different places merge", () => {
  const r = merge3(L("a", "b", "c"), L("x", "a", "b", "c"), L("a", "b", "c", "y"));
  assert.equal(r.text, L("x", "a", "b", "c", "y"));
});

test("insertions at the same point conflict", () => {
  const r = merge3("a\nb", "a\nX\nb", "a\nY\nb");
  assert.equal(r.conflicts, 1);
});

test("delete on one side, untouched elsewhere", () => {
  const r = merge3(L("a", "b", "c", "d"), L("a", "c", "d"), L("a", "b", "c", "D"));
  assert.equal(r.text, L("a", "c", "D"));
});

test("same-point appends conflict regardless of how equivalent diffs happen to align", () => {
  const fn = (n: string) => `function ${n}(x) {\n  return x;\n}\n`;
  const base = fn("a") + "\n" + fn("b");
  const ours = base + "\n" + fn("added1");
  const theirs = base + "\n" + fn("added2");
  assert.equal(merge3(base, ours, theirs).conflicts, 1);
  // and with an unrelated edit on one side, which previously shifted the alignment
  const ours2 = ours.replace("return x;", "return x + 1;");
  assert.equal(merge3(base, ours2, theirs).conflicts, 1);
});

test("equivalent diffs are canonical: insertions slide to the same position", async () => {
  const { diffHunks, splitLines } = await import("../src/merge.ts");
  const B = splitLines("a\n}\n\nb\n}\n");
  const H1 = diffHunks(B, splitLines("a\n}\n\nb\n}\n\nc\n}\n"));
  const H2 = diffHunks(B, splitLines("a\n}\n\nb\n}\n\nd\n}\n"));
  assert.deepEqual(H1.map((h) => [h.start, h.end]), H2.map((h) => [h.start, h.end]));
});

test("independent edits far apart still merge cleanly after compaction", () => {
  const base = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const ours = base.replace("line3", "OURS");
  const theirs = base.replace("line25", "THEIRS");
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts, 0);
  assert.ok(r.text.includes("OURS") && r.text.includes("THEIRS"));
});

test("deleting one of several identical lines is deterministic", () => {
  const base = "x\ny\ny\ny\nz";
  const a = merge3(base, "x\ny\ny\nz", "x\ny\ny\nz");
  assert.equal(a.conflicts, 0);
  assert.equal(a.text, "x\ny\ny\nz");
});
