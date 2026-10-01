import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore plain JS modules served to browsers
import { highlight, langOf, tokenize } from "../public/js/highlight.js";
// @ts-ignore
import { buildHash, parseHash, parseLineFrag, sectionOf } from "../public/js/router.js";
// @ts-ignore
import { countPatch, parsePatch } from "../public/js/diff.js";
// @ts-ignore
import { fmtBytes, fmtDuration, fullTime, relTime } from "../public/js/time.js";

// ---- highlighter ------------------------------------------------------------------------------
const classes = (code: string, lang: string): string[] => tokenize(code, lang).filter((t: any) => t.c).map((t: any) => `${t.c}:${t.t}`);

test("highlight: js/ts tokens", () => {
  const c = classes('const x = foo("a\\"b", 42) // hi\n/* multi\nline */ class Foo {}', "ts");
  assert.ok(c.includes("kw:const"));
  assert.ok(c.includes("fn:foo"));
  assert.ok(c.includes('str:"a\\"b"'));
  assert.ok(c.includes("num:42"));
  assert.ok(c.includes("com:// hi"));
  assert.ok(c.includes("com:/* multi\nline */"));
  assert.ok(c.includes("type:Foo"));
});

test("highlight: python, json, css, html, md, sh", () => {
  assert.ok(classes("def f(x):\n    return None  # c", "py").includes("kw:def"));
  assert.ok(classes('"""doc\nmore"""', "py").includes('str:"""doc\nmore"""'));
  const j = classes('{"a": [1, true, "s"]}', "json");
  assert.ok(j.includes('key:"a"') && j.includes("num:1") && j.includes("lit:true") && j.includes('str:"s"'));
  const css = classes("a:hover { color: #fff; margin: 4px } /* c */", "css");
  assert.ok(css.includes("key:color") && css.includes("num:#fff") && css.includes("com:/* c */"));
  assert.ok(classes('<div class="a">x</div>', "html").includes("tag:<div"));
  assert.ok(classes("# Head\n`code`", "md").includes("kw:# Head"));
  assert.ok(classes('echo $HOME # c\nif [ -f x ]; then exit 1; fi', "sh").includes("var:$HOME"));
});

test("highlight: lossless, splits into lines, tolerant of junk", () => {
  const src = "line one\n\n`unterminated\nlast";
  for (const lang of ["js", "py", "json", "css", "html", "md", "sh", "text", "nope"]) {
    const lines = highlight(src, lang);
    assert.equal(lines.length, 4);
    assert.equal(lines.map((l: any[]) => l.map((t) => t.t).join("")).join("\n"), src, lang);
  }
  assert.deepEqual(highlight("", "js"), [[]]);
  assert.equal(langOf("src/a.ts"), "ts");
  assert.equal(langOf("x", "py"), "py");
  assert.equal(langOf("LICENSE"), "text");
  assert.equal(langOf("scripts/Dockerfile"), "sh");
});

test("highlight: output is data, markup stays inert", () => {
  const lines = highlight("<script>alert(1)</script>", "html");
  assert.equal(lines[0].map((t: any) => t.t).join(""), "<script>alert(1)</script>");
});

