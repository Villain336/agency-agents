// End-to-end test against a real `wrangler dev` (workerd): auth, identities, SDK, runner + checks,
// review, provenance, webhooks, MCP, real git clone/push, shards, R2 offload, and a restart.
//   npm run e2e
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Weave, WeaveError } from "../sdk/ts/weave.ts";

const PORT = 8788;
const URL_ = `http://localhost:${PORT}`;
const ADMIN = "test-admin-token";
const persist = mkdtempSync(join(tmpdir(), "weave-e2e-"));
const procs: ChildProcess[] = [];
let passed = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    console.log(`  ok   ${name}`);
    passed++;
    return r;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${(e as Error).stack?.split("\n").slice(0, 4).join("\n       ")}`);
    cleanup();
    process.exit(1);
  }
}
const rejects = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  try { await p; } catch (e) {
    assert.ok(e instanceof WeaveError, `expected WeaveError, got ${e}`);
    assert.equal((e as WeaveError).status, status, `expected ${status}, got ${(e as WeaveError).status}: ${(e as Error).message}`);
    if (re) assert.match((e as Error).message, re);
    return;
  }
  assert.fail(`expected a ${status} rejection`);
};

function startServer(): Promise<ChildProcess> {
  const p = spawn("npx", ["wrangler", "dev", "-c", "wrangler.test.jsonc", "--port", String(PORT), "--persist-to", persist, "--log-level", "warn"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  procs.push(p);
  p.stderr!.on("data", () => {});
  p.stdout!.on("data", () => {});
  return (async () => {
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(`${URL_}/health`)).ok) return p; } catch {}
      await sleep(500);
    }
    throw new Error("server did not start");
  })();
}
const stop = async (p: ChildProcess) => { try { process.kill(-p.pid!, "SIGKILL"); } catch {} await sleep(1500); };
function cleanup() { for (const p of procs) try { process.kill(-p.pid!, "SIGKILL"); } catch {}; rmSync(persist, { recursive: true, force: true }); }
process.on("exit", cleanup);

const admin = new Weave({ url: URL_, token: ADMIN });
const as = (token: string, repo = "default") => new Weave({ url: URL_, token, repo });

let server = await startServer();
console.log("server up (auth required, R2 simulated)\n");

// ---------------------------------------------------------------- auth & identities
await step("health reports auth required; API rejects anonymous callers", async () => {
  assert.equal(((await (await fetch(`${URL_}/health`)).json()) as any).auth, "required");
  assert.equal((await fetch(`${URL_}/api/state`)).status, 401);
  assert.equal((await fetch(`${URL_}/api/state`, { headers: { authorization: "Bearer nope" } })).status, 401);
});

const ids: Record<string, string> = {};
const mk = async (name: string, kind: any, extra: any = {}) => (ids[name] = (await admin.createIdentity({ name, kind, ...extra })).token);
await step("admin creates scoped identities", async () => {
  await mk("alice", "agent", { model: "claude-test" });
  await mk("bob", "agent", { paths: ["src/web/"], budget: { sessionsPerHour: 50 } });
  await mk("carol", "agent");
  await mk("rev", "reviewer");
  await mk("hana", "human");
  await mk("vera", "verifier");
  await mk("run1", "runner");
});
const alice = as(ids.alice), bob = as(ids.bob), carol = as(ids.carol), rev = as(ids.rev), hana = as(ids.hana), vera = as(ids.vera);

await step("scopes: agents cannot admin, runners cannot write, verifiers cannot review", async () => {
  await rejects(alice.createIdentity({ name: "evil", kind: "admin" }), 403, /scope/);
  await rejects(as(ids.run1).open({ goal: "x" }), 403);
  await rejects(vera.review("nope", true), 403);
});

// ---------------------------------------------------------------- project + checks
const project: Record<string, string> = {
  "sum.js": "exports.sum = (a, b) => a + b;\n",
  "sum.test.js": "const t = require('node:test'), assert = require('node:assert'), { sum } = require('./sum.js');\nt('sum', () => assert.equal(sum(2, 3), 5));\n",
  "src/web/app.js": "// web app\nexports.title = 'Shop';\n",
  "src/auth.js": "exports.login = (u, p) => p === 'hunter2';\n",
  "README.md": "# Demo\n",
};
await step("import a project and configure checks, protected paths and a webhook", async () => {
  await admin.request("POST", "import", { files: project, message: "initial import" });
  await admin.configure({ checks: [{ name: "unit", command: "node --test", timeoutMs: 60000 }], reviewPaths: ["src/auth"] });
});

const runner = spawn("node", ["scripts/runner.ts", "--url", URL_, "--token", ids.run1, "--name", "run1"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
procs.push(runner);
let runnerLog = "";
runner.stdout!.on("data", (d) => (runnerLog += d));

await step("a change is gated on checks: verifying -> runner passes -> auto-lands, provenance records evidence", async () => {
  const s = await alice.open({ goal: "make sum variadic", intent: ["sum.js"], model: "claude-test", prompt: "do the thing" });
  await alice.write(s.id, "sum.js", "exports.sum = (...n) => n.reduce((a, b) => a + b, 0);\n");
  const r = await alice.submit(s.id);
  assert.equal(r.status, "verifying");
  assert.equal(await alice.waitForLanding(s.id), "landed");
  const sess = await alice.session(s.id);
  assert.equal(sess.evidence[0].passed, true);
  const prov = await alice.provenance(sess.landedRev);
  assert.equal(prov.record.actor.name, "alice");
  assert.equal(prov.record.actor.model, "claude-test");
  assert.equal(prov.record.evidence[0].check, "unit");
  assert.equal(prov.record.promptHash.length, 64);
  assert.equal(prov.signature.length, 64);
});

await step("a failing change is sent back with the test output; the fix then lands", async () => {
  const s = await carol.open({ goal: "break sum", intent: ["sum.js"] });
  await carol.write(s.id, "sum.js", "exports.sum = (...n) => 0;\n");
  assert.equal((await carol.submit(s.id)).status, "verifying");
  for (let i = 0; i < 60 && (await carol.session(s.id)).status === "verifying"; i++) await sleep(500);
  const failed = await carol.session(s.id);
  assert.equal(failed.status, "active");
  assert.equal(failed.evidence.at(-1).passed, false);
  assert.match(failed.evidence.at(-1).output, /not ok|fail|exit 1/i);
  await carol.write(s.id, "sum.js", "exports.sum = (...n) => n.reduce((a, b) => a + b, 0) | 0;\n");
  await carol.submit(s.id);
  assert.equal(await carol.waitForLanding(s.id), "landed");
});

// ---------------------------------------------------------------- enforcement
await step("path scopes, ownership and impersonation are enforced", async () => {
  const s = await bob.open({ goal: "web tweak", intent: ["src/web/app.js"], agent: "someone-else" } as any);
  assert.equal((await bob.session(s.id)).agent, "bob"); // body cannot spoof identity
  await rejects(bob.write(s.id, "sum.js", "x"), 403, /may not write/);
  await rejects(carol.write(s.id, "src/web/app.js", "x"), 403, /belongs to bob/);
  await bob.write(s.id, "src/web/app.js", "// web app\nexports.title = 'Shop v2';\n");
  assert.equal((await bob.submit(s.id)).status, "verifying");
  assert.equal(await bob.waitForLanding(s.id), "landed");
});

await step("risk-tiered review: protected path needs a reviewer; agents cannot approve their own work; separation of duties", async () => {
  const s = await alice.open({ goal: "harden login", intent: ["src/auth.js"] });
  await alice.write(s.id, "src/auth.js", "exports.login = (u, p) => require('node:crypto').timingSafeEqual(Buffer.from(p), Buffer.from('x'));\n");
  await alice.submit(s.id);
  for (let i = 0; i < 60 && (await alice.session(s.id)).status === "verifying"; i++) await sleep(500);
  assert.equal((await alice.session(s.id)).status, "in_review");
  await rejects(alice.review(s.id, true), 403); // lacks review scope
  const queue = await rev.reviewQueue();
  assert.ok(queue.next.some((q: any) => q.id === s.id));
  const pack = await rev.reviewPack(s.id);
  assert.ok(pack.risk.score >= 30 && pack.files[0].patch.includes("@@"));
  await rev.comment(s.id, { path: "src/auth.js", line: 1, body: "compare lengths first", blocking: true });
  await rejects(rev.review(s.id, true), 409, /blocking/);
  const th = (await rev.request("GET", `sessions/${s.id}/comments`))[0];
  await rev.request("POST", `sessions/${s.id}/comments/${th.id}/resolve`);
  const res = await rev.review(s.id, true);
  assert.equal(res.status, "landed");
  assert.deepEqual((await alice.provenance((await alice.session(s.id)).landedRev)).record.approvals.map((a: any) => a.by), ["rev"]);
});

await step("high-risk changes need a human: a reviewer agent's approval is not enough", async () => {
  await admin.configure({ policy: { humanAbove: 20 } });
  const s = await alice.open({ goal: "risky auth change", intent: ["src/auth.js"] });
  await alice.write(s.id, "src/auth.js", "exports.login = () => true;\n");
  await alice.submit(s.id);
  for (let i = 0; i < 60 && (await alice.session(s.id)).status === "verifying"; i++) await sleep(500);
  assert.equal((await rev.review(s.id, true)).status, "in_review");
  assert.equal((await hana.review(s.id, true)).status, "landed");
  await admin.configure({ policy: { humanAbove: 70 } });
});

await step("concurrent agents on one file: auto-merge, semantic gate, verifier attestation", async () => {
  await admin.configure({ checks: [] }); // isolate the semantic gate from runner timing
  await admin.request("POST", "import", { files: { "lib.js": "function price(x) {\n  return x * 2;\n}\n\nfunction total(x) {\n  return price(x) + 1;\n}\n" }, message: "lib" });
  const a = await alice.open({ goal: "price takes tax", intent: ["lib.js"] });
  const c = await carol.open({ goal: "total adds fee", intent: ["lib.js"] });
  await alice.write(a.id, "lib.js", "function price(x, tax) {\n  return x * 2 + tax;\n}\n\nfunction total(x) {\n  return price(x) + 1;\n}\n");
  await carol.write(c.id, "lib.js", "function price(x) {\n  return x * 2;\n}\n\nfunction total(x) {\n  return price(x) + 1 + 5;\n}\n");
  assert.equal((await alice.submit(a.id)).status, "landed");
  const second = await carol.submit(c.id);
  assert.equal(second.status, "needs_verify");
  assert.equal((second.risks as any[])[0].kind, "dependency");
  await rejects(carol.verify(c.id, true), 403); // no verify scope
  const after = await vera.verify(c.id, true);
  assert.ok(["landed", "in_review"].includes(after.status));
  await admin.configure({ checks: [{ name: "unit", command: "node --test", timeoutMs: 60000 }] });
});

// ---------------------------------------------------------------- webhooks
await step("webhooks: signed, delivered with retries", async () => {
  const got: any[] = [];
  let fail = true;
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      if (fail) { fail = false; res.statusCode = 500; return res.end(); }
      const sig = req.headers["x-weave-signature"];
      got.push({ ok: sig === "sha256=" + createHmac("sha256", "whsec").update(b).digest("hex"), type: req.headers["x-weave-event"], body: JSON.parse(b) });
      res.end("ok");
    });
  }).listen(8799);
  await admin.configure({ webhooks: [{ id: "h1", url: "http://localhost:8799/hook", secret: "whsec", events: ["landed"] }] });
  await admin.configure({ checks: [] });
  const s = await alice.open({ goal: "docs", intent: ["README.md"] });
  await alice.write(s.id, "README.md", "# Demo\nmore\n");
  assert.equal((await alice.submit(s.id)).status, "landed");
  for (let i = 0; i < 40 && !got.length; i++) await sleep(500);
  srv.close();
  assert.ok(got.length >= 1, "webhook was never delivered after a failed first attempt");
  assert.equal(got[0].ok, true, "signature must verify");
  assert.equal(got[0].type, "landed");
  assert.equal(got[0].body.event.agent, "alice");
  await admin.configure({ webhooks: [] });
  await admin.configure({ checks: [{ name: "unit", command: "node --test", timeoutMs: 60000 }] });
});

// ---------------------------------------------------------------- MCP
await step("MCP: an agent uses Weave purely through JSON-RPC tools with its own token", async () => {
  const rpc = async (method: string, params?: any, id = 1) => (await (await fetch(`${URL_}/mcp`, { method: "POST", headers: { authorization: `Bearer ${ids.alice}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json()) as any;
  assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.serverInfo.name, "weave");
  assert.ok((await rpc("tools/list")).result.tools.length >= 20);
  const call = async (name: string, args: any) => { const r = await rpc("tools/call", { name, arguments: args }); return { err: r.result.isError, v: JSON.parse(r.result.content[0].text) }; };
  const { v: o } = await call("weave_open_session", { goal: "mcp edit", intent: ["README.md"] });
  assert.equal(o.session.agent, "alice");
  await call("weave_write_file", { session: o.session.id, path: "README.md", content: "# Demo\nvia mcp\n" });
  const sub = await call("weave_submit", { session: o.session.id });
  assert.ok(["verifying", "landed"].includes(sub.v.status));
  assert.equal((await fetch(`${URL_}/mcp`, { method: "POST", body: "{}" })).status, 401);
  const bad = await call("weave_session", { session: "does-not-exist" });
  assert.equal(bad.err, true);
});

