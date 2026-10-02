import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo, matchOwnerPattern, parseCodeowners } from "../src/repo.ts";

const mk = () => {
  const r = new Repo();
  r.seed({ "src/auth/login.ts": "a", "src/ui/app.ts": "b", "docs/readme.md": "c", "CODEOWNERS": "" });
  return r;
};
const change = (r: Repo, id: string, path: string, content = "changed") => {
  r.open({ id, agent: "bot", goal: "g " + id });
  r.write(id, path, content);
  return r.submit(id);
};

test("owner patterns follow CODEOWNERS semantics", () => {
  assert.ok(matchOwnerPattern("*", "a/b.ts"));
  assert.ok(matchOwnerPattern("*.md", "docs/x.md"));
  assert.ok(!matchOwnerPattern("/*.md", "docs/x.md"));
  assert.ok(matchOwnerPattern("/*.md", "x.md"));
  assert.ok(matchOwnerPattern("src/auth/", "src/auth/deep/x.ts"));
  assert.ok(matchOwnerPattern("src/auth", "src/auth/x.ts"));
  assert.ok(matchOwnerPattern("docs/**/*.md", "docs/a/b/c.md"));
  assert.ok(!matchOwnerPattern("src/auth/", "src/ui/auth/x.ts"));
  assert.ok(matchOwnerPattern("auth/", "src/auth/x.ts"), "an unanchored directory matches at any depth");
});

test("CODEOWNERS file parsing ignores comments and keeps the last matching rule", () => {
  const rules = parseCodeowners("# c\n* @everyone\nsrc/auth/ @alice @team:sec  # trailing\n\n");
  assert.deepEqual(rules, [{ pattern: "*", owners: ["everyone"] }, { pattern: "src/auth/", owners: ["alice", "team:sec"] }]);
});

test("a change to owned paths needs approval from an owner, even when risk is low", () => {
  const r = mk();
  r.setConfig({ owners: [{ pattern: "docs/", owners: ["dora"] }] });
  assert.equal(change(r, "s1", "src/ui/app.ts").status, "landed", "unowned paths are unaffected");
  const res: any = change(r, "s2", "docs/readme.md");
  assert.equal(res.status, "in_review");
  r.review("s2", { name: "other", kind: "reviewer" }, true);
  assert.equal(r.sessionRO("s2").status, "in_review", "an approval from a non-owner does not satisfy the owner rule");
  assert.equal(r.review("s2", { name: "dora", kind: "reviewer" }, true).status, "landed");
});

test("teams expand to members; the last matching rule wins; owners are notified", () => {
  const r = mk();
  r.createTeam("sec", ["sam", "sue"], "admin");
  r.setConfig({ owners: [{ pattern: "*", owners: ["gary"] }, { pattern: "src/auth/", owners: ["team:sec"] }] });
  const res: any = change(r, "s", "src/auth/login.ts");
  assert.equal(res.status, "in_review");
  assert.ok(r.notificationsFor("sam").some((n) => n.type === "review_requested"));
  assert.equal(r.notificationsFor("gary").length, 0, "the later rule replaces the catch-all");
  assert.equal(r.review("s", { name: "sue", kind: "reviewer" }, true).status, "landed");
});

test("every owned path needs its own owner when a change spans rules", () => {
  const r = mk();
  r.setConfig({ owners: [{ pattern: "docs/", owners: ["dora"] }, { pattern: "src/auth/", owners: ["sam"] }] });
  r.open({ id: "s", agent: "bot", goal: "g" });
  r.write("s", "docs/readme.md", "x");
  r.write("s", "src/auth/login.ts", "y");
  assert.equal(r.submit("s").status, "in_review");
  assert.equal(r.review("s", { name: "dora", kind: "reviewer" }, true).status, "in_review", "one owner is not enough");
  assert.equal(r.review("s", { name: "sam", kind: "reviewer" }, true).status, "landed");
});

test("a CODEOWNERS file in the repo is honoured; config rules take precedence", () => {
  const r = mk();
  r.open({ id: "c", agent: "admin", goal: "owners" });
  r.write("c", "CODEOWNERS", "docs/ @dora\n");
  r.submit("c"); // CODEOWNERS changes themselves are reviewed by a human
  r.review("c", { name: "hana", kind: "human" }, true);
  const res: any = change(r, "s", "docs/readme.md");
  assert.equal(res.status, "in_review");
  assert.deepEqual(r.reviewPack("s").requiredOwners, [{ pattern: "docs/", owners: ["dora"], satisfied: false }]);
});

test("teams: create, update members, delete; names are validated", () => {
  const r = mk();
  r.createTeam("core", ["a"], "admin");
  assert.throws(() => r.createTeam("core", [], "admin"), /exists/);
  assert.throws(() => r.createTeam("bad name", [], "admin"), /team name/);
  r.updateTeam("core", { add: ["b"], remove: ["a"] });
  assert.deepEqual(r.getTeam("core").members, ["b"]);
  assert.equal(r.listTeams().length, 1);
  r.deleteTeam("core");
  assert.throws(() => r.getTeam("core"), /no such team/);
});
