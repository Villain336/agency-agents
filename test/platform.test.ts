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
