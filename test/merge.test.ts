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

// ---- smart strategies for the hot spots every change must touch -----------------
test("list lines: two sides adding different items to the same list merge", () => {
  const base = "module.exports = { sum, last };";
  const r = merge3(base, "module.exports = { sum, last, average };", "module.exports = { sum, last, flatten };", { lists: true });
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, "module.exports = { sum, last, average, flatten };");
  assert.equal(r.auto, 1);
});

test("list lines: without the option it is still a conflict", () => {
  const base = "module.exports = { sum, last };";
  assert.equal(merge3(base, "module.exports = { sum, last, a };", "module.exports = { sum, last, b };").conflicts, 1);
});

test("list lines: both adding the same item, an add plus a remove, and arrays all merge", () => {
  assert.equal(merge3("x = [1, 2]", "x = [1, 2, 3]", "x = [1, 2, 3]", { lists: true }).text, "x = [1, 2, 3]");
  assert.equal(merge3("import { a, b, c } from './m';", "import { a, b } from './m';", "import { a, b, c, d } from './m';", { lists: true }).text, "import { a, b, d } from './m';");
  assert.equal(merge3("const xs = [a, b];", "const xs = [a, b, c];", "const xs = [z, a, b];", { lists: true }).text, "const xs = [a, b, c, z];".replace("[a, b, c, z]", "[a, b, c, z]"));
});

test("list lines: a real contradiction stays a conflict", () => {
  // one side removes an item, the other changes the line differently around it
  assert.equal(merge3("f(a, b)", "f(a)", "g(a, b, c)", { lists: true }).conflicts, 1);
  // different surrounding text
  assert.equal(merge3("export { a, b };", "export { a, b, c };", "module.exports = { a, b, d };", { lists: true }).conflicts, 1);
  // one side removes an item the other side keeps modified as a different item set is fine; removing and re-adding the same name is not
  assert.equal(merge3("x = [a, b]", "x = [a]", "x = [a, b, b2]", { lists: true }).text, "x = [a, b2]");
});

test("list lines: nested and quoted commas are not split", () => {
  const r = merge3("call({ a: f(1, 2), b: 'x, y' });", "call({ a: f(1, 2), b: 'x, y', c: 3 });", "call({ a: f(1, 2), b: 'x, y', d: 4 });", { lists: true });
  assert.equal(r.text, "call({ a: f(1, 2), b: 'x, y', c: 3, d: 4 });");
});

test("union: appends at the same point keep both sides (opt in)", () => {
  const base = "t1\nt2\n";
  const ours = "t1\nt2\nOURS\n";
  const theirs = "t1\nt2\nTHEIRS\n";
  assert.equal(merge3(base, ours, theirs).conflicts, 1);
  const r = merge3(base, ours, theirs, { union: true });
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, "t1\nt2\nOURS\nTHEIRS\n");
  assert.equal(r.auto, 1);
});

test("union does not apply to overlapping modifications", () => {
  assert.equal(merge3("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc", { union: true }).conflicts, 1);
});

test("a file with both an exports-line clash and appended tests merges without any conflict", () => {
  const base = "function f() {}\n\nmodule.exports = { f };\n";
  const ours = "function f() {}\n\nfunction g() {}\n\nmodule.exports = { f, g };\n";
  const theirs = "function f() {}\n\nfunction h() {}\n\nmodule.exports = { f, h };\n";
  const r = merge3(base, ours, theirs, { lists: true, union: true });
  assert.equal(r.conflicts, 0);
  assert.ok(r.text.includes("{ f, g, h }"));
  assert.ok(r.text.includes("function g()") && r.text.includes("function h()"));
});
