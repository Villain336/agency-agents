import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo, WeaveError, type Actor } from "../src/repo.ts";

const mk = (files: Record<string, string> = { "a.ts": "1\n2\n3\n4\n5", "b.ts": "x", "src/auth.ts": "export function login() {\n  return false;\n}\n" }) => {
  let t = 1_000_000;
  const r = new Repo(undefined, () => (t += 1000));
  r.seed(files);
  return r;
};
const actor = (r: Repo, name: string, kind: any = "agent", extra: any = {}): Actor => {
  const { token } = r.createIdentity({ name, kind, ...extra });
  return r.authenticate(token)!;
};

test("identities: token auth, scopes by kind, revocation, unique names", () => {
  const r = mk();
  const { identity, token } = r.createIdentity({ name: "bot", kind: "agent" });
  assert.ok(token.startsWith("wv_"));
  assert.equal((identity as any).tokenHash, undefined);
  const a = r.authenticate(token)!;
  assert.deepEqual(a.scopes, ["read", "write"]);
  assert.equal(r.authenticate("wv_nope"), null);
  assert.throws(() => r.createIdentity({ name: "bot", kind: "agent" }), /already exists/);
  r.revokeIdentity(identity.id);
  assert.equal(r.authenticate(token), null);
});

test("ownership, path scopes and budgets are enforced", () => {
  const r = mk();
  const a = actor(r, "a", "agent", { paths: ["src/"], budget: { sessionsPerHour: 2 } });
  const b = actor(r, "b");
  r.open({ id: "s1", agent: "a", goal: "g", actor: a });
  assert.throws(() => r.write("s1", "a.ts", "x", a), /may not write/);
  r.write("s1", "src/auth.ts", "y", a);
  assert.throws(() => r.write("s1", "src/auth.ts", "z", b), /belongs to a/);
  r.open({ id: "s2", agent: "a", goal: "g", actor: a });
  assert.throws(() => r.open({ id: "s3", agent: "a", goal: "g", actor: a }), (e: any) => e instanceof WeaveError && e.status === 429);
});

test("agents cannot verify or review their own work", () => {
  const r = mk();
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "src/auth.ts", "export function login() {\n  return true;\n}\n");
  assert.equal(r.submit("s").status, "in_review");
  assert.throws(() => r.review("s", "a", true), /own change/);
});

test("risk tiers: sensitive change needs a reviewer; very risky needs a human", () => {
  const r = mk();
  r.open({ id: "low", agent: "a", goal: "g" });
  r.write("low", "b.ts", "y");
  const low = r.submit("low");
  assert.equal(low.status, "landed");
  assert.equal(low.risk!.tier, "low");

  r.setConfig({ policy: { humanAbove: 30 } }); // make the sensitive change "high"
  r.open({ id: "hi", agent: "a", goal: "g" });
  r.write("hi", "src/auth.ts", "export function login() {\n  return true;\n}\n");
  assert.equal(r.submit("hi").status, "in_review");
  assert.equal(r.session("hi").risk!.need, "human");
  assert.equal(r.review("hi", { name: "bot", kind: "reviewer" }, true).status, "in_review"); // agent approval is not enough
  assert.equal(r.review("hi", { name: "alice", kind: "human" }, true).status, "landed");
});

test("review queue ranks by risk and respects the attention budget", () => {
  const r = mk();
  r.setConfig({ policy: { attentionBudget: 1, autoLandBelow: 0 } });
  r.open({ id: "x", agent: "a", goal: "small" });
  r.write("x", "b.ts", "y");
  r.open({ id: "y", agent: "b", goal: "auth" });
  r.write("y", "src/auth.ts", "export function login() {\n  return true;\n}\n");
  r.submit("x");
  r.submit("y");
  const q = r.reviewQueue("human");
  assert.equal(q.next.length, 1);
  assert.equal(q.next[0].id, "y");
  assert.equal(q.deferred.length, 1);
});

