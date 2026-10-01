import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, openActor } from "../src/api.ts";
import { routeBrowse, blame, search, stats, BLAME_MAX_LINES, BLAME_MAX_VERSIONS } from "../src/browse.ts";
import { exportFastImport } from "../src/export.ts";
import { Repo, WeaveError } from "../src/repo.ts";

let seq = 0;
/** Land one commit made of several edits (null = delete). */
function land(repo: Repo, agent: string, edits: Record<string, string | null>, message: string) {
  const id = `s${++seq}`;
  repo.open({ id, agent, goal: message });
  for (const [p, c] of Object.entries(edits)) repo.write(id, p, c);
  return repo.submit(id, message);
}

const get = (repo: Repo, path: string): any => {
  const url = new URL("http://x/api/" + path);
  return route({ repo, actor: openActor("t"), method: "GET", parts: url.pathname.split("/").filter(Boolean).slice(1), url, body: {} });
};
const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WeaveError) return e.status;
    throw e;
  }
  return 0;
};

function fixture() {
  let t = 1000;
  const repo = new Repo(undefined, () => (t += 1000));
  repo.seed({ "README.md": "# Hi\nline two\n", "src/a.ts": "a1\na2\na3\n", "src/lib/b.ts": "b1\n", "docs/x.md": "x\n", "data.bin": "ab\u0000cd" }, "initial import"); // r1
  land(repo, "alice", { "src/a.ts": "a1\na2 changed\na3\na4\n" }, "edit a"); // r2
  land(repo, "bob", { "src/lib/b.ts": "b1\nb2\n", "docs/x.md": null }, "edit b, drop x"); // r3
  land(repo, "alice", { "src/new/c.ts": "c1\n", "src/a.ts": null }, "add c, remove a"); // r4 (rename-ish: delete + add)
  return repo;
}

test("tree: root, subdirs, last-change attribution, deleted files hidden, historical rev", () => {
  const repo = fixture();
  const t = get(repo, "tree");
  assert.equal(t.rev, 4);
  assert.equal(t.path, "");
  assert.deepEqual(t.entries.map((e: any) => `${e.type}:${e.name}`), ["dir:src", "file:README.md", "file:data.bin"]); // docs/ is gone (x.md deleted)
  const src = t.entries[0];
  assert.equal(src.path, "src");
  assert.equal(src.lastRev, 4);
  assert.equal(src.lastAgent, "alice");
  assert.equal(src.lastMessage, "add c, remove a");
  assert.equal(typeof src.lastTs, "number");
  assert.equal(src.size, undefined);
  const readme = t.entries[1];
  assert.equal(readme.lastRev, 1);
  assert.equal(readme.lastAgent, "system");
  assert.equal(readme.size, 14);

  const s = get(repo, "tree?path=src");
  assert.deepEqual(s.entries.map((e: any) => `${e.type}:${e.path}:${e.lastRev}`), ["dir:src/lib:3", "dir:src/new:4"]); // a.ts deleted
  assert.deepEqual(get(repo, "tree?path=src/lib/").entries.map((e: any) => [e.path, e.lastRev, e.lastAgent]), [["src/lib/b.ts", 3, "bob"]]);

  // historical: r2 has src/a.ts modified by alice and docs/x.md
  const old = get(repo, "tree?path=src&rev=2");
  assert.deepEqual(old.entries.map((e: any) => [e.name, e.type, e.lastRev]), [["lib", "dir", 1], ["a.ts", "file", 2]]);
  assert.deepEqual(get(repo, "tree?rev=r2").entries.map((e: any) => e.name), ["docs", "src", "README.md", "data.bin"]);
  assert.deepEqual(get(repo, "tree?rev=0").entries, []);
  // a directory touched only by a deletion still reports that commit while other files remain
  const r = new Repo();
  r.seed({ "d/a": "1", "d/b": "2" });
  land(r, "z", { "d/a": null }, "rm a");
  assert.equal(get(r, "tree").entries[0].lastRev, 2);
});

