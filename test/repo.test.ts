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