test("comments: threads, blocking comments, suggestions apply to the session", () => {
  const r = mk();
  r.setConfig({ policy: { autoLandBelow: 0 } });
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "a.ts", "1\n2\nTHREE\n4\n5");
  assert.equal(r.submit("s").status, "in_review");
  const c = r.addComment("s", { path: "a.ts", line: 3, author: "rev", body: "use a better name", suggestion: "three", blocking: true });
  assert.throws(() => r.review("s", "rev", true), /blocking/);
  r.addComment("s", { path: "a.ts", line: 3, author: "a", body: "done", parent: c.id });
  r.applySuggestion(c.id);
  assert.equal(r.read("s", "a.ts"), "1\n2\nthree\n4\n5");
  assert.equal(r.s.comments[c.id].resolved, true);
  assert.equal(r.session("s").status, "active"); // editing resets review state
  assert.equal(r.submit("s").status, "in_review");
  assert.equal(r.review("s", "rev", true).status, "landed");
});

test("review pack summarizes diffs, risk and evidence", () => {
  const r = mk();
  r.open({ id: "s", agent: "a", goal: "tweak" });
  r.write("s", "a.ts", "1\n2\nX\n4\n5");
  const p = r.reviewPack("s");
  assert.equal(p.stats.files, 1);
  assert.equal(p.stats.added, 1);
  assert.match(p.files[0].patch, /^-3$/m);
  assert.match(p.files[0].patch, /^\+X$/m);
});

test("provenance is signed, chained, and tampering is detected", () => {
  const r = mk();
  const a = actor(r, "bot", "agent", { model: "claude-x" });
  r.open({ id: "s", agent: "bot", goal: "g", actor: a, prompt: "secret prompt" });
  r.write("s", "b.ts", "y", a);
  const res = r.submit("s", undefined, a);
  const p = r.provenance(res.rev!);
  assert.equal(p.record!.actor.model, "claude-x");
  assert.equal(p.record!.promptHash!.length, 64); // hash only; the prompt is never stored
  assert.equal(p.signature, r.provenance(res.rev!).signature);
  assert.equal(r.verifyChain().ok, true);
  r.s.commits[1].provenance!.actor.name = "someone-else";
  const bad = r.verifyChain();
  assert.equal(bad.ok, false);
  assert.equal(bad.firstBad, 2);
});

test("audit log is hash-chained", () => {
  const r = mk();
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  assert.equal(r.verifyAudit().ok, true);
  r.s.events[1].message = "forged";
  assert.equal(r.verifyAudit().ok, false);
});

// ---- checks / runners ---------------------------------------------------
const withChecks = (r: Repo, evidence: "paths" | "strict" | "train" = "paths") => r.setConfig({ checks: [{ name: "unit", command: "npm test" }], policy: { evidence } });
const runOne = (r: Repo, passed = true) => {
  const j = r.claimJob("runner-1")!;
  assert.ok(j, "a job should be queued");
  r.jobResult(j.id, "runner-1", { passed, output: passed ? "ok" : "boom" });
  return j;
};

test("checks gate landing: queued -> runner passes -> auto-lands", () => {
  const r = mk();
  withChecks(r);
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  assert.equal(r.submit("s").status, "verifying");
  assert.equal(r.claimJob("x")!.files["b.ts"], "y"); // runner sees the merged result
  const j = Object.values(r.s.jobs)[0];
  r.jobResult(j.id, "x", { passed: true, output: "ok", previewUrl: "https://p.example/1" });
  assert.equal(r.session("s").status, "landed");
  assert.deepEqual(r.session("s").previews, ["https://p.example/1"]);
  assert.equal(r.s.commits.at(-1)!.provenance!.evidence[0].check, "unit");
});

test("failing checks send work back; unchanged resubmits stay failed; rerun works", () => {
  const r = mk();
  withChecks(r);
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  runOne(r, false);
  assert.equal(r.session("s").status, "active");
  assert.equal(r.submit("s").status, "active"); // same edits, still failing
  assert.equal(r.rerunChecks("s").status, "verifying");
  runOne(r, true);
  assert.equal(r.session("s").status, "landed");
});