test("tree: errors", () => {
  const repo = fixture();
  assert.equal(status(() => get(repo, "tree?path=nope")), 404);
  assert.equal(status(() => get(repo, "tree?path=docs")), 404); // only deleted files
  assert.equal(status(() => get(repo, "tree?path=README.md")), 400);
  assert.equal(status(() => get(repo, "tree?path=../etc")), 400);
  assert.equal(status(() => get(repo, "tree?path=a//b")), 400);
  assert.equal(status(() => get(repo, "tree?rev=abc")), 400);
  assert.equal(status(() => get(repo, "tree?rev=99")), 404);
  assert.equal(status(() => get(repo, "tree?path=src&rev=0")), 404);
});

test("blob: content, language, size, lines, historical and deleted files", () => {
  const repo = fixture();
  const b = get(repo, "blob?path=src/lib/b.ts");
  assert.deepEqual(b, { path: "src/lib/b.ts", rev: 4, size: 6, lines: 2, content: "b1\nb2\n", language: "ts" });
  assert.equal(get(repo, "blob?path=src/lib/b.ts&rev=1").content, "b1\n");
  assert.equal(get(repo, "blob?path=README.md").language, "md");
  assert.equal(get(repo, "blob?path=src/a.ts&rev=2").lines, 4);
  assert.equal(get(repo, "blob?path=data.bin").language, "text");
  assert.equal(get(repo, "blob?path=docs/x.md&rev=1").content, "x\n");
  assert.equal(status(() => get(repo, "blob?path=docs/x.md")), 404); // deleted at head
  assert.equal(status(() => get(repo, "blob?path=src/a.ts")), 404);
  assert.equal(status(() => get(repo, "blob?path=src")), 400); // directory
  assert.equal(status(() => get(repo, "blob")), 400);
  assert.equal(status(() => get(repo, "blob?path=zzz")), 404);
  assert.equal(status(() => get(repo, "blob?path=README.md&rev=x1")), 400);
  assert.equal(status(() => get(repo, "blob?path=README.md&rev=50")), 404);
  assert.equal(get(new Repo(), "tree").entries.length, 0);
});

test("history: ordering, path filter (file and directory), pagination, hasMore", () => {
  const repo = fixture();
  const h = get(repo, "history");
  assert.deepEqual(h.commits.map((c: any) => c.rev), [4, 3, 2, 1]);
  assert.equal(h.hasMore, false);
  assert.deepEqual(Object.keys(h.commits[0]).sort(), ["agent", "hash", "merged", "message", "paths", "rev", "risk", "ts"]);
  assert.deepEqual(h.commits[0].paths.sort(), ["src/a.ts", "src/new/c.ts"]);
  assert.equal(h.commits[0].hash.length > 10, true);
  assert.deepEqual(get(repo, "history?path=src/a.ts").commits.map((c: any) => c.rev), [4, 2, 1]); // includes the deletion
  assert.deepEqual(get(repo, "history?path=src").commits.map((c: any) => c.rev), [4, 3, 2, 1]);
  assert.deepEqual(get(repo, "history?path=src/lib").commits.map((c: any) => c.rev), [3, 1]);
  assert.deepEqual(get(repo, "history?path=sr").commits, []); // prefix must end at a path boundary
  const p1 = get(repo, "history?limit=2");
  assert.deepEqual(p1.commits.map((c: any) => c.rev), [4, 3]);
  assert.equal(p1.hasMore, true);
  const p2 = get(repo, "history?limit=2&before=3");
  assert.deepEqual(p2.commits.map((c: any) => c.rev), [2, 1]);
  assert.equal(p2.hasMore, false);
  assert.deepEqual(get(repo, "history?limit=1&before=r2").commits.map((c: any) => c.rev), [1]);
  assert.deepEqual(get(repo, "history?before=1").commits, []);
  assert.equal(status(() => get(repo, "history?limit=x")), 400);
  assert.equal(status(() => get(repo, "history?before=zz")), 400);
  assert.equal(status(() => get(repo, "history?path=..")), 400);
  // limits: default 30, max 200
  const big = new Repo();
  big.seed({ f: "0" });
  for (let i = 1; i < 250; i++) land(big, "a", { f: String(i) }, `c${i}`);
  assert.equal(get(big, "history").commits.length, 30);
  assert.equal(get(big, "history").hasMore, true);
  assert.equal(get(big, "history?limit=9999").commits.length, 200);
  assert.equal(get(big, "history?limit=9999").hasMore, true);
  assert.equal(get(big, "history?limit=200&before=51").commits.length, 50);
  assert.equal(get(big, "history?limit=200&before=51").hasMore, false);
});