// ---- router -----------------------------------------------------------------------------------
test("router: parse and build round-trip", () => {
  assert.deepEqual(parseHash("").name, "home");
  assert.deepEqual(parseHash("#/").params, { path: "" });
  const b = parseHash("#/blob/src/a%20b.ts?rev=4#L12");
  assert.equal(b.name, "blob");
  assert.equal(b.params.path, "src/a b.ts");
  assert.deepEqual(b.query, { rev: "4" });
  assert.equal(b.frag, "L12");
  assert.equal(parseHash("#/tree/src/auth").params.path, "src/auth");
  assert.equal(parseHash("#/commit/12").params.rev, "12");
  assert.equal(parseHash("#/change/alice-xyz~1").params.id, "alice-xyz~1");
  assert.equal(parseHash("#/task/7").params.n, "7");
  assert.equal(parseHash("#/search?q=foo%20bar&regex=1").query.q, "foo bar");
  for (const n of ["changes", "tasks", "commits", "activity", "releases", "notifications", "settings", "repos"]) assert.equal(parseHash("#/" + n).name, n);
  assert.equal(parseHash("#/nope/zzz").name, "notfound");
  assert.equal(parseHash("#/tasks/extra").name, "notfound");
  assert.equal(parseHash("#/blob/%E0%A4%A").name, "blob"); // malformed escapes do not throw
  for (const [name, params, query, frag] of [
    ["blob", { path: "src/a b#c?.ts" }, { rev: 3 }, "L2"],
    ["tree", { path: "docs/x" }, {}, ""],
    ["commit", { rev: 9 }, {}, ""],
    ["change", { id: "bot/1~x" }, {}, ""],
    ["task", { n: 3 }, {}, ""],
    ["search", {}, { q: "a&b" }, ""],
  ] as any[]) {
    const p = parseHash(buildHash(name, params, query, frag));
    assert.equal(p.name, name);
    for (const [k, v] of Object.entries(params)) assert.equal(p.params[k], String(v));
    assert.equal(p.frag, frag);
    for (const [k, v] of Object.entries(query)) assert.equal(p.query[k], String(v));
  }
  assert.equal(buildHash("home"), "#/");
  assert.equal(buildHash("tree", { path: "" }), "#/");
  assert.equal(parseLineFrag("L10")?.from, 10);
  assert.deepEqual(parseLineFrag("L3-L9"), { from: 3, to: 9 });
  assert.equal(parseLineFrag("x"), null);
  assert.equal(sectionOf("blob"), "code");
  assert.equal(sectionOf("change"), "changes");
});

// ---- diff parser ------------------------------------------------------------------------------
test("diff: parse patch into numbered lines", () => {
  const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -3,4 +3,5 @@ fn", " keep", "-old", "+new1", "+new2", " tail", "\\ No newline at end of file", "@@ -20,1 +21,1 @@", "---not a header (deleted '-- ' line)", "+z"].join("\n");
  const h = parsePatch(patch);
  assert.equal(h.length, 2);
  assert.equal(h[0].section, "fn");
  assert.deepEqual(h[0].lines.map((l: any) => [l.type, l.oldN, l.newN]), [["ctx", 3, 3], ["del", 4, null], ["add", null, 4], ["add", null, 5], ["ctx", 5, 6], ["meta", null, null]]);
  assert.equal(h[1].lines[0].type, "del");
  assert.equal(h[1].lines[0].text, "--not a header (deleted '-- ' line)");
  assert.deepEqual(countPatch(h), { added: 3, removed: 2 });
  assert.deepEqual(parsePatch(""), []);
  assert.deepEqual(parsePatch("--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b").map((x: any) => x.lines.length), [2]);
});

// ---- relative time ----------------------------------------------------------------------------
test("time: relative formatting", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const ago = (ms: number) => relTime(now - ms, now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(30e3), "just now");
  assert.equal(ago(5 * 60e3), "5m ago");
  assert.equal(ago(59 * 60e3), "59m ago");
  assert.equal(ago(3 * 3600e3), "3h ago");
  assert.equal(ago(2 * 86400e3), "2d ago");
  assert.equal(ago(21 * 86400e3), "3w ago");
  assert.equal(ago(100 * 86400e3), "Mar 7");
  assert.equal(ago(400 * 86400e3), "May 11, 2025");
  assert.equal(relTime(now + 2 * 3600e3, now), "in 2h");
  assert.equal(relTime(NaN as any, now), "");
  assert.equal(relTime(undefined as any, now), "");
  assert.equal(fullTime(0), "1970-01-01 00:00:00 UTC");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2.0 KB");
  assert.equal(fmtDuration(90_000), "1m 30s");
});

// ---- forge helpers: owners, runs, packages, routes ---------------------------------------------
// @ts-ignore
import { cleanOwnerRules, latestByWorkflow, ownerRef, ownerSummary, packageSnippets, parseList, pickVersion, runPillClass, sortRuns, triggerText } from "../public/js/forge.js";