test("check evidence goes stale when a later commit touches the same paths", () => {
  const r = mk();
  withChecks(r);
  r.open({ id: "a", agent: "a", goal: "g" });
  r.open({ id: "b", agent: "b", goal: "g" });
  r.write("a", "a.ts", "ONE\n2\n3\n4\n5");
  r.write("b", "a.ts", "1\n2\n3\n4\nFIVE");
  r.submit("a");
  r.submit("b");
  const ja = r.claimJob("r")!;
  const jb = r.claimJob("r")!;
  r.jobResult(ja.id, "r", { passed: true }); // a lands, touching a.ts
  assert.equal(r.session("a").status, "landed");
  r.jobResult(jb.id, "r", { passed: true }); // b's evidence is stale: it was tested without a's change
  assert.equal(r.session("b").status, "verifying");
  const again = r.claimJob("r")!;
  assert.deepEqual(Object.keys(again.files).length > 0, true);
  assert.equal(again.files["a.ts"], "ONE\n2\n3\n4\nFIVE"); // retested against the merged result
  r.jobResult(again.id, "r", { passed: true });
  assert.equal(r.session("b").status, "landed");
});

test("train mode tests each change on top of the ones queued ahead of it", () => {
  const r = mk();
  withChecks(r, "train");
  r.open({ id: "a", agent: "a", goal: "g" });
  r.open({ id: "b", agent: "b", goal: "g" });
  r.write("a", "a.ts", "ONE\n2\n3\n4\n5");
  r.write("b", "a.ts", "1\n2\n3\n4\nFIVE");
  r.submit("a");
  r.submit("b");
  const ja = r.claimJob("r")!;
  const jb = r.claimJob("r")!;
  assert.deepEqual(jb.basis, ["a"]);
  assert.equal(jb.files["a.ts"], "ONE\n2\n3\n4\nFIVE"); // speculative: already contains a
  r.jobResult(jb.id, "r", { passed: true }); // b finishes first but must wait for a
  assert.equal(r.session("b").status, "verifying");
  r.jobResult(ja.id, "r", { passed: true }); // a lands, which releases b with no re-test
  assert.equal(r.session("a").status, "landed");
  assert.equal(r.session("b").status, "landed");
  assert.equal(r.head("a.ts"), "ONE\n2\n3\n4\nFIVE");
});

test("train mode: if the change ahead fails, dependants are retested", () => {
  const r = mk();
  withChecks(r, "train");
  r.open({ id: "a", agent: "a", goal: "g" });
  r.open({ id: "b", agent: "b", goal: "g" });
  r.write("a", "a.ts", "ONE\n2\n3\n4\n5");
  r.write("b", "a.ts", "1\n2\n3\n4\nFIVE");
  r.submit("a");
  r.submit("b");
  const ja = r.claimJob("r")!;
  const jb = r.claimJob("r")!;
  r.jobResult(jb.id, "r", { passed: true });
  r.jobResult(ja.id, "r", { passed: false });
  assert.equal(r.session("a").status, "active");
  assert.equal(r.session("b").status, "verifying"); // speculation was invalid; needs a fresh job
  const jb2 = r.claimJob("r")!;
  assert.deepEqual(jb2.basis, []);
  assert.equal(jb2.files["a.ts"], "1\n2\n3\n4\nFIVE");
});

test("expired job leases are requeued; wrong runner cannot report", () => {
  let t = 0;
  const r = new Repo(undefined, () => t);
  r.seed({ "b.ts": "x" });
  withChecks(r);
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  const j = r.claimJob("r1", 1000)!;
  assert.throws(() => r.jobResult(j.id, "r2", { passed: true }), /another runner/);
  t = 5000;
  assert.equal(r.claimJob("r2")!.id, j.id);
});

test("shards: a session only writes paths its shard owns", () => {
  const r = mk({ "web/a.ts": "1", "api/b.ts": "2" });
  r.setConfig({ shards: { web: ["web/"], api: ["api/"] }, shard: "web" });
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "web/a.ts", "x");
  assert.throws(() => r.write("s", "api/b.ts", "x"), /belongs to shard "api"/);
});

test("webhooks: matching events are queued for delivery", () => {
  const r = mk();
  r.setConfig({ webhooks: [{ id: "h", url: "https://x.test/hook", secret: "s", events: ["landed"] }] });
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  assert.equal(r.s.outbox.length, 1);
  assert.equal(r.s.outbox[0].event.type, "landed");
});