test("commit: diff against previous revision; first revision against empty; deleted files; unknown revs", () => {
  const repo = fixture();
  const c1 = get(repo, "commit/1");
  assert.equal(c1.commit.rev, 1);
  assert.equal(c1.commit.agent, "system");
  assert.deepEqual(c1.commit.approvals, []);
  assert.deepEqual(c1.commit.evidence, []);
  assert.equal(c1.files.length, 5);
  assert.ok(c1.files.every((f: any) => f.status === "added" && f.removed === 0));
  assert.match(c1.files.find((f: any) => f.path === "src/a.ts").patch, /^--- \/dev\/null\n\+\+\+ b\/src\/a\.ts\n@@ -1,0 \+1,4 @@\n\+a1/);

  const c2 = get(repo, "commit/r2");
  assert.equal(c2.files.length, 1);
  assert.deepEqual([c2.files[0].status, c2.files[0].added, c2.files[0].removed], ["modified", 2, 1]);
  assert.match(c2.files[0].patch, /-a2\n\+a2 changed/);

  const c3 = get(repo, "commit/3");
  assert.deepEqual(c3.files.map((f: any) => [f.path, f.status]), [["docs/x.md", "deleted"], ["src/lib/b.ts", "modified"]]);
  assert.match(c3.files[0].patch, /\+\+\+ \/dev\/null/);
  const c4 = get(repo, "commit/4");
  assert.deepEqual(c4.files.map((f: any) => [f.path, f.status]), [["src/a.ts", "deleted"], ["src/new/c.ts", "added"]]);
  assert.equal(c4.commit.risk, repo.s.commits[3].provenance?.risk?.tier);
  assert.equal(c4.commit.hash, repo.s.commits[3].hash);
  assert.equal(status(() => get(repo, "commit/9")), 404);
  assert.equal(status(() => get(repo, "commit/0")), 404);
  assert.equal(status(() => get(repo, "commit/abc")), 400);
});

test("commit: provenance approvals and evidence are surfaced", () => {
  const repo = new Repo();
  repo.seed({ "a.ts": "1" });
  repo.setConfig({ checks: [{ name: "t", command: "true" }] });
  repo.open({ id: "p", agent: "bot", goal: "g" });
  repo.write("p", "a.ts", "2");
  repo.submit("p", "m");
  const job = repo.claimJob("runner");
  assert.ok(job);
  repo.jobResult(job!.id, "runner", { passed: true });
  const c = get(repo, "commit/2");
  assert.equal(c.commit.evidence.length, 1);
  assert.equal(c.commit.evidence[0].check, "t");
  assert.equal(c.commit.evidence[0].passed, true);
});

test("diff: between revisions, path filter, defaults, reversed, errors", () => {
  const repo = fixture();
  const d = get(repo, "diff?from=1&to=4");
  assert.equal(d.from, 1);
  assert.equal(d.to, 4);
  assert.deepEqual(d.files.map((f: any) => [f.path, f.status]), [["docs/x.md", "deleted"], ["src/a.ts", "deleted"], ["src/lib/b.ts", "modified"], ["src/new/c.ts", "added"]]);
  assert.deepEqual(get(repo, "diff?from=1&to=4&path=src/lib").files.map((f: any) => f.path), ["src/lib/b.ts"]);
  assert.deepEqual(get(repo, "diff?from=1&to=4&path=src/lib/b.ts").files.map((f: any) => f.added), [1]);
  assert.deepEqual(get(repo, "diff?from=0&to=1").files.length, 5);
  assert.deepEqual(get(repo, "diff?from=2&to=2").files, []);
  assert.deepEqual(get(repo, "diff").files.map((f: any) => f.path), ["src/a.ts", "src/new/c.ts"]); // head vs previous
  assert.equal(get(repo, "diff?to=2").from, 1);
  const rev = get(repo, "diff?from=4&to=3"); // reversed: re-adds a.ts
  assert.deepEqual(rev.files.map((f: any) => [f.path, f.status]), [["src/a.ts", "added"], ["src/new/c.ts", "deleted"]]);
  // a file added and deleted inside the range does not show up
  const r = new Repo();
  r.seed({ k: "1" });
  land(r, "a", { tmp: "x" }, "add tmp");
  land(r, "a", { tmp: null }, "rm tmp");
  assert.deepEqual(get(r, "diff?from=1&to=3").files, []);
  assert.equal(status(() => get(repo, "diff?from=1&to=99")), 404);
  assert.equal(status(() => get(repo, "diff?from=x&to=2")), 400);
  assert.equal(status(() => get(repo, "diff?from=1&to=2&path=/../a")), 400);
});

