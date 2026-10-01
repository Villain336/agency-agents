import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticRisk, symbols } from "../src/semantic.ts";
import { splitLines } from "../src/merge.ts";

const L = (s: string) => splitLines(s);

test("a trailing exports statement is its own region, not part of the last function", () => {
  const syms = symbols(L("function a(x) {\n  return x;\n}\n\nfunction b(x) {\n  return x;\n}\n\nmodule.exports = { a, b };\n"));
  assert.deepEqual(syms.filter((s) => s.name !== "<top>").map((s) => s.name), ["a", "b"]);
  const b = syms.find((s) => s.name === "b")!;
  assert.equal(b.end - b.start, 3, "b spans only its own three lines");
  assert.ok(syms.some((s) => s.name === "<top>" && s.start >= b.end));
});

test("editing only the exports line (or adding a function) is not an interaction with the function above it", () => {
  const base = "function a(x) {\n  return x;\n}\n\nmodule.exports = { a };\n";
  const ours = "function a(x) {\n  return x;\n}\n\nfunction b(x) {\n  return x;\n}\n\nmodule.exports = { a, b };\n";
  const theirs = "function a(x) {\n  return x;\n}\n\nfunction c(x) {\n  return x;\n}\n\nmodule.exports = { a, c };\n";
  assert.deepEqual(semanticRisk("lib.js", base, ours, theirs), []);
});

test("a function that calls one the other side changed is still flagged", () => {
  const base = "function price(x) {\n  return x * 2;\n}\n\nfunction total(x) {\n  return price(x) + 1;\n}\n\nmodule.exports = { price, total };\n";
  const ours = base.replace("function price(x) {", "function price(x, tax) {");
  const theirs = base.replace("price(x) + 1", "price(x) + 1 + 5");
  assert.equal(semanticRisk("m.js", base, ours, theirs)[0].kind, "dependency");
});

test("two edits inside one function are still flagged", () => {
  const base = "function f(x) {\n  const a = 1;\n  const mid = 0;\n  const b = 2;\n  return a + b + mid;\n}\n\nmodule.exports = { f };\n";
  const ours = base.replace("const a = 1;", "const a = 10;");
  const theirs = base.replace("const b = 2;", "const b = 20;");
  assert.equal(semanticRisk("f.js", base, ours, theirs)[0].kind, "same-symbol");
});

test("python and go style declarations get their own ranges too", () => {
  const py = symbols(L("def a(x):\n    return x\n\ndef b(x):\n    return a(x)\n\nVALUE = 3\n"));
  assert.deepEqual(py.filter((s) => s.name !== "<top>").map((s) => s.name), ["a", "b"]);
  const go = symbols(L("func A(x int) int {\n\treturn x\n}\n\nfunc B(x int) int {\n\treturn A(x)\n}\n\nvar V = 3\n"));
  assert.deepEqual(go.filter((s) => s.name !== "<top>").map((s) => s.name), ["A", "B", "V"]);
});

test("braces inside strings do not confuse the ranges", () => {
  const syms = symbols(L("function a(x) {\n  return '}{';\n}\n\nfunction b() {}\n"));
  assert.deepEqual(syms.filter((s) => s.name !== "<top>").map((s) => s.name), ["a", "b"]);
  assert.equal(syms.find((s) => s.name === "a")!.end, 3);
});