// ---- findings from the live multi-agent trial ----------------------------
test("stale-read hazard: pinning baseRev to the revision the agent read keeps concurrent work", () => {
  const r = mk({ "todo.js": "line1\nline2\nline3\n" });
  // alice lands a change at r2
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.write("a", "todo.js", "line1\nALICE\nline3\n");
  r.submit("a");
  // bruno read trunk at r1, then opened a session (which pins to r2) and wrote content derived from r1
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("b", "todo.js", "line1\nline2\nline3\nBRUNO\n");
  r.submit("b");
  assert.equal(r.head("todo.js"), "line1\nline2\nline3\nBRUNO\n", "documents the hazard: alice's line was silently reverted");

  // the fix: bruno pins the session to r1, the revision he actually read, and Weave merges correctly
  const r2 = mk({ "todo.js": "line1\nline2\nline3\n" });
  r2.open({ id: "a", agent: "alice", goal: "g" });
  r2.write("a", "todo.js", "line1\nALICE\nline3\n");
  r2.submit("a");
  r2.open({ id: "b", agent: "bruno", goal: "g", baseRev: 2 - 1 });
  r2.write("b", "todo.js", "line1\nline2\nline3\nBRUNO\n");
  assert.equal(r2.submit("b").status, "landed");
  assert.equal(r2.head("todo.js"), "line1\nALICE\nline3\nBRUNO\n");
});

test("baseRev must be a real, past revision", () => {
  const r = mk();
  assert.throws(() => r.open({ id: "x", agent: "a", goal: "g", baseRev: 99 }), /baseRev/);
  assert.throws(() => r.open({ id: "y", agent: "a", goal: "g", baseRev: -1 }), /baseRev/);
});

test("write with basedOn rejects edits derived from a stale read", () => {
  const r = mk({ "f.js": "a\nb\n" });
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.write("a", "f.js", "a\nALICE\n");
  r.submit("a"); // trunk r2 changes f.js
  r.open({ id: "b", agent: "bruno", goal: "g" }); // pinned to r2
  assert.throws(() => r.write("b", "f.js", "a\nb\nBRUNO\n", undefined, 1), (e: any) => e.status === 409 && /read r1/.test(e.message) && /changed in r2/.test(e.message));
  r.write("b", "f.js", "a\nALICE\nBRUNO\n", undefined, 2); // fresh read is fine
  r.write("b", "g.js", "new\n", undefined, 1); // an unrelated file that did not change since r1 is fine
});

test("removing tests is flagged: score rises, review is required, even if checks would pass", () => {
  const tests = "test('a', () => {});\ntest('b', () => {});\ntest('c', () => {});\n";
  const r = mk({ "todo.test.js": tests, "todo.js": "x\n" });
  r.open({ id: "s", agent: "chen", goal: "add search" });
  r.write("s", "todo.test.js", "test('a', () => {});\n");
  const res = r.submit("s");
  assert.equal(res.status, "in_review");
  assert.ok(res.risk!.reasons.some((x) => /removes 2 test case/.test(x)), res.risk!.reasons.join("|"));
  assert.ok(res.risk!.tier !== "low");
});

test("adding tests is not penalized", () => {
  const r = mk({ "todo.test.js": "test('a', () => {});\n", "todo.js": "x\n" });
  r.open({ id: "s", agent: "chen", goal: "more tests" });
  r.write("s", "todo.test.js", "test('a', () => {});\ntest('b', () => {});\n");
  assert.equal(r.submit("s").status, "landed");
});

test("review pack marks which evidence applies to the current edits", () => {
  const r = mk();
  r.setConfig({ checks: [{ name: "unit", command: "t" }], policy: { autoLandBelow: 0 } });
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  let j = r.claimJob("r")!;
  r.jobResult(j.id, "r", { passed: true });
  assert.equal(r.session("s").status, "in_review");
  assert.equal(r.reviewPack("s").evidence[0].current, true);
  r.addComment("s", { path: "b.ts", line: 1, author: "rev", body: "x", suggestion: "z" });
  r.applySuggestion("c1"); // edits change, so old evidence no longer describes the code
  assert.equal(r.reviewPack("s").evidence[0].current, false);
});