test("blame: attribution, re-added identical text belongs to the new commit, deletion resets, historical rev", () => {
  const repo = new Repo();
  repo.seed({ "f.ts": "a\nb\nc\n" }); // r1
  land(repo, "u1", { "f.ts": "a\nb2\nc\nd\n" }, "m2"); // r2: b changed, d added
  land(repo, "u2", { "f.ts": "a\nc\nd\n" }, "m3"); // r3: b2 removed
  land(repo, "u3", { "f.ts": "a\nb2\nc\nd\n" }, "m4"); // r4: b2 re-added (same text as r2) -> r4
  const bl = get(repo, "blame?path=f.ts");
  assert.deepEqual(bl.lines.map((l: any) => [l.n, l.text, l.rev, l.agent]), [[1, "a", 1, "system"], [2, "b2", 4, "u3"], [3, "c", 1, "system"], [4, "d", 2, "u1"]]);
  assert.equal(bl.lines[1].message, "m4");
  assert.equal(typeof bl.lines[1].ts, "number");
  assert.deepEqual(get(repo, "blame?path=f.ts&rev=2").lines.map((l: any) => l.rev), [1, 2, 1, 2]);
  assert.deepEqual(get(repo, "blame?path=f.ts&rev=3").lines.map((l: any) => l.rev), [1, 1, 2]);
  // delete then re-add: every line is new
  land(repo, "u4", { "f.ts": null }, "rm");
  land(repo, "u5", { "f.ts": "a\nc\n" }, "readd");
  assert.deepEqual(get(repo, "blame?path=f.ts").lines.map((l: any) => [l.rev, l.agent]), [[6, "u5"], [6, "u5"]]);
  assert.equal(status(() => get(repo, "blame?path=f.ts&rev=5")), 404);
  assert.equal(status(() => get(repo, "blame?path=nope")), 404);
  assert.equal(status(() => get(repo, "blame")), 400);
  assert.equal(status(() => get(repo, "blame?path=f.ts&rev=q")), 400);
  // no-op rewrites and files without trailing newline
  const r = new Repo();
  r.seed({ g: "x\ny" });
  land(r, "n", { g: "x\ny" }, "noop");
  land(r, "n", { g: "x\ny\nz" }, "add z");
  assert.deepEqual(blame(r, { path: "g" }).lines.map((l) => l.rev), [1, 1, 2]);
});

test("blame: limits (too many lines => 413, deep histories are windowed and flagged)", () => {
  const r = new Repo();
  r.seed({ big: Array.from({ length: BLAME_MAX_LINES + 5 }, (_, i) => `l${i}`).join("\n") });
  assert.equal(status(() => blame(r, { path: "big" })), 413);
  const ok = new Repo();
  ok.seed({ big: Array.from({ length: BLAME_MAX_LINES }, (_, i) => `l${i}`).join("\n") });
  assert.equal(blame(ok, { path: "big" }).lines.length, BLAME_MAX_LINES);

  const d = new Repo();
  d.seed({ f: "base\n" });
  for (let i = 0; i < BLAME_MAX_VERSIONS + 20; i++) land(d, "a", { f: `base\nl${i}\n` }, `c${i}`);
  const b = blame(d, { path: "f" }) as any;
  assert.equal(b.truncated, true);
  assert.equal(b.lines.length, 2);
  assert.equal(b.lines[1].rev, d.s.rev);
});