test("forge: parseList and ownerRef", () => {
  assert.deepEqual(parseList(" maria, team:core  maria\nbot,"), ["maria", "team:core", "bot"]);
  assert.deepEqual(ownerRef("team:core"), { kind: "team", name: "core" });
  assert.deepEqual(ownerRef("maria"), { kind: "identity", name: "maria" });
});

test("forge: cleanOwnerRules validates and drops blank rows", () => {
  assert.deepEqual(cleanOwnerRules([{ pattern: " src/auth/ ", owners: "team:core, maria" }, { pattern: "", owners: "" }]), { rules: [{ pattern: "src/auth/", owners: ["team:core", "maria"] }], error: "" });
  assert.match(cleanOwnerRules([{ pattern: "src/", owners: "" }]).error, /needs at least one owner/);
  assert.match(cleanOwnerRules([{ pattern: "", owners: "maria" }]).error, /no path pattern/);
  assert.match(cleanOwnerRules([{ pattern: "a/", owners: "team:" }]).error, /team name/);
});

test("forge: ownerSummary counts pending", () => {
  assert.deepEqual(ownerSummary([{ satisfied: true }, { satisfied: false }, { satisfied: false }]), { total: 3, pending: 2, satisfied: 1 });
  assert.deepEqual(ownerSummary(undefined), { total: 0, pending: 0, satisfied: 0 });
});

test("forge: runs sort numerically, newest first, and latest per workflow", () => {
  const runs = [{ id: "w2", workflow: "a" }, { id: "w10", workflow: "a" }, { id: "w3", workflow: "b" }];
  assert.deepEqual(sortRuns(runs).map((r: any) => r.id), ["w10", "w3", "w2"]);
  assert.equal(latestByWorkflow(runs).get("a").id, "w10");
  assert.equal(runPillClass("passed"), "pill run-passed");
  assert.equal(runPillClass("weird"), "pill run-unknown");
  assert.equal(triggerText({ trigger: "tag", ref: "v1", rev: 3, by: "m" }), "tag v1");
  assert.equal(triggerText({ trigger: "landed", rev: 3, by: "m" }), "landing r3");
  assert.equal(triggerText({ trigger: "manual", rev: 3, by: "m" }), "manual by m");
});

test("forge: package snippets encode scope and repo; pickVersion prefers the requested version", () => {
  const s = packageSnippets({ origin: "https://w.test", name: "@orbit/client", version: "1.2.0", file: "dist/a b.js", repo: "docs-site" });
  assert.equal(s.url, "https://w.test/api/packages/%40orbit%2Fclient/1.2.0/files/dist%2Fa%20b.js?repo=docs-site");
  assert.match(s.curl, /base64 -d > a_b\.js$/);
  assert.ok(!packageSnippets({ origin: "o", name: "n", version: "1.0.0", file: "f", repo: "default" }).url.includes("?repo"));
  const rel = [{ version: "1.0.0" }, { version: "1.1.0", yanked: "x" }, { version: "1.2.0" }];
  assert.equal(pickVersion(rel, "1.1.0", "1.2.0").version, "1.1.0");
  assert.equal(pickVersion(rel, undefined, "1.2.0").version, "1.2.0");
  assert.equal(pickVersion([{ version: "1.0.0", yanked: "x" }], undefined, undefined).version, "1.0.0");
});

test("router: run and package routes round-trip", () => {
  assert.deepEqual(parseHash("#/run/w3").params, { id: "w3" });
  assert.equal(parseHash("#/runs").name, "runs");
  const p = parseHash("#/package/%40orbit%2Fclient?v=1.2.0");
  assert.equal(p.name, "package");
  assert.equal(p.params.name, "@orbit/client");
  assert.equal(parseHash(buildHash("package", { name: "@orbit/client" })).params.name, "@orbit/client");
  assert.equal(sectionOf("run"), "runs");
  assert.equal(sectionOf("package"), "packages");
});