// ---------------------------------------------------------------- git
await step("real git: clone, commit and push land through Weave with the pusher's identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-git-"));
  const url = `http://carol:${ids.carol}@localhost:${PORT}/git/default`;
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Carol", "-c", "user.email=c@x.test", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["clone", "-q", url, dir]);
  assert.equal(readFileSync(join(dir, "sum.js"), "utf8").includes("reduce"), true);
  git("fsck", "--strict");
  writeFileSync(join(dir, "NOTES.md"), "pushed from git\n");
  git("add", "-A");
  git("commit", "-qm", "notes via git");
  let out = "";
  try { out = git("push", "-q", "origin", "HEAD:main"); } catch (e: any) { out = String(e.stderr); }
  for (let i = 0; i < 40; i++) { if ((await carol.readTrunk("NOTES.md")) === "pushed from git\n") break; await sleep(500); } // checks are on, so it may take the check queue
  const state = await carol.status();
  const landed = (await carol.readTrunk("NOTES.md")) === "pushed from git\n";
  if (!landed) {
    // with required checks configured, a push can't land synchronously: it is left open as a session ref
    assert.match(out, /queued for required checks|checks/i, `unexpected push result: ${out}`);
    for (let i = 0; i < 60 && (await carol.readTrunk("NOTES.md")) !== "pushed from git\n"; i++) await sleep(500);
  }
  assert.equal(await carol.readTrunk("NOTES.md"), "pushed from git\n");
  const hist = await carol.history(3);
  assert.equal(hist[0].agent, "carol");
  void state;
  await rejects((async () => { try { execFileSync("git", ["clone", "-q", `http://carol:wrong@localhost:${PORT}/git/default`, dir + "-bad"], { stdio: "pipe" }); } catch { throw new WeaveError("clone refused", 401); } })(), 401);
});