test("search: literal, case, regex, glob, limit/truncated, offsets, skips, errors", () => {
  const repo = new Repo();
  repo.seed({
    "src/a.ts": "Hello World\nhello again\nnothing\nfoo.bar\n",
    "src/b.js": "say HELLO\nfoo+bar\n",
    "docs/c.md": "hello docs\n",
    "bin.dat": "hello\u0000bin",
    "huge.txt": "hello " + "x".repeat(1_000_001),
  });
  const r = search(repo, { q: "hello" });
  assert.equal(r.total, 4);
  assert.equal(r.truncated, false);
  assert.equal(r.rev, 1);
  assert.deepEqual(r.results.map((x) => [x.path, x.line, x.matchStart, x.matchEnd]), [["docs/c.md", 1, 0, 5], ["src/a.ts", 1, 0, 5], ["src/a.ts", 2, 0, 5], ["src/b.js", 1, 4, 9]]);
  assert.equal(r.results[0].text, "hello docs");
  assert.equal(search(repo, { q: "hello", caseSensitive: "1" }).total, 2);
  // literal: metacharacters are not special
  assert.deepEqual(search(repo, { q: "foo.bar" }).results.map((x) => x.path), ["src/a.ts"]);
  assert.equal(search(repo, { q: "foo+bar" }).total, 1);
  // regex
  assert.equal(search(repo, { q: "foo.bar", regex: "true" }).total, 2);
  assert.equal(search(repo, { q: "^hello", regex: "1", caseSensitive: "1" }).total, 2);
  assert.deepEqual(search(repo, { q: "w\\w+d", regex: "1" }).results.map((x) => [x.matchStart, x.matchEnd]), [[6, 11]]);
  // zero-length-only matches are ignored
  assert.equal(search(repo, { q: "z*", regex: "1" }).total, 0);
  // glob
  assert.deepEqual(search(repo, { q: "hello", path: "src/**" }).results.map((x) => x.path), ["src/a.ts", "src/a.ts", "src/b.js"]);
  assert.deepEqual(search(repo, { q: "hello", path: "*.md" }).results.map((x) => x.path), ["docs/c.md"]);
  // limit and truncated
  const lim = search(repo, { q: "hello", limit: "2" });
  assert.deepEqual([lim.results.length, lim.total, lim.truncated], [2, 4, true]);
  assert.equal(search(repo, { q: "hello", limit: "0" }).results.length, 1); // clamped to at least 1
  assert.equal(search(repo, { q: "hello", limit: "999999" }).results.length, 4);
  // errors
  assert.equal(status(() => search(repo, { q: "" })), 400);
  assert.equal(status(() => search(repo, {})), 400);
  assert.equal(status(() => search(repo, { q: "(", regex: "1" })), 400);
  assert.equal(status(() => search(repo, { q: "a".repeat(201) })), 400);
  assert.equal(search(repo, { q: "a".repeat(200) }).total, 0);
  assert.equal(status(() => search(repo, { q: "hello", limit: "-1" })), 400);
  // catastrophic regexes are rejected up front
  for (const q of ["(a+)+$", "(a*)*b", "(.*a){3,}x", "(x+x+)+y"]) assert.equal(status(() => search(repo, { q, regex: "1" })), 400, q);
  // ordinary groups still work
  assert.equal(search(repo, { q: "(foo|say) ", regex: "1" }).total, 1);
  // deleted files are not searched; the time budget yields truncated
  land(repo, "x", { "docs/c.md": null }, "rm");
  assert.equal(search(repo, { q: "hello" }).total, 3);
  let t = 0;
  const slow = search(repo, { q: "hello" }, () => (t += 5000));
  assert.equal(slow.truncated, true);
  // very long lines are searched only up to a cap
  const long = new Repo();
  long.seed({ l: "x".repeat(5000) + "needle" });
  assert.equal(search(long, { q: "needle" }).total, 0);
});