test("resolve works as soon as preview shows a conflict, without a submit round-trip", () => {
  const r = mk({ "f.js": "a\nb\nc\n" });
  r.open({ id: "x", agent: "alice", goal: "g" });
  r.open({ id: "y", agent: "bruno", goal: "g" });
  r.write("x", "f.js", "a\nALICE\nc\n");
  r.write("y", "f.js", "a\nBRUNO\nc\n");
  r.submit("x");
  assert.equal(r.preview("y").conflicts.length, 1);
  r.resolve("y", "f.js", [{ text: "ALICE+BRUNO" }]); // no prior submit needed
  assert.equal(r.submit("y").status, "landed");
  assert.equal(r.head("f.js"), "a\nALICE+BRUNO\nc\n");
});

test("resolve with no real conflict says so", () => {
  const r = mk();
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "a.ts", "changed");
  assert.throws(() => r.resolve("s", "a.ts", "ours"), /no conflict on a\.ts against the current trunk/);
});

test("rejection reasons are visible to the author on the session", () => {
  const r = mk();
  r.setConfig({ policy: { autoLandBelow: 0 } });
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  r.review("s", "rev", false, "deletes the tests");
  const fb = r.sessionRO("s").feedback!;
  assert.equal(fb.at(-1)!.type, "rejected");
  assert.equal(fb.at(-1)!.by, "rev");
  assert.equal(fb.at(-1)!.note, "deletes the tests");
  assert.equal(r.sessionRO("s").status, "rejected");
});

test("failed verification notes are visible to the author too", () => {
  const r = mk({ "m.ts": "export function f() {\n  const a = 1;\n  const mid = 0;\n  const b = 2;\n  return a + b + mid;\n}\n" });
  r.open({ id: "a", agent: "A", goal: "g" });
  r.open({ id: "b", agent: "B", goal: "g" });
  r.write("a", "m.ts", "export function f() {\n  const a = 10;\n  const mid = 0;\n  const b = 2;\n  return a + b + mid;\n}\n");
  r.write("b", "m.ts", "export function f() {\n  const a = 1;\n  const mid = 0;\n  const b = 20;\n  return a + b + mid;\n}\n");
  r.submit("a");
  assert.equal(r.submit("b").status, "needs_verify");
  r.verify("b", "T", false, "sum is wrong");
  assert.equal(r.sessionRO("b").feedback!.at(-1)!.note, "sum is wrong");
});

// ---- early conflict detection in train mode -------------------------------
const fnFile = "function a(x) {\n  return x;\n}\n";
const append = (name: string) => fnFile + `\nfunction ${name}(x) {\n  return x;\n}\n`;

test("train mode: a change that conflicts with one queued ahead of it is parked, not built", () => {
  const r = mk({ "f.js": fnFile });
  withChecks(r, "train");
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "f.js", append("fa"));
  r.write("b", "f.js", append("fb"));
  assert.equal(r.submit("a").status, "verifying");
  const res = r.submit("b");
  assert.equal(res.status, "verifying");
  assert.deepEqual(r.session("b").blockedOn, ["a"]);
  assert.equal(Object.values(r.s.jobs).filter((j) => j.sessionId === "b").length, 0, "no CI is spent on a change that is about to conflict");

  // when the change ahead lands, the parked one is re-evaluated against the real trunk: a definite conflict, still no CI wasted
  const j = r.claimJob("r")!;
  r.jobResult(j.id, "r", { passed: true });
  assert.equal(r.session("a").status, "landed");
  assert.equal(r.session("b").status, "conflicted");
  assert.equal(Object.values(r.s.jobs).filter((x) => x.sessionId === "b").length, 0);
});

test("train mode: if the change ahead fails, the parked change proceeds to its own build", () => {
  const r = mk({ "f.js": fnFile });
  withChecks(r, "train");
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "f.js", append("fa"));
  r.write("b", "f.js", append("fb"));
  r.submit("a");
  r.submit("b");
  const j = r.claimJob("r")!;
  r.jobResult(j.id, "r", { passed: false });
  assert.equal(r.session("a").status, "active");
  assert.equal(r.session("b").blockedOn, undefined);
  const jb = r.claimJob("r")!;
  assert.equal(jb.sessionId, "b");
  assert.deepEqual(jb.basis, []);
  r.jobResult(jb.id, "r", { passed: true });
  assert.equal(r.session("b").status, "landed");
});