// ---------------------------------------------------------------- python SDK
await step("python SDK works against the live server", async () => {
  const code = `
import sys; sys.path.insert(0, "sdk/python")
from weave import Weave, WeaveError
w = Weave("${URL_}", token="${ids.alice}")
assert "sum.js" in w.files()
s = w.open(goal="py edit", intent=["README.md"])
w.write(s["id"], "README.md", "# Demo\\nfrom python\\n")
r = w.submit(s["id"])
assert r["status"] in ("landed", "verifying"), r
try:
    Weave("${URL_}", token="bad").status()
    raise SystemExit("expected auth failure")
except WeaveError as e:
    assert e.status == 401
print("python ok")
`;
  assert.match(execFileSync("python3", ["-c", code], { encoding: "utf8" }), /python ok/);
});

// ---------------------------------------------------------------- shards
await step("sharded repo: sessions on different shards land independently with their own revisions", async () => {
  const sh = "sharded";
  const adm = as(ADMIN, sh); // identities are per repository, so mint one for this repo
  const A = as((await adm.createIdentity({ name: "alice", kind: "agent" })).token, sh);
  await adm.configure({ shards: { web: ["web/"], api: ["api/"] } });
  await adm.request("POST", "import", { files: { "web/a.js": "1\n", "api/b.js": "2\n", "README.md": "x\n" }, message: "seed" });
  const sw = await A.open({ goal: "web", intent: ["web/a.js"] });
  const sa = await adm.open({ goal: "api", intent: ["api/b.js"], agent: "root" });
  assert.match(sw.id, /^web~/);
  assert.match(sa.id, /^api~/);
  await rejects(A.write(sw.id, "api/b.js", "nope"), 409, /belongs to shard "api"/);
  await A.write(sw.id, "web/a.js", "11\n");
  await adm.write(sa.id, "api/b.js", "22\n");
  assert.equal((await A.submit(sw.id)).status, "landed");
  assert.equal((await adm.submit(sa.id)).status, "landed");
  const st = await adm.request("GET", "state");
  assert.ok(st.shards.web >= 2 && st.shards.api >= 2);
  assert.equal(st.files["web/a.js"], "11\n");
  assert.equal(st.files["api/b.js"], "22\n");
});

