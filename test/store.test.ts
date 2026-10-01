import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Repo } from "../src/repo.ts";
import { Store, type BlobStore } from "../src/store.ts";

const open = (blobs?: BlobStore, inlineMax?: number) => {
  const db = new DatabaseSync(":memory:");
  const stats = { writes: 0 };
  const sql = {
    exec(q: string, ...b: any[]) {
      const stmt = db.prepare(q);
      if (/^\s*select/i.test(q)) return { toArray: () => stmt.all(...b) as any[] };
      if (/^\s*(insert|delete)/i.test(q)) stats.writes++;
      stmt.run(...b);
      return { toArray: () => [] };
    },
  };
  const tx = (fn: () => void) => {
    db.exec("BEGIN");
    try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  return { db, stats, mk: () => new Store({ sql, transactionSync: tx, blobs, inlineMax }) };
};

const norm = (v: unknown) => JSON.parse(JSON.stringify(v));

const populate = (r: Repo) => {
  r.seed({ "a.ts": "1\n2\n3", "big.txt": "x".repeat(500) });
  r.createIdentity({ name: "bot", kind: "agent" });
  r.setConfig({ checks: [{ name: "unit", command: "t" }], webhooks: [{ id: "h", url: "https://h.test", secret: "s", events: ["landed"] }] });
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "a.ts", "1\n2\nthree");
  r.write("s", "big.txt", "y".repeat(600));
  r.submit("s"); // -> verifying (check queued)
  r.open({ id: "t", agent: "c", goal: "g" });
  r.write("t", "n.ts", "new");
  r.write("t", "a.ts", null);
  r.createTask("alice", { title: "t1", body: "hi @bot", labels: ["x"] });
  r.createTag("v1", { tagger: "alice" });
  r.createRelease({ tag: "v1", title: "One", notes: "n" }, "alice");
};

test("round trip: everything survives save + load, including blobs offloaded to the blob store", async () => {
  const objs = new Map<string, string>();
  const blobs: BlobStore = { put: async (k, v) => void objs.set(k, v), get: async (k) => objs.get(k) ?? null };
  const { mk } = open(blobs, 100);
  const store = mk();
  const r = new Repo();
  populate(r);
  await store.save(r);
  assert.ok(objs.size >= 2, "large contents should be offloaded");
  const loaded = new Repo(await mk().load());
  assert.deepEqual(norm(loaded.s.files), norm(r.s.files));
  assert.deepEqual(norm(loaded.s.sessions), norm(r.s.sessions));
  assert.deepEqual(norm(loaded.s.commits), norm(r.s.commits));
  assert.deepEqual(norm(loaded.s.jobs), norm(r.s.jobs));
  assert.deepEqual(norm(loaded.s.config), norm(r.s.config));
  assert.deepEqual(norm(loaded.s.identities), norm(r.s.identities));
  assert.deepEqual(norm(loaded.s.outbox), norm(r.s.outbox));
  for (const k of ["tasks", "tags", "releases", "notifications"] as const) assert.deepEqual(norm(loaded.s[k]), norm(r.s[k]), k);
  assert.equal(loaded.s.notifications.length, 1);
  assert.equal(loaded.s.secrets.signingKey, r.s.secrets.signingKey);
  assert.equal(loaded.verifyChain().ok, true);
});

test("saves are incremental: an unrelated change writes only the rows that changed", async () => {
  const { stats, mk } = open();
  const store = mk();
  const r = new Repo();
  populate(r);
  await store.save(r);
  const before = stats.writes;
  await store.save(r);
  assert.equal(stats.writes, before, "a no-op save must write nothing");
  r.write("t", "n2.ts", "more"); // touches one session
  const { rows } = await store.save(r);
  assert.ok(rows <= 8, `expected a handful of rows, got ${rows}`);
  const again = new Repo(await mk().load());
  assert.equal(again.s.sessions.t.edits["n2.ts"], "more");
});

test("deleted jobs and landed commits persist across reloads and keep chain valid", async () => {
  const { mk } = open();
  const store = mk();
  const r = new Repo();
  r.seed({ "b.ts": "x" });
  r.setConfig({ checks: [{ name: "u", command: "t" }] });
  r.open({ id: "s", agent: "a", goal: "g" });
  r.write("s", "b.ts", "y");
  r.submit("s");
  await store.save(r);
  const r2 = new Repo(await mk().load());
  const j = r2.claimJob("run")!;
  r2.jobResult(j.id, "run", { passed: true });
  await mk().save(r2); // fresh store instance saves over the reloaded state
  const r3 = new Repo(await mk().load());
  assert.equal(r3.session("s").status, "landed");
  assert.equal(r3.head("b.ts"), "y");
  assert.equal(r3.verifyChain().ok, true);
});

test("without a blob store, oversized files fail loudly instead of corrupting", async () => {
  const { mk } = open();
  const r = new Repo();
  r.seed({ "huge.bin": "z".repeat(2_000_000) });
  await assert.rejects(() => mk().save(r), /too large/);
});

test("reset wipes persisted state so a replaced repo can be saved from scratch", async () => {
  const { mk } = open();
  const store = mk();
  const r = new Repo();
  populate(r);
  await store.save(r);
  store.reset();
  const fresh = new Repo();
  fresh.seed({ "only.ts": "x" });
  await store.save(fresh);
  const back = new Repo(await mk().load());
  assert.deepEqual(Object.keys(back.s.files), ["only.ts"]);
  assert.equal(Object.keys(back.s.sessions).length, 0);
});
