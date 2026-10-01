import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo } from "../src/repo.ts";

const mk = () => {
  const r = new Repo();
  r.seed({ "a.ts": "1\n2\n3\n4\n5", "b.ts": "x" });
  return r;
};

test("concurrent sessions touching different regions both land", () => {
  const r = mk();
  r.open({ id: "s1", agent: "A", goal: "g1" });
  r.open({ id: "s2", agent: "B", goal: "g2" });
  r.write("s1", "a.ts", "ONE\n2\n3\n4\n5");
  r.write("s2", "a.ts", "1\n2\n3\n4\nFIVE");
  assert.equal(r.submit("s1").status, "landed");
  const second = r.submit("s2");
  assert.equal(second.status, "landed");
  assert.equal(r.head("a.ts"), "ONE\n2\n3\n4\nFIVE");
  assert.equal(r.s.commits.at(-1)!.merged, true);
});

test("conflict is reported, resolved, then lands", () => {
  const r = mk();
  r.open({ id: "s1", agent: "A", goal: "g1" });
  r.open({ id: "s2", agent: "B", goal: "g2" });
  r.write("s1", "a.ts", "1\nA\n3\n4\n5");
  r.write("s2", "a.ts", "1\nB\n3\n4\n5");
  r.submit("s1");
  const res = r.submit("s2");
  assert.equal(res.status, "conflicted");
  assert.throws(() => r.write("s2", "a.ts", "nope"));
  r.resolve("s2", "a.ts", "both");
  assert.equal(r.submit("s2").status, "landed");
  assert.equal(r.head("a.ts"), "1\nA\nB\n3\n4\n5");
});

test("overlap warnings fire when intents collide", () => {
  const r = mk();
  r.open({ id: "s1", agent: "A", goal: "g1", intent: ["a.ts"] });
  const { warnings } = r.open({ id: "s2", agent: "B", goal: "g2", intent: ["a.ts"] });
  assert.equal(warnings.length, 1);
});

test("protected paths require review and re-merge on approval", () => {
  const r = mk();
  r.setReviewPaths(["b."]);
  r.open({ id: "s1", agent: "A", goal: "g1" });
  r.write("s1", "b.ts", "y");
  assert.equal(r.submit("s1").status, "in_review");
  r.open({ id: "s2", agent: "B", goal: "g2" });
  r.write("s2", "a.ts", "1\n2\n3\n4\nZ");
  assert.equal(r.submit("s2").status, "landed");
  assert.equal(r.review("s1", "R", true).status, "landed");
  assert.equal(r.head("b.ts"), "y");
});

test("delete vs modify is a conflict", () => {
  const r = mk();
  r.open({ id: "s1", agent: "A", goal: "g1" });
  r.open({ id: "s2", agent: "B", goal: "g2" });
  r.write("s1", "b.ts", null);
  r.write("s2", "b.ts", "changed");
  r.submit("s1");
  assert.equal(r.submit("s2").conflicts![0].kind, "delete-modify");
  r.resolve("s2", "b.ts", "theirs");
  assert.equal(r.submit("s2").status, "landed");
  assert.equal(r.head("b.ts"), "changed");
});

test("submitting edits identical to trunk creates no empty commit", () => {
  const r = mk();
  r.open({ id: "s1", agent: "A", goal: "g1" });
  r.write("s1", "b.ts", "x");
  const before = r.s.commits.length;
  assert.equal(r.submit("s1").status, "landed");
  assert.equal(r.s.commits.length, before);
});

test("a landed session id can be reopened with fresh state", () => {
  const r = mk();
  r.open({ id: "s", agent: "A", goal: "g1", intent: ["a.ts"] });
  r.write("s", "a.ts", "1\n2\n3\n4\nQ");
  r.submit("s");
  const { session } = r.open({ id: "s", agent: "B", goal: "g2" });
  assert.deepEqual(session.edits, {});
  assert.deepEqual(session.intent, []);
});

const items = "export function listItems() {\n  return db.query('all');\n}\n\nexport function getItem(id) {\n  return db.query('one ' + id);\n}\n";

test("clean merge touching the same function in different lines needs verification", () => {
  const r = new Repo();
  r.seed({ "items.ts": "export function listItems() {\n  const q = 'all';\n  return db.query(q);\n}\n" });
  r.open({ id: "a", agent: "A", goal: "limit" });
  r.open({ id: "b", agent: "B", goal: "cache" });
  r.write("a", "items.ts", "export function listItems(limit = 50) {\n  const q = 'all';\n  return db.query(q);\n}\n");
  r.write("b", "items.ts", "export function listItems() {\n  const q = 'all';\n  return cache.get(q) ?? db.query(q);\n}\n");
  assert.equal(r.submit("a").status, "landed");
  const res = r.submit("b");
  assert.equal(res.status, "needs_verify");
  assert.equal(res.risks![0].kind, "same-symbol");
  assert.equal(r.preview("b").files["items.ts"]!.includes("limit = 50"), true);
  r.verify("b", "TestBot", true);
  assert.equal(r.session("b").status, "landed");
});

test("dependency interaction across different functions is flagged", () => {
  const r = new Repo();
  r.seed({ "m.ts": "export function price(x) {\n  return x * 2;\n}\n\nexport function total(x) {\n  return price(x) + 1;\n}\n" });
  r.open({ id: "a", agent: "A", goal: "change price" });
  r.open({ id: "b", agent: "B", goal: "change total" });
  r.write("a", "m.ts", "export function price(x, tax) {\n  return x * 2 + tax;\n}\n\nexport function total(x) {\n  return price(x) + 1;\n}\n");
  r.write("b", "m.ts", "export function price(x) {\n  return x * 2;\n}\n\nexport function total(x) {\n  return price(x) + 1 + 5;\n}\n");
  r.submit("a");
  const res = r.submit("b");
  assert.equal(res.status, "needs_verify");
  assert.equal(res.risks![0].kind, "dependency");
});

test("independent functions merge with no verification", () => {
  const r = new Repo();
  r.seed({ "i.ts": items });
  r.open({ id: "a", agent: "A", goal: "g" });
  r.open({ id: "b", agent: "B", goal: "g" });
  r.write("a", "i.ts", items.replace("'all'", "'every'"));
  r.write("b", "i.ts", items.replace("'one '", "'single '"));
  r.submit("a");
  assert.equal(r.submit("b").status, "landed");
});

test("failed verification sends work back; attestation is invalidated by edits", () => {
  const r = new Repo();
  r.seed({ "m.ts": "export function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n" });
  r.open({ id: "a", agent: "A", goal: "g" });
  r.open({ id: "b", agent: "B", goal: "g" });
  r.write("a", "m.ts", "export function f() {\n  const a = 10;\n  const b = 2;\n  return a + b;\n}\n");
  r.write("b", "m.ts", "export function f() {\n  const a = 1;\n  const b = 20;\n  return a + b;\n}\n");
  r.submit("a");
  assert.equal(r.submit("b").status, "needs_verify");
  r.verify("b", "T", false, "tests fail");
  assert.equal(r.session("b").status, "active");
  assert.equal(r.submit("b").status, "needs_verify");
});

test("appending a new declaration is not a change to the function above it", () => {
  const r = new Repo();
  r.seed({ "i.ts": items });
  r.open({ id: "a", agent: "A", goal: "g" });
  r.open({ id: "b", agent: "B", goal: "g" });
  r.write("a", "i.ts", items.replace("'one '", "'single '"));
  r.write("b", "i.ts", items + "\nconst cache = new Map();\n");
  r.submit("a");
  assert.equal(r.submit("b").status, "landed");
});
