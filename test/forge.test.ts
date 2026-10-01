import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo, WeaveError } from "../src/repo.ts";

const mk = () => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const r = new Repo(undefined, () => clock.now());
  r.seed({ "a.ts": "1\n2\n3", "weave.json": "{}" });
  return Object.assign(r, { clock });
};

// ---------------------------------------------------------------- tasks
test("tasks: create, list, filter, and numbering", () => {
  const r = mk();
  const a = r.createTask("alice", { title: "Fix login", body: "it breaks", labels: ["bug"], priority: "high" });
  const b = r.createTask("bob", { title: "Add docs", labels: ["docs"] });
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  assert.equal(a.status, "open");
  assert.equal(r.listTasks({ label: "bug" }).length, 1);
  assert.equal(r.listTasks({ q: "docs" })[0].number, 2);
  assert.equal(r.listTasks({}).map((t) => t.number).join(), "2,1", "newest first");
  assert.throws(() => r.createTask("a", { title: "  " }), /title/);
  assert.throws(() => r.createTask("a", { title: "x", priority: "meh" as any }), /priority/);
});

test("tasks: claim leases, renewal, expiry, and conflicts", () => {
  const r = mk();
  r.createTask("alice", { title: "t" });
  const c = r.claimTask(1, "bot1", 600);
  assert.equal(c.status, "claimed");
  assert.equal(c.claim!.by, "bot1");
  assert.equal(c.assignee, "bot1");
  assert.throws(() => r.claimTask(1, "bot2"), (e: any) => e instanceof WeaveError && e.status === 409 && /bot1/.test(e.message));
  r.clock.advance(300_000);
  r.claimTask(1, "bot1", 600); // the same claimant renews
  r.clock.advance(599_000);
  assert.throws(() => r.claimTask(1, "bot2"), /bot1/, "renewed lease is still live");
  r.clock.advance(2_000);
  assert.equal(r.claimTask(1, "bot2").claim!.by, "bot2", "an expired lease can be taken over");
  assert.throws(() => r.heartbeatTask(1, "bot1"), /not the claimant|claimed by/i);
  r.heartbeatTask(1, "bot2");
  r.releaseTask(1, "bot2");
  assert.equal(r.getTask(1).status, "open");
});

test("tasks: next() picks the best unclaimed, unblocked task for an agent", () => {
  const r = mk();
  r.createTask("a", { title: "low old", priority: "low" });
  r.clock.advance(1000);
  r.createTask("a", { title: "urgent", priority: "urgent" });
  r.createTask("a", { title: "blocked urgent", priority: "urgent", dependsOn: [1] });
  r.createTask("a", { title: "normal docs", labels: ["docs"] });
  assert.equal(r.nextTask({})!.title, "urgent");
  r.claimTask(2, "bot1");
  assert.equal(r.nextTask({})!.title, "normal docs", "claimed and blocked tasks are skipped");
  assert.equal(r.nextTask({ labels: ["docs"] })!.title, "normal docs");
  assert.equal(r.nextTask({ labels: ["nope"] }), null);
  r.closeTask(1, "a"); // unblocks #3, which is urgent and unclaimed
  assert.equal(r.nextTask({})!.title, "blocked urgent");
});

test("tasks: a blocked task becomes available when its dependency is done", () => {
  const r = mk();
  r.createTask("a", { title: "first" });
  r.createTask("a", { title: "second", dependsOn: [1], priority: "urgent" });
  assert.equal(r.nextTask({})!.title, "first");
  r.closeTask(1, "a");
  assert.equal(r.nextTask({})!.title, "second");
});

test("tasks: a session opened for a task claims it, and landing completes it", () => {
  const r = mk();
  r.createTask("alice", { title: "change a" });
  r.open({ id: "s", agent: "bot", goal: "fix #1", taskNumber: 1 });
  assert.equal(r.getTask(1).status, "claimed");
  assert.equal(r.getTask(1).claim!.by, "bot");
  assert.deepEqual(r.getTask(1).sessions, ["s"]);
  r.write("s", "a.ts", "changed");
  r.submit("s");
  const t = r.getTask(1);
  assert.equal(t.status, "done");
  assert.ok(t.comments.some((c) => /landed in r\d+/.test(c.body)));
  assert.equal(t.claim, undefined);
});

