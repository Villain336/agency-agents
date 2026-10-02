import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo, WeaveError } from "../src/repo.ts";

const mk = () => {
  let t = 1_000;
  const r = new Repo(undefined, () => t);
  r.seed({ "src/a.ts": "1", "docs/x.md": "d" });
  return Object.assign(r, { advance: (ms: number) => (t += ms) });
};
const land = (r: Repo, id: string, path: string, content = "new") => {
  r.open({ id, agent: "bot", goal: id });
  r.write(id, path, content);
  return r.submit(id);
};

test("a workflow on landing queues a run for the new trunk; a runner claims it with files and finishes it", () => {
  const r = mk();
  r.setConfig({ workflows: [{ name: "build", on: ["landed"], command: "npm run build" }] });
  assert.equal(land(r, "s", "src/a.ts").status, "landed");
  const runs = r.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "landed");
  assert.equal(runs[0].rev, r.s.rev);
  const job = r.claimJob("runner-1")!;
  assert.equal(job.check, "build");
  assert.equal(job.command, "npm run build");
  assert.equal(job.files["src/a.ts"], "new", "runs see the landed trunk");
  r.jobResult(job.id, "runner-1", { passed: true, output: "ok" });
  assert.equal(r.getRun(job.id).status, "passed");
  assert.equal(r.claimJob("runner-1"), null);
});

test("path filters, tag triggers, and manual runs", () => {
  const r = mk();
  r.setConfig({ workflows: [
    { name: "docs", on: ["landed"], command: "make docs", paths: ["docs/"] },
    { name: "release", on: ["tag"], command: "make release" },
    { name: "audit", on: ["manual"], command: "npm audit" },
  ] });
  land(r, "s1", "src/a.ts");
  assert.equal(r.listRuns().length, 0, "docs workflow ignores changes outside docs/");
  land(r, "s2", "docs/x.md");
  assert.deepEqual(r.listRuns().map((x) => x.workflow), ["docs"]);
  r.createTag("v1", { tagger: "a" });
  assert.deepEqual(r.listRuns().map((x) => x.workflow).sort(), ["docs", "release"]);
  assert.equal(r.runWorkflow("audit", "alice").trigger, "manual");
  assert.throws(() => r.runWorkflow("nope", "a"), /no such workflow/);
  assert.throws(() => r.runWorkflow("docs", "a"), /not triggered manually|manual/);
});

test("expired run leases are re-queued; a run belongs to the runner that claimed it", () => {
  const r = mk();
  r.setConfig({ workflows: [{ name: "w", on: ["manual"], command: "make" }] });
  r.runWorkflow("w", "a");
  const j = r.claimJob("r1", 1000)!;
  assert.throws(() => r.jobResult(j.id, "r2", { passed: true }), (e: any) => e instanceof WeaveError && e.status === 403);
  r.advance(2000);
  assert.equal(r.claimJob("r2")!.id, j.id, "a lapsed lease is handed to another runner");
});

test("secrets reach workflow runs that name them, never check jobs; the API lists names only", () => {
  const r = mk();
  r.setSecret("DEPLOY_TOKEN", "s3cret", "admin");
  r.setSecret("OTHER", "x", "admin");
  r.setConfig({ checks: [{ name: "unit", command: "npm test" }], workflows: [{ name: "deploy", on: ["manual"], command: "make deploy", secrets: ["DEPLOY_TOKEN"] }] });
  assert.deepEqual(r.listSecrets().map((s) => s.name), ["DEPLOY_TOKEN", "OTHER"]);
  assert.ok(!JSON.stringify(r.listSecrets()).includes("s3cret"));
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "src/a.ts", "x");
  r.submit("s");
  const check: any = r.claimJob("r1")!;
  assert.equal(check.env, undefined, "agent-controlled check jobs never get secrets");
  r.jobResult(check.id, "r1", { passed: true });
  r.runWorkflow("deploy", "alice");
  const run: any = r.claimJob("r1")!;
  assert.deepEqual(run.env, { DEPLOY_TOKEN: "s3cret" }, "only the named secret is delivered");
  assert.throws(() => r.setSecret("bad name", "x", "a"), /secret name/);
  r.deleteSecret("OTHER");
  assert.equal(r.listSecrets().length, 1);
});

test("a failed workflow notifies the author of the landed change; weave.json can declare workflows (human-approved)", () => {
  const r = mk();
  r.open({ id: "c", agent: "bot", goal: "ci" });
  r.write("c", "weave.json", JSON.stringify({ workflows: [{ name: "build", on: ["landed"], command: "make" }] }));
  assert.equal(r.submit("c").status, "in_review");
  r.review("c", { name: "hana", kind: "human" }, true);
  assert.equal(r.config.workflows!.length, 1);
  land(r, "s", "src/a.ts");
  const j = r.claimJob("r1")!;
  r.jobResult(j.id, "r1", { passed: false, output: "boom" });
  assert.ok(r.notificationsFor("bot").some((n) => n.type === "workflow_failed"));
  r.open({ id: "bad", agent: "x", goal: "g" });
  r.write("bad", "weave.json", JSON.stringify({ workflows: [{ name: "w" }] }));
  assert.equal((r.submit("bad") as any).status, "active", "malformed workflows are rejected");
});