test("readme: root README, case-insensitive, absent => {path:null}", () => {
  const repo = fixture();
  assert.deepEqual(get(repo, "readme"), { path: "README.md", rev: 4, content: "# Hi\nline two\n" });
  const r = new Repo();
  assert.deepEqual(get(r, "readme"), { path: null });
  r.seed({ "docs/README.md": "nested", "readme.txt": "txt" });
  assert.equal(get(r, "readme").path, "readme.txt");
  land(r, "a", { "ReadMe.md": "# md" }, "md");
  assert.equal(get(r, "readme").path, "ReadMe.md");
  land(r, "a", { "ReadMe.md": null, "readme.txt": null }, "rm");
  assert.deepEqual(get(r, "readme"), { path: null });
});

test("stats: files, loc, languages (top 8 + other), contributors, sessions", () => {
  const repo = fixture();
  repo.open({ id: "live1", agent: "carol", goal: "wip" });
  const s = get(repo, "stats");
  assert.equal(s.files, 4);
  assert.equal(s.loc, 2 + 2 + 1 + 0 /* data.bin is binary */);
  assert.deepEqual(s.languages, { ts: 2, md: 1, bin: 1 });
  assert.equal(s.commits, 4);
  assert.deepEqual(s.contributors.map((c: any) => [c.agent, c.commits]), [["alice", 2], ["bob", 1], ["system", 1]]);
  assert.equal(s.contributors[0].lastTs, repo.s.commits[3].ts);
  assert.deepEqual(s.sessions, { live: 1, landed: 3 });
  const many = new Repo();
  const files: Record<string, string> = { Makefile: "x" };
  for (let i = 0; i < 12; i++) files[`f.e${i}`] = "x";
  files["g.e0"] = "y";
  many.seed(files);
  const st = stats(many);
  assert.equal(Object.keys(st.languages).length, 9);
  assert.equal(st.languages.e0, 2);
  assert.equal(st.languages.other, 5);
  assert.equal(stats(new Repo()).loc, 0);
});

test("routeBrowse only claims GET browse routes; api.route integrates and keeps other routes", () => {
  const repo = fixture();
  const ctx = (method: string, path: string) => {
    const url = new URL("http://x/api/" + path);
    return { repo, actor: openActor("t"), method, parts: url.pathname.split("/").filter(Boolean).slice(1), url, body: {} };
  };
  for (const p of ["state", "status", "commits", "trunk/files", "provenance", "tree/x", "commit", "readme/x", "stats/1/2", "tasks"]) assert.equal(routeBrowse(ctx("GET", p)), undefined, p);
  for (const m of ["POST", "PUT", "DELETE"]) for (const p of ["tree", "blob", "search", "commit/1"]) assert.equal(routeBrowse(ctx(m, p)), undefined);
  assert.ok(routeBrowse(ctx("GET", "tree")));
  assert.equal(get(repo, "status").rev, 4); // pre-existing routes still work
  assert.equal(status(() => get(repo, "nonexistent")), 404);
  // the repo is never mutated by browsing
  const before = JSON.stringify(repo.s);
  for (const p of ["tree", "blob?path=README.md", "history", "commit/2", "diff?from=1&to=4", "blame?path=README.md", "search?q=a", "readme", "stats"]) get(repo, p);
  assert.equal(JSON.stringify(repo.s), before);
});

// ---- differential test against real `git blame` ------------------------------------------------
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON = ["", "}", "  return x;", "{", "  // todo", "end", "  }", "import a from 'a';", "  foo();", "  bar();"];