test("tasks: abandoning or rejecting the session releases the claim", () => {
  const r = mk();
  r.createTask("alice", { title: "change a" });
  r.open({ id: "s", agent: "bot", goal: "g", taskNumber: 1 });
  r.abandon("s");
  assert.equal(r.getTask(1).status, "open");
  assert.equal(r.getTask(1).claim, undefined);
});

test("tasks: opening a session for a task someone else holds is refused; unknown or closed tasks too", () => {
  const r = mk();
  r.createTask("alice", { title: "t" });
  r.claimTask(1, "bot1");
  assert.throws(() => r.open({ id: "s", agent: "bot2", goal: "g", taskNumber: 1 }), /bot1/);
  assert.throws(() => r.open({ id: "s2", agent: "bot2", goal: "g", taskNumber: 99 }), /no such task/);
  r.closeTask(1, "alice");
  assert.throws(() => r.open({ id: "s3", agent: "bot1", goal: "g", taskNumber: 1 }), /closed|done/);
});

test("tasks: comments, assign, update, close and reopen", () => {
  const r = mk();
  r.createTask("alice", { title: "t" });
  r.commentTask(1, "bob", "on it");
  r.assignTask(1, "carol", "alice");
  r.updateTask(1, { title: "new title", labels: ["x"], priority: "low" });
  const t = r.getTask(1);
  assert.equal(t.title, "new title");
  assert.equal(t.assignee, "carol");
  assert.equal(t.comments.length, 1);
  r.closeTask(1, "alice");
  assert.equal(r.getTask(1).status, "closed");
  assert.throws(() => r.claimTask(1, "bot"), /closed/);
  r.reopenTask(1, "alice");
  assert.equal(r.getTask(1).status, "open");
});

// ---------------------------------------------------------------- notifications
test("notifications: @mentions, assignments and task comments reach the right people", () => {
  const r = mk();
  r.createTask("alice", { title: "t", body: "cc @bob and @carol" });
  assert.deepEqual(r.notificationsFor("bob").map((n) => n.type), ["mention"]);
  assert.equal(r.notificationsFor("carol").length, 1);
  assert.equal(r.notificationsFor("alice").length, 0, "no self-notification");
  r.assignTask(1, "dave", "alice");
  assert.equal(r.notificationsFor("dave")[0].type, "task_assigned");
  r.commentTask(1, "bob", "ping @alice");
  const a = r.notificationsFor("alice").map((n) => n.type).sort();
  assert.deepEqual(a, ["mention"]);
  assert.ok(r.notificationsFor("dave").some((n) => n.type === "task_commented"), "assignee hears about comments");
});

test("notifications: read state, unread filter, and per-user caps", () => {
  const r = mk();
  for (let i = 0; i < 3; i++) r.createTask("alice", { title: "t" + i, body: "hey @bob" });
  const unread = r.notificationsFor("bob", { unread: true });
  assert.equal(unread.length, 3);
  r.markRead("bob", { ids: [unread[0].id] });
  assert.equal(r.notificationsFor("bob", { unread: true }).length, 2);
  r.markRead("bob", { all: true });
  assert.equal(r.notificationsFor("bob", { unread: true }).length, 0);
  assert.equal(r.notificationsFor("bob").length, 3, "read items are kept");
  for (let i = 0; i < 260; i++) r.createTask("alice", { title: "x", body: "@bob" });
  assert.ok(r.notificationsFor("bob").length <= 200, "capped");
});

test("notifications: review requests and landings notify people who care", () => {
  const r = mk();
  r.createIdentity({ name: "rev", kind: "reviewer" });
  r.createIdentity({ name: "hana", kind: "human" });
  r.setConfig({ policy: { autoLandBelow: 0 } });
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "a.ts", "x");
  r.submit("s");
  assert.ok(r.notificationsFor("rev").some((n) => n.type === "review_requested"));
  assert.ok(r.notificationsFor("hana").some((n) => n.type === "review_requested"));
  r.review("s", "rev", true);
  assert.ok(r.notificationsFor("bot").some((n) => n.type === "change_landed"));
});