test("train mode: independent changes are not parked and build in parallel", () => {
  const r = mk({ "f.js": fnFile, "g.js": fnFile });
  withChecks(r, "train");
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "f.js", append("fa"));
  r.write("b", "g.js", append("gb"));
  r.submit("a");
  r.submit("b");
  assert.equal(r.session("b").blockedOn, undefined);
  assert.ok(r.claimJob("r1") && r.claimJob("r2"), "both jobs are runnable at once");
});

test("train mode: a change parked behind one that is abandoned is released", () => {
  const r = mk({ "f.js": fnFile });
  withChecks(r, "train");
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "f.js", append("fa"));
  r.write("b", "f.js", append("fb"));
  r.submit("a");
  r.submit("b");
  r.abandon("a");
  assert.equal(r.session("b").blockedOn, undefined);
  assert.equal(r.claimJob("r")!.sessionId, "b");
});

test("pump only re-evaluates queued sessions that can actually change state", () => {
  const r = mk({ "f.js": fnFile, "g.js": fnFile, "h.js": fnFile });
  withChecks(r, "train");
  for (const [id, f] of [["a", "f.js"], ["b", "g.js"], ["c", "h.js"]] as const) {
    r.open({ id, agent: id, goal: "g" });
    r.write(id, f, append("n" + id));
    r.submit(id);
  }
  let submits = 0;
  const orig = (r as any).submit.bind(r);
  (r as any).submit = (...a: unknown[]) => (submits++, orig(...a));
  const ja = r.claimJob("r")!; // a's job passes -> a lands -> pump runs
  r.jobResult(ja.id, "r", { passed: true });
  // b and c still have running/queued jobs and nothing about them changed: they must not be re-submitted
  assert.ok(submits <= 2, `expected a's own submit only, got ${submits} submits`);
  assert.equal(r.session("b").status, "verifying");
});

test("resolve by providing the final merged file", () => {
  const r = mk({ "f.js": "a\nb\nc\nd\ne\n" });
  r.open({ id: "x", agent: "alice", goal: "g" });
  r.open({ id: "y", agent: "bruno", goal: "g" });
  r.write("x", "f.js", "a\nALICE\nc\nd\ne\n");
  r.write("y", "f.js", "a\nBRUNO\nc\nd\nE2\n");
  r.submit("x");
  assert.equal(r.submit("y").status, "conflicted");
  r.resolveWith("y", "f.js", "a\nALICE+BRUNO\nc\nd\nE2\n");
  assert.equal(r.session("y").status, "active");
  assert.equal(r.submit("y").status, "landed");
  assert.equal(r.head("f.js"), "a\nALICE+BRUNO\nc\nd\nE2\n");
});

test("resolveWith requires an actual conflict on that path and respects ownership", () => {
  const r = mk({ "f.js": "a\nb\nc\n" });
  const owner = actor(r, "owner");
  const other = actor(r, "other");
  r.open({ id: "s", agent: "owner", goal: "g", actor: owner });
  r.write("s", "f.js", "a\nB\nc\n", owner);
  assert.throws(() => r.resolveWith("s", "f.js", "x", owner), /no conflict/);
  assert.throws(() => r.resolveWith("s", "f.js", "x", other), /belongs to owner/);
});

// ---- swarm run 1: stale resolutions silently erased teammates' landed work -----
const lib = (names: string[]) => names.map((n) => `function ${n}(x) {\n  const ${n}Input = x;\n  const ${n}Result = ${n}Input + 1;\n  return ${n}Result;\n}\n`).join("\n") + `\nmodule.exports = { ${names.join(", ")} };\n`;

test("a stale resolution cannot silently erase landed work (revert detection is the safety net)", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  r.open({ id: "ivy", agent: "ivy", goal: "g" });
  r.open({ id: "gus", agent: "gus", goal: "g" });
  r.open({ id: "eli", agent: "eli", goal: "g" });
  r.write("ivy", "lib.js", lib(["sum", "average"]));
  r.write("gus", "lib.js", lib(["sum", "capitalize"]));
  r.write("eli", "lib.js", lib(["sum", "flatten"]));
  assert.equal(r.submit("ivy").status, "landed"); // r2
  assert.equal(r.submit("gus").status, "conflicted"); // computed against r2
  assert.equal(r.submit("eli").status, "conflicted");
  // eli re-applies on trunk r2 and lands (r3) while gus is still working
  r.resolveWith("eli", "lib.js", lib(["sum", "average", "flatten"]));
  assert.equal(r.submit("eli").status, "landed");
  // gus finishes his resolution, written against the r2 trunk he was shown (it lacks flatten)
  r.resolveWith("gus", "lib.js", lib(["sum", "average", "capitalize"]));
  const res = r.submit("gus");
  // eli's work must still be there, or gus is told about the clash; it must never be silently dropped
  assert.ok(r.head("lib.js")!.includes("function flatten"), `flatten was erased; gus got: ${res.status}`);
});

