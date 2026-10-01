import { test } from "node:test";
import assert from "node:assert/strict";
import { route, requiredScopes, openActor } from "../src/api.ts";
import { Repo } from "../src/repo.ts";

const call = (repo: Repo, method: string, path: string, body: any = {}, actor = openActor("t")) => {
  const url = new URL("http://x/api/" + path);
  return route({ repo, actor, method, parts: url.pathname.split("/").filter(Boolean).slice(1), url, body }) as any;
};

test("scope map: reads, writes, review, verify, runner, admin", () => {
  assert.deepEqual(requiredScopes("GET", ["state"]), ["read"]);
  assert.deepEqual(requiredScopes("POST", ["sessions"]), ["write"]);
  assert.deepEqual(requiredScopes("POST", ["sessions", "s", "submit"]), ["write"]);
  assert.deepEqual(requiredScopes("POST", ["sessions", "s", "review"]), ["review"]);
  assert.deepEqual(requiredScopes("POST", ["sessions", "s", "verify"]), ["verify"]);
  assert.deepEqual(requiredScopes("POST", ["runner", "claim"]), ["runner"]);
  assert.deepEqual(requiredScopes("POST", ["identities"]), ["admin"]);
  assert.deepEqual(requiredScopes("GET", ["identities"]), ["admin"]);
  assert.deepEqual(requiredScopes("POST", ["config"]), ["admin"]);
});

test("authenticated actors cannot impersonate: names come from the identity, not the body", () => {
  const repo = new Repo();
  repo.seed({ "a.ts": "1" });
  const { token } = repo.createIdentity({ name: "real", kind: "agent" });
  const actor = repo.authenticate(token)!;
  const out = call(repo, "POST", "sessions", { id: "s", agent: "spoofed", goal: "g" }, actor);
  assert.equal(out.session.agent, "real");
  // a reviewer identity claiming kind:"human" in the body must not satisfy a human-approval requirement
  repo.setConfig({ policy: { humanAbove: 1 } });
  repo.write("s", "src/auth.ts", "export const x = 1;\n", actor);
  assert.equal(call(repo, "POST", "sessions/s/submit", {}, actor).status, "in_review");
  const bot = repo.authenticate(repo.createIdentity({ name: "rv", kind: "reviewer" }).token)!;
  assert.equal(call(repo, "POST", "sessions/s/review", { approve: true, kind: "human", reviewer: "alice" }, bot).status, "in_review");
  const human = repo.authenticate(repo.createIdentity({ name: "alice", kind: "human" }).token)!;
  assert.equal(call(repo, "POST", "sessions/s/review", { approve: true }, human).status, "landed");
});

test("reset keeps identities and config but clears content and sessions", () => {
  const repo = new Repo();
  repo.seed({ "a.ts": "1" });
  repo.createIdentity({ name: "keep", kind: "agent" });
  repo.setConfig({ checks: [{ name: "u", command: "t" }] });
  call(repo, "POST", "sessions", { id: "s", agent: "a", goal: "g" });
  let fresh: Repo | undefined;
  const url = new URL("http://x/api/reset");
  route({ repo, actor: openActor(), method: "POST", parts: ["reset"], url, body: { empty: true }, replace: (r) => (fresh = r) });
  assert.equal(Object.keys(fresh!.s.sessions).length, 0);
  assert.equal(fresh!.s.rev, 0);
  assert.equal(fresh!.listIdentities().length, 1);
  assert.equal(fresh!.config.checks.length, 1);
});

test("state/jobs responses never leak token hashes or webhook secrets", () => {
  const repo = new Repo();
  repo.createIdentity({ name: "x", kind: "agent" });
  repo.setConfig({ webhooks: [{ id: "h", url: "https://h.test", secret: "topsecret", events: ["*"] }] });
  const blob = JSON.stringify([call(repo, "GET", "state"), call(repo, "GET", "identities"), call(repo, "GET", "config"), call(repo, "GET", "status")]);
  assert.ok(!blob.includes("topsecret"));
  assert.ok(!blob.includes("tokenHash"));
  assert.ok(!blob.includes(repo.s.secrets.signingKey));
});

test("runner routes: claim a job and report its result through the router", () => {
  const repo = new Repo();
  repo.seed({ "b.ts": "x" });
  repo.setConfig({ checks: [{ name: "unit", command: "t" }] });
  call(repo, "POST", "sessions", { id: "s", agent: "a", goal: "g" });
  call(repo, "POST", "sessions/s/file", { path: "b.ts", content: "y" });
  assert.equal(call(repo, "POST", "sessions/s/submit").status, "verifying");
  const { job } = call(repo, "POST", "runner/claim", { runner: "r1" });
  assert.equal(job.files["b.ts"], "y");
  call(repo, "POST", `runner/jobs/${job.id}/result`, { runner: "r1", passed: true, output: "ok" });
  assert.equal(repo.session("s").status, "landed");
});

test("null optional fields (as sent by the Python SDK) mean 'not provided'", () => {
  const repo = new Repo();
  repo.seed({ "a.ts": "1" });
  const out = call(repo, "POST", "sessions", { id: "s", agent: "a", goal: "g", baseRev: null, model: null, intent: null });
  assert.equal(out.session.baseRev, 1);
  call(repo, "POST", "sessions/s/file", { path: "a.ts", content: "2", basedOn: null });
  assert.equal(call(repo, "POST", "sessions/s/submit", { message: null }).status, "landed");
});