// ---------------------------------------------------------------- tags and releases
test("tags are immutable, validated, and default to head", () => {
  const r = mk();
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "a.ts", "x");
  r.submit("s");
  const t = r.createTag("v1.0.0", { message: "first", tagger: "alice" });
  assert.equal(t.rev, 2);
  assert.throws(() => r.createTag("v1.0.0", { tagger: "alice" }), /already exists/);
  assert.throws(() => r.createTag("bad name!", { tagger: "a" }), /tag name/);
  assert.throws(() => r.createTag("v2", { rev: 99, tagger: "a" }), /revision/);
  assert.equal(r.createTag("seed-point", { rev: 1, tagger: "a" }).rev, 1);
  assert.deepEqual(r.listTags().map((x) => x.name).sort(), ["seed-point", "v1.0.0"]);
});

test("releases attach to an existing tag, once", () => {
  const r = mk();
  assert.throws(() => r.createRelease({ tag: "nope", title: "x", notes: "" }, "a"), /no such tag/);
  r.createTag("v1", { tagger: "a" });
  const rel = r.createRelease({ tag: "v1", title: "One", notes: "## Changes\n- stuff", prerelease: true }, "alice");
  assert.equal(rel.prerelease, true);
  assert.throws(() => r.createRelease({ tag: "v1", title: "again", notes: "" }, "a"), /already has a release/);
  assert.equal(r.getRelease("v1").title, "One");
  assert.equal(r.listReleases().length, 1);
});

// ---------------------------------------------------------------- review claims
test("review claims: only the claimant can review while the lease is live", () => {
  const r = mk();
  r.setConfig({ policy: { autoLandBelow: 0 } });
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "a.ts", "x");
  r.submit("s");
  r.claimReview("s", "rev1", 300);
  assert.throws(() => r.claimReview("s", "rev2"), (e: any) => e.status === 409 && /rev1/.test(e.message));
  assert.throws(() => r.review("s", "rev2", true), /claimed by rev1/);
  assert.equal(r.reviewQueue("human").next[0].claimedBy, "rev1");
  r.clock.advance(301_000);
  assert.equal(r.claimReview("s", "rev2", 300).reviewClaim!.by, "rev2", "an expired claim can be taken");
  assert.equal(r.review("s", "rev2", true).status, "landed");
  assert.equal(r.sessionRO("s").reviewClaim, undefined);
});

// ---------------------------------------------------------------- config as code
test("weave.json: landing it applies checks, review paths, policy and merge settings", () => {
  const r = mk();
  r.open({ id: "s", agent: "admin-bot", goal: "configure" });
  r.write("s", "weave.json", JSON.stringify({ checks: [{ name: "unit", command: "npm test" }], reviewPaths: ["src/auth"], policy: { evidence: "train" }, merge: { lists: true, union: ["*.test.js"] } }));
  assert.equal(r.submit("s").status, "in_review", "config changes need a human");
  assert.equal(r.review("s", { name: "hana", kind: "human" }, true).status, "landed");
  assert.deepEqual(r.config.checks.map((c) => c.name), ["unit"]);
  assert.deepEqual(r.config.reviewPaths, ["src/auth"]);
  assert.equal(r.policy().evidence, "train");
  assert.deepEqual(r.config.merge.union, ["*.test.js"]);
});

test("weave.json: invalid JSON or unknown shapes are rejected before landing; secrets stay out", () => {
  const r = mk();
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "weave.json", "{ not json");
  const res: any = r.submit("s");
  assert.equal(res.status, "active");
  assert.match(r.sessionRO("s").feedback!.at(-1)!.note, /weave\.json/);
  r.write("s", "weave.json", JSON.stringify({ webhooks: [{ url: "https://evil", secret: "x" }], mirror: { url: "https://evil" } }));
  r.submit("s");
  r.review("s", { name: "hana", kind: "human" }, true);
  assert.deepEqual(r.config.webhooks, [], "webhooks and mirrors cannot be set from a file in the repo");
  assert.equal(r.config.mirror, undefined);
});