// ---------------------------------------------------------------- scale: R2 offload + restart
const big = "line of text that is reasonably long to be useful\n".repeat(4000); // ~200 KB
await step("large files are offloaded to R2 and land correctly", async () => {
  await admin.configure({ checks: [] });
  const s = await alice.open({ goal: "add big file", intent: ["big.txt"] });
  await alice.write(s.id, "big.txt", big);
  const sub = await alice.submit(s.id);
  assert.equal(sub.status, "in_review"); // a 4,000-line addition is not low risk
  assert.equal((await hana.review(s.id, true)).status, "landed");
  assert.equal(await alice.readTrunk("big.txt"), big);
});

await step("provenance chain and audit log verify before restart", async () => {
  const p = await admin.request("GET", "provenance");
  assert.equal(p.chain.ok, true);
  assert.equal(p.audit.ok, true);
});
const before = await admin.request("GET", "state");

await stop(runner);
await stop(server);
server = await startServer();
await step("restart: all state reloads from SQLite + R2 (files, sessions, identities, chain)", async () => {
  const after = await admin.request("GET", "state");
  assert.equal(after.rev, before.rev);
  assert.deepEqual(after.files, before.files);
  assert.equal(after.files["big.txt"], big);
  assert.equal((await admin.request("GET", "provenance")).chain.ok, true);
  assert.equal((await alice.status()).rev, before.rev);
  assert.equal((await as(ids.alice).session(Object.values<any>(before.sessions).find((x) => x.agent === "alice").id)).agent, "alice"); // identities survived and still authenticate
  assert.equal((await admin.request("GET", "identities")).length >= 7, true);
});

console.log(`\n${passed} end-to-end checks passed`);
cleanup();
process.exit(0);