/** Build a repo with a random history over a few files. Contents always end with a newline (git treats an unterminated last line as distinct). */
function randomRepo(seed: number, commits: number, opts: { deletes: boolean }) {
  const rnd = prng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  let uniq = 0;
  const fresh = () => (rnd() < 0.5 ? COMMON[int(COMMON.length)] : `line ${seed}-${++uniq} ${rnd() < 0.3 ? "x".repeat(int(5)) : ""}`.trimEnd());
  let t = 1_700_000_000_000;
  const repo = new Repo(undefined, () => (t += 60_000));
  const names = ["a.txt", "dir/b.txt", "c.txt"];
  const cur: Record<string, string[] | null> = {};
  const seedFiles: Record<string, string> = {};
  for (const n of names) {
    cur[n] = Array.from({ length: 5 + int(15) }, fresh);
    seedFiles[n] = cur[n]!.join("\n") + "\n";
  }
  repo.seed(seedFiles, "seed");
  for (let c = 0; c < commits; c++) {
    const edits: Record<string, string | null> = {};
    const roll = rnd();
    if (opts.deletes && roll < 0.08) {
      const live = names.filter((n) => cur[n]);
      if (live.length > 1) {
        const n = live[int(live.length)];
        cur[n] = null;
        edits[n] = null;
      }
    } else if (opts.deletes && roll < 0.16 && names.some((n) => !cur[n])) {
      const n = names.find((x) => !cur[x])!;
      cur[n] = Array.from({ length: 4 + int(10) }, fresh);
      edits[n] = cur[n]!.join("\n") + "\n";
    }
    if (!Object.keys(edits).length) {
      for (const n of names.filter((x) => cur[x]).filter(() => rnd() < 0.55)) {
        const l = [...cur[n]!];
        const ops = 1 + int(4);
        for (let k = 0; k < ops; k++) {
          const kind = rnd();
          const at = int(l.length + 1);
          if (kind < 0.35) l.splice(at, 0, ...Array.from({ length: 1 + int(4) }, fresh));
          else if (kind < 0.55 && l.length > 3) l.splice(Math.min(at, l.length - 1), 1 + int(3));
          else if (kind < 0.8 && l.length) l[Math.min(at, l.length - 1)] = fresh();
          else if (l.length > 2) {
            const s = int(l.length - 1);
            l.splice(at, 0, ...l.slice(s, s + 1 + int(3))); // duplicate a block (ambiguous alignment)
          }
        }
        if (l.length === 0) l.push(fresh());
        cur[n] = l;
        edits[n] = l.join("\n") + "\n";
      }
    }
    if (Object.keys(edits).length) land(repo, ["ann", "bo", "cy"][int(3)], edits, `c${c}`);
  }
  return repo;
}

function gitBlameRevs(dir: string, revToSha: Map<number, string>, path: string, rev: number, indent = true): number[] {
  const out = execFileSync("git", ["-C", dir, ...(indent ? [] : ["-c", "diff.indentHeuristic=false"]), "blame", "--porcelain", revToSha.get(rev)!, "--", path], { maxBuffer: 1 << 26 }).toString();
  const shaToRev = new Map([...revToSha].map(([r, s]) => [s, r]));
  const revs: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m) revs[Number(m[2]) - 1] = shaToRev.get(m[1])!;
  }
  return revs;
}

