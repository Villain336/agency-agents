// Integration: the REAL git binary against handleGitRequest served by an in-process node:http server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exportFastImport } from "../src/export.ts";
import { GitView } from "../src/git/objects.ts";
import { git, land, newRepo, run, serve, tmp, withCreds } from "./git-helpers.ts";

const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag && i === 0 ? tag : ""}`).join("\n") + "\n";

function seeded() {
  const repo = newRepo();
  repo.seed({ "README.md": "# demo\n", "src/a.ts": "export const a = 1;\n", "src/deep/b.ts": "export const b = 2;\n", "f.txt": lines(12) });
  land(repo, "carol", "add util", { "src/util.ts": "export const u = 1;\n", "README.md": "# demo\nmore\n" });
  return repo;
}

async function clone(srv: { url: string }, dir: string, opts: { v0?: boolean; user?: string; pass?: string } = {}) {
  const cwd = tmp("clone");
  const url = withCreds(srv.url, opts.user ?? "alice", opts.pass ?? "tok-alice");
  const args = [...(opts.v0 ? ["-c", "protocol.version=0"] : []), "clone", url, dir];
  await git(cwd, ...args);
  return join(cwd, dir);
}

for (const v0 of [false, true]) {
  test(`clone (${v0 ? "protocol v0" : "protocol v2"}) yields the exact trunk and a clean fsck`, async () => {
    const repo = seeded();
    const srv = await serve(repo);
    try {
      const dir = await clone(srv, "w", { v0 });
      assert.equal(readFileSync(join(dir, "src/deep/b.ts"), "utf8"), "export const b = 2;\n");
      assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# demo\nmore\n");
      assert.equal((await git(dir, "rev-list", "--count", "HEAD")), "2");
      assert.equal(await git(dir, "rev-parse", "HEAD"), new GitView(repo).mainSha());
      assert.equal(await git(dir, "symbolic-ref", "--short", "HEAD"), "main");
      await git(dir, "fsck", "--strict", "--full");
      const msg = await git(dir, "log", "-1", "--format=%an|%ae|%B");
      assert.match(msg, /^carol\|carol@weave\.agents\|add util\n\nWeave-Session: carol-1\nWeave-Rev: r2/);
    } finally {
      await srv.close();
    }
  });
}

test("SHAs are deterministic and identical to `git fast-import` of the Weave export", async () => {
  const repo = seeded();
  const view1 = new GitView(repo);
  const a = view1.mainSha();
  assert.equal(new GitView(repo).mainSha(), a);
  const bare = tmp("fi");
  await git(bare, "init", "--bare", "-b", "main", ".");
  const r = await run(bare, ["fast-import", "--quiet"], exportFastImport(repo.s));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await git(bare, "rev-parse", "main"), a);
});

test("fetch picks up later landings; session refs are advertised", async () => {
  const repo = seeded();
  const srv = await serve(repo);
  try {
    const dir = await clone(srv, "w");
    land(repo, "bob", "tweak", { "src/a.ts": "export const a = 2;\n", "src/deep/b.ts": null });
    repo.open({ id: "wip", agent: "bob", goal: "work in progress" });
    repo.write("wip", "wip.txt", "draft\n");
    await git(dir, "fetch", "origin", "+refs/weave/sessions/*:refs/remotes/weave/*");
    await git(dir, "fetch");
    assert.equal(await git(dir, "rev-parse", "origin/main"), new GitView(repo).mainSha());
    assert.equal(await git(dir, "show", "origin/main:src/a.ts"), "export const a = 2;");
    assert.equal((await run(dir, ["cat-file", "-e", "origin/main:src/deep/b.ts"])).code !== 0, true);
    // session ref = base tree + overlay, parent = base commit
    assert.equal(await git(dir, "show", "weave/wip:wip.txt"), "draft");
    assert.equal(await git(dir, "show", "weave/wip:README.md"), "# demo\nmore");
    assert.equal(await git(dir, "rev-parse", "weave/wip^"), await git(dir, "rev-parse", "origin/main"));
    await git(dir, "fsck", "--strict", "--full");
    const refs = await git(dir, "ls-remote", "origin");
    assert.match(refs, /refs\/heads\/main/);
    assert.match(refs, /refs\/weave\/sessions\/wip/);
    // incremental v0 fetch too
    land(repo, "bob", "again", { "n.txt": "n\n" });
    await git(dir, "-c", "protocol.version=0", "fetch");
    assert.equal(await git(dir, "rev-parse", "origin/main"), new GitView(repo).mainSha());
    await git(dir, "fsck", "--strict", "--full");
  } finally {
    await srv.close();
  }
});

test("push to main lands (incl. thin delta pack, nested dirs, deletes); fast-forward follow-up", async () => {
  const repo = seeded();
  repo.seed({ "big.txt": lines(400) }, "add big");
  const srv = await serve(repo);
  try {
    const dir = await clone(srv, "w");
    writeFileSync(join(dir, "big.txt"), lines(400, " EDITED"));
    mkdirSync(join(dir, "pkg/x"), { recursive: true });
    writeFileSync(join(dir, "pkg/x/new.ts"), "export const n = 1;\n");
    await git(dir, "rm", "-q", "src/a.ts");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "client change");
    const before = repo.s.rev;
    const out = await run(dir, ["push", "origin", "HEAD:main"]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(repo.s.rev, before + 1);
    assert.equal(repo.head("pkg/x/new.ts"), "export const n = 1;\n");
    assert.equal(repo.head("src/a.ts"), null);
    assert.match(repo.head("big.txt") as string, /^line 1 EDITED\n/);
    const c = repo.s.commits[repo.s.commits.length - 1];
    assert.equal(c.agent, "alice");
    assert.equal(c.message, "client change");
    assert.ok(srv.persisted() >= 1);

    // the client can now fetch Weave's version of history and continue from it
    await git(dir, "fetch");
    await git(dir, "reset", "-q", "--hard", "origin/main");
    await git(dir, "fsck", "--strict", "--full");
    writeFileSync(join(dir, "second.txt"), "2\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "second");
    const p = await run(dir, ["push", "origin", "HEAD:main"]);
    assert.equal(p.code, 0, p.stderr);
    assert.equal(repo.head("second.txt"), "2\n");
    assert.equal(repo.s.rev, before + 2);
  } finally {
    await srv.close();
  }
});

test("divergent non-fast-forward push auto-merges via Weave's 3-way merge", async () => {
  const repo = seeded();
  const srv = await serve(repo);
  try {
    const A = await clone(srv, "a");
    const B = await clone(srv, "b", { user: "bob", pass: "tok-bob" });
    writeFileSync(join(A, "f.txt"), lines(12).replace("line 1\n", "line 1 by A\n"));
    await git(A, "commit", "-qam", "A edits top");
    assert.equal((await run(A, ["push", "origin", "HEAD:main"])).code, 0);

    writeFileSync(join(B, "f.txt"), lines(12).replace("line 11\n", "line 11 by B\n"));
    await git(B, "commit", "-qam", "B edits bottom");
    const plain = await run(B, ["push", "origin", "HEAD:main"]);
    assert.notEqual(plain.code, 0); // git itself refuses a non-ff push without force
    const forced = await run(B, ["push", "--force", "origin", "HEAD:main"]);
    assert.equal(forced.code, 0, forced.stderr);
    const f = repo.head("f.txt") as string;
    assert.match(f, /^line 1 by A\n/);
    assert.match(f, /line 11 by B\n/);
    const last = repo.s.commits[repo.s.commits.length - 1];
    assert.equal(last.agent, "bob");
    assert.equal(last.merged, true);
    await git(B, "fetch");
    assert.equal(await git(B, "show", "origin/main:f.txt"), f.trimEnd());
    await git(B, "fsck", "--strict", "--full");
  } finally {
    await srv.close();
  }
});

test("conflicting push is rejected with ng and left open as a session ref", async () => {
  const repo = seeded();
  const srv = await serve(repo);
  try {
    const A = await clone(srv, "a");
    const B = await clone(srv, "b", { user: "bob", pass: "tok-bob" });
    writeFileSync(join(A, "f.txt"), lines(12).replace("line 5\n", "line 5 A\n"));
    await git(A, "commit", "-qam", "A");
    assert.equal((await run(A, ["push", "origin", "HEAD:main"])).code, 0);
    const trunk = repo.head("f.txt");

    writeFileSync(join(B, "f.txt"), lines(12).replace("line 5\n", "line 5 B\n"));
    await git(B, "commit", "-qam", "B conflicts");
    const r = await run(B, ["push", "--force", "origin", "HEAD:main"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /rejected/);
    assert.match(r.stderr, /conflict in f\.txt/);
    assert.equal(repo.head("f.txt"), trunk);
    const open = Object.values(repo.s.sessions).filter((s) => s.agent === "bob");
    assert.equal(open.length, 1);
    assert.equal(open[0].status, "conflicted");
    const refs = await git(B, "ls-remote", "origin");
    assert.match(refs, new RegExp(`refs/weave/sessions/${open[0].id}$`, "m"));
    // the conflicted overlay is fetchable
    await git(B, "fetch", "origin", `refs/weave/sessions/${open[0].id}`);
    assert.equal(await git(B, "show", "FETCH_HEAD:f.txt"), lines(12).replace("line 5\n", "line 5 B\n").trimEnd());
    await git(B, "fsck", "--strict", "--full");
  } finally {
    await srv.close();
  }
});

test("push to refs/weave/sessions/x creates an overlay; re-push replaces it; delete abandons it", async () => {
  const repo = seeded();
  const srv = await serve(repo);
  try {
    const dir = await clone(srv, "w");
    const trunkRev = repo.s.rev;
    writeFileSync(join(dir, "draft.txt"), "draft\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "draft work");
    let r = await run(dir, ["push", "origin", "HEAD:refs/weave/sessions/x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(repo.s.rev, trunkRev); // trunk untouched
    let s = repo.session("x");
    assert.equal(s.status, "active");
    assert.equal(s.agent, "alice");
    assert.deepEqual(s.edits, { "draft.txt": "draft\n" });
    assert.equal(s.baseRev, trunkRev);
    assert.match(await git(dir, "ls-remote", "origin"), /refs\/weave\/sessions\/x/);

    // replace: amend so draft.txt changes and README is edited
    writeFileSync(join(dir, "draft.txt"), "draft v2\n");
    writeFileSync(join(dir, "README.md"), "# demo\nmore\nplus\n");
    await git(dir, "commit", "-qam", "more");
    r = await run(dir, ["push", "origin", "HEAD:refs/weave/sessions/x"]);
    assert.notEqual(r.code, 0); // the advertised tip is Weave's synthetic commit, so replacing needs --force
    r = await run(dir, ["push", "--force", "origin", "HEAD:refs/weave/sessions/x"]);
    assert.equal(r.code, 0, r.stderr);
    s = repo.session("x");
    assert.deepEqual(s.edits, { "draft.txt": "draft v2\n", "README.md": "# demo\nmore\nplus\n" });

    // the overlay can be landed through the normal Weave API
    const clean = repo.preview("x");
    assert.equal(clean.conflicts.length, 0);

    r = await run(dir, ["push", "origin", ":refs/weave/sessions/x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(repo.session("x").status, "rejected");
    assert.doesNotMatch(await git(dir, "ls-remote", "origin"), /sessions\/x/);
    // deleting again fails cleanly
    r = await run(dir, ["push", "origin", ":refs/weave/sessions/x"]);
    assert.notEqual(r.code, 0);
    // other refs refused
    r = await run(dir, ["push", "origin", "HEAD:refs/heads/other"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /rejected|only refs/);
  } finally {
    await srv.close();
  }
});

test("authentication: bad token, unknown user and missing credentials all fail; 401 carries WWW-Authenticate", async () => {
  const repo = seeded();
  const srv = await serve(repo);
  try {
    const cwd = tmp("auth");
    const bad = await run(cwd, ["clone", withCreds(srv.url, "alice", "wrong"), "x"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Authentication failed|401|could not read Username/i);
    const unk = await run(cwd, ["clone", withCreds(srv.url, "mallory", "tok-alice"), "y"]);
    assert.notEqual(unk.code, 0);
    const anon = await run(cwd, ["clone", srv.url, "z"]);
    assert.notEqual(anon.code, 0);
    for (const path of ["/info/refs?service=git-upload-pack", "/info/refs?service=git-receive-pack"]) {
      const res = await fetch(srv.url + path);
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Basic/);
    }
    const post = await fetch(srv.url + "/git-receive-pack", { method: "POST", body: "0000" });
    assert.equal(post.status, 401);
    // push with a bad token never mutates
    const rev = repo.s.rev;
    const dir = await clone(srv, "ok");
    writeFileSync(join(dir, "q.txt"), "q\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "q");
    const p = await run(dir, ["push", withCreds(srv.url, "alice", "nope"), "HEAD:main"]);
    assert.notEqual(p.code, 0);
    assert.equal(repo.s.rev, rev);
  } finally {
    await srv.close();
  }
});

test("empty repository can be cloned; routes outside the prefix and dumb protocol are refused", async () => {
  const repo = newRepo();
  const srv = await serve(repo);
  try {
    const cwd = tmp("empty");
    const r = await run(cwd, ["clone", withCreds(srv.url, "alice", "tok-alice"), "e"]);
    assert.equal(r.code, 0, r.stderr);
    const dir = join(cwd, "e");
    // first push into an empty repo
    writeFileSync(join(dir, "hello.txt"), "hi\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "first");
    await git(dir, "branch", "-M", "main");
    const p = await run(dir, ["push", "origin", "main"]);
    assert.equal(p.code, 0, p.stderr);
    assert.equal(repo.head("hello.txt"), "hi\n");
    const res = await fetch(srv.url.replace("/git", "/other") + "/info/refs?service=git-upload-pack");
    assert.equal(res.status, 404);
    const dumb = await fetch(srv.url + "/info/refs", { headers: { authorization: "Basic " + Buffer.from("alice:tok-alice").toString("base64") } });
    assert.equal(dumb.status, 403);
  } finally {
    await srv.close();
  }
});

test("tags are advertised, fetched by clone, and a pushed tag becomes a Weave tag", async () => {
  const repo = seeded();
  repo.createTag("v1.0.0", { tagger: "alice" });
  const srv = await serve(repo);
  try {
    const dir = await clone(srv, "w");
    assert.equal(await git(dir, "tag", "-l"), "v1.0.0");
    assert.equal(await git(dir, "rev-parse", "v1.0.0^{commit}"), new GitView(repo).mainSha());
    await git(dir, "tag", "v1.1.0");
    await git(dir, "push", "origin", "v1.1.0");
    assert.equal(repo.s.tags["v1.1.0"].rev, repo.s.rev);
    await assert.rejects(git(dir, "push", "origin", ":refs/tags/v1.0.0"), /immutable|deleted|rejected|failed/i);
    assert.ok(repo.s.tags["v1.0.0"]);
  } finally {
    await srv.close();
  }
});