test("a clean merge that removes substantial code another agent landed is stopped and explained", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  r.open({ id: "eli", agent: "eli", goal: "g" });
  r.write("eli", "lib.js", lib(["sum", "flatten"]));
  r.submit("eli"); // r2 adds flatten
  r.open({ id: "bob", agent: "bob", goal: "g" }); // opens after eli landed...
  r.write("bob", "lib.js", lib(["sum"]) + "// bob's edit\n"); // ...but wrote content derived from the old trunk (stale read)
  const res = r.submit("bob");
  assert.equal(res.status, "active");
  assert.equal(res.reverts![0].agent, "eli");
  assert.equal(res.reverts![0].rev, 2);
  assert.ok(r.head("lib.js")!.includes("function flatten"), "nothing landed");
  assert.match(r.sessionRO("bob").feedback!.at(-1)!.note, /remove[s]? .*r2/i);
});

test("an author can confirm an intentional removal; it then needs review", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  r.open({ id: "eli", agent: "eli", goal: "g" });
  r.write("eli", "lib.js", lib(["sum", "flatten"]));
  r.submit("eli");
  r.open({ id: "bob", agent: "bob", goal: "remove flatten: it is unused" });
  r.write("bob", "lib.js", lib(["sum"]));
  const res = r.submit("bob", undefined, undefined, { allowRevert: true });
  assert.equal(res.status, "in_review");
  assert.ok(res.risk!.reasons.some((x) => /removes .*landed/i.test(x)));
});

test("small edits and ordinary rewrites by the same author are not flagged as reverts", () => {
  const r = mk({ "lib.js": lib(["sum", "last"]) });
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.write("a", "lib.js", lib(["sum", "last"]).replace("sumInput + 1", "sumInput + 2"));
  assert.equal(r.submit("a").status, "landed");
  r.open({ id: "b", agent: "alice", goal: "g" }); // same author reworking their own change
  r.write("b", "lib.js", lib(["sum", "last"]).replace("sumInput + 1", "sumInput + 3"));
  assert.equal(r.submit("b").status, "landed");
});

test("a session waiting in review is re-checked when trunk moves: it becomes conflicted, not stale", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  r.setConfig({ policy: { autoLandBelow: 0 } }); // everything needs review
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "lib.js", lib(["sum", "x1"]));
  r.write("b", "lib.js", lib(["sum", "x2"]));
  assert.equal(r.submit("a").status, "in_review");
  assert.equal(r.submit("b").status, "in_review");
  r.review("a", "rev", true); // a lands; b can no longer merge
  assert.equal(r.session("b").status, "conflicted");
  assert.deepEqual(r.session("b").approvals, []);
});

test("blockedOn is cleared when a parked session leaves the queue", () => {
  const r = mk({ "f.js": fnFile });
  withChecks(r, "train");
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "f.js", append("fa"));
  r.write("b", "f.js", append("fb"));
  r.submit("a");
  r.submit("b");
  assert.deepEqual(r.session("b").blockedOn, ["a"]);
  r.jobResult(r.claimJob("r")!.id, "r", { passed: true }); // a lands, b is re-evaluated and now conflicts
  assert.equal(r.session("b").status, "conflicted");
  assert.equal(r.session("b").blockedOn, undefined);
});