function importToGit(repo: Repo) {
  const dir = mkdtempSync(join(tmpdir(), "weave-blame-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "fast-import", "--quiet"], { input: exportFastImport(repo.s), maxBuffer: 1 << 26 });
  const log = execFileSync("git", ["-C", dir, "log", "--format=%H%x00%B%x01", "main"]).toString();
  const revToSha = new Map<number, string>();
  for (const rec of log.split("\x01")) {
    const m = /^\s*([0-9a-f]{40})\x00[\s\S]*Weave-Rev: r(\d+)/.exec(rec);
    if (m) revToSha.set(Number(m[2]), m[1]);
  }
  return { dir, revToSha };
}

function compare(repo: Repo, dir: string, revToSha: Map<number, string>, revs: number[], indent = true) {
  let lines = 0;
  let agree = 0;
  const bad: string[] = [];
  for (const rev of revs) {
    for (const p of repo.listFiles(rev)) {
      const mine = blame(repo, { path: p, rev: String(rev) }).lines;
      const theirs = gitBlameRevs(dir, revToSha, p, rev, indent);
      assert.equal(theirs.length, mine.length, `line count ${p}@r${rev}`);
      mine.forEach((l, i) => {
        lines++;
        if (l.rev === theirs[i]) agree++;
        else bad.push(`${p}@r${rev}:${l.n} weave=r${l.rev} git=r${theirs[i]}`);
      });
    }
  }
  return { lines, agree, bad };
}

const GIT = hasGit();

test("blame matches git blame: simple histories agree 100%", { skip: GIT ? false : "git is not installed: skipping the differential blame test" }, () => {
  const repo = new Repo();
  repo.seed({ "f.txt": "one\ntwo\nthree\nfour\nfive\n", "g.txt": "x\ny\n" });
  land(repo, "a", { "f.txt": "one\ntwo\nTHREE\nfour\nfive\n" }, "modify");
  land(repo, "b", { "f.txt": "zero\none\ntwo\nTHREE\nfour\nfive\n" }, "prepend");
  land(repo, "c", { "f.txt": "zero\none\nTHREE\nfour\nfive\nsix\nseven\n", "g.txt": "x\ny\nz\n" }, "delete+append");
  land(repo, "d", { "f.txt": "zero\none\nTHREE\nTHREE\nfour\nfive\nsix\nseven\n" }, "duplicate a line");
  land(repo, "e", { "g.txt": null }, "rm g");
  land(repo, "f", { "g.txt": "x\nnew\n" }, "re-add g");
  const { dir, revToSha } = importToGit(repo);
  try {
    const r = compare(repo, dir, revToSha, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(r.agree, r.lines, r.bad.join("\n"));
    assert.ok(r.lines > 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blame matches git blame on randomized histories (>= 97% per-line agreement)", { skip: GIT ? false : "git is not installed: skipping the differential blame test" }, () => {
  let lines = 0;
  let agree = 0;
  const bad: string[] = [];
  let simpleLines = 0;
  let simpleAgree = 0;
  let agreeNoIndent = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const withDeletes = seed % 2 === 0;
    const commits = 20 + (seed % 5) * 20; // 20..100 commits
    const repo = randomRepo(seed, commits, { deletes: withDeletes });
    const { dir, revToSha } = importToGit(repo);
    try {
      const head = repo.s.rev;
      const revs = [head, Math.max(1, Math.floor(head / 2))];
      const r = compare(repo, dir, revToSha, revs);
      const r2 = compare(repo, dir, revToSha, revs, false);
      lines += r.lines;
      agree += r.agree;
      agreeNoIndent += r2.agree;
      bad.push(...r.bad);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // purely insert/delete histories without ambiguous duplicates: exact agreement is expected
  for (let seed = 100; seed < 106; seed++) {
    const rnd = prng(seed);
    const repo = new Repo();
    let uniq = 0;
    let cur = Array.from({ length: 12 }, () => `u${++uniq}`);
    repo.seed({ "f.txt": cur.join("\n") + "\n" });
    for (let c = 0; c < 40; c++) {
      const at = Math.floor(rnd() * cur.length);
      if (rnd() < 0.5) cur = [...cur.slice(0, at), ...Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => `u${++uniq}`), ...cur.slice(at)];
      else if (rnd() < 0.5 && cur.length > 4) cur = [...cur.slice(0, at), ...cur.slice(at + 1)];
      else cur = cur.map((l, i) => (i === at ? `u${++uniq}` : l));
      land(repo, "a", { "f.txt": cur.join("\n") + "\n" }, `c${c}`);
    }
    const { dir, revToSha } = importToGit(repo);
    try {
      const r = compare(repo, dir, revToSha, [repo.s.rev, 20]);
      simpleLines += r.lines;
      simpleAgree += r.agree;
      assert.equal(r.agree, r.lines, r.bad.slice(0, 10).join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const rate = agree / lines;
  console.log(`blame vs git: random histories ${agree}/${lines} lines = ${(rate * 100).toFixed(2)}% (${((agreeNoIndent / lines) * 100).toFixed(2)}% vs git with the indent heuristic off); unique-line histories ${simpleAgree}/${simpleLines}`);
  if (bad.length) console.log("sample disagreements:\n" + bad.slice(0, 8).join("\n"));
  assert.ok(lines > 5000, `expected a meaningful sample, got ${lines} lines`);
  assert.ok(rate >= 0.97, `agreement ${(rate * 100).toFixed(2)}% < 97%`);
});