test("review pack leads with warnings: out-of-date, conflicts, stale evidence, removed work", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  r.setConfig({ checks: [{ name: "unit", command: "t" }], policy: { autoLandBelow: 0 } });
  r.open({ id: "eli", agent: "eli", goal: "g" });
  r.open({ id: "bob", agent: "bob", goal: "g" });
  r.write("eli", "lib.js", lib(["sum", "flatten"]));
  r.write("bob", "lib.js", lib(["sum", "capitalize"]));
  r.submit("eli");
  r.jobResult(r.claimJob("r")!.id, "r", { passed: true });
  r.review("eli", "rev", true); // lands r2
  assert.equal(r.submit("bob").status, "conflicted");
  const pack = r.reviewPack("bob");
  assert.ok(pack.warnings.some((w: string) => /no longer merges with trunk.*lib\.js/i.test(w)), pack.warnings.join("|"));
  assert.ok(pack.warnings.some((w: string) => /behind trunk by 1/i.test(w)));
  assert.equal(pack.behindBy, 1);

  // stale evidence is called out
  const r2 = mk();
  r2.setConfig({ checks: [{ name: "unit", command: "t" }], policy: { autoLandBelow: 0 } });
  r2.open({ id: "s", agent: "a", goal: "g" });
  r2.write("s", "b.ts", "y");
  r2.submit("s");
  r2.jobResult(r2.claimJob("r")!.id, "r", { passed: true });
  r2.write("s", "b.ts", "z"); // edits change after the passing run
  assert.ok(r2.reviewPack("s").warnings.some((w: string) => /evidence .*not (for|current)/i.test(w) || /no check evidence/i.test(w)));
});

test("waiting sessions whose change already reached trunk are closed; queue risk is refreshed", () => {
  const r = mk({ "f.js": "a\nb\nc\n", "README.md": "# t\n" });
  r.setConfig({ policy: { autoLandBelow: 0 } });
  r.open({ id: "a", agent: "alice", goal: "g" });
  r.open({ id: "b", agent: "bruno", goal: "g" });
  r.write("a", "f.js", "a\nB\nc\n");
  r.write("b", "f.js", "a\nB\nc\n"); // bruno's change is identical to alice's
  r.submit("a");
  r.submit("b");
  assert.equal(r.reviewQueue("human").next.length, 2);
  r.review("a", "rev", true); // alice lands; bruno's change is now already on trunk
  assert.equal(r.session("b").status, "landed", "an identical change needs no review");
  assert.equal(r.reviewQueue("human").next.length, 0);
});

test("an up-to-date resolution does not conflict again just because trunk moved after the conflict was detected", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  for (const [id, name] of [["ivy", "average"], ["bob", "capitalize"], ["eli", "flatten"]] as const) {
    r.open({ id, agent: id, goal: "g" });
    r.write(id, "lib.js", lib(["sum", name]));
  }
  assert.equal(r.submit("ivy").status, "landed"); // r2 changes the shared exports line
  assert.equal(r.submit("bob").status, "conflicted"); // detected at r2
  assert.equal(r.submit("eli").status, "conflicted");
  r.resolveWith("eli", "lib.js", lib(["sum", "average", "flatten"]));
  assert.equal(r.submit("eli").status, "landed"); // r3 changes the exports line again, after bob's conflict was detected
  // bob re-reads trunk r3 and builds his file from it: that is the freshest possible resolution
  r.resolveWith("bob", "lib.js", lib(["sum", "average", "flatten", "capitalize"]), undefined, 3);
  assert.equal(r.submit("bob").status, "landed", "a resolution built from r3 must not conflict with r3");
  assert.ok(["average", "flatten", "capitalize"].every((n) => r.head("lib.js")!.includes(`function ${n}`)));
});

test("a resolution that declares an older base is merged with what landed since", () => {
  const r = mk({ "lib.js": lib(["sum"]) });
  for (const [id, name] of [["ivy", "average"], ["bob", "capitalize"], ["eli", "flatten"]] as const) {
    r.open({ id, agent: id, goal: "g" });
    r.write(id, "lib.js", lib(["sum", name]));
  }
  r.submit("ivy"); // r2
  r.submit("bob"); // conflicted at r2
  r.submit("eli");
  r.resolveWith("eli", "lib.js", lib(["sum", "average", "flatten"]));
  r.submit("eli"); // r3
  // bob only read r2: his file lacks flatten. Declaring that base, flatten is merged in (or flagged), never erased
  r.resolveWith("bob", "lib.js", lib(["sum", "average", "capitalize"]), undefined, 2);
  r.submit("bob");
  assert.ok(r.head("lib.js")!.includes("function flatten"));
});
