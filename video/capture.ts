// Captures everything the video and the report need from a finished swarm run:
// events, commits, per-agent metrics, a provenance sample, the final trunk and its test result,
// and a transcript of real `git clone` / `git log` against the Weave server.
//   node video/capture.ts [url=http://localhost:8789] [repo=swarm] [admin=test-admin-token]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url = "http://localhost:8789", repo = "swarm", admin = "test-admin-token", sub = ""] = process.argv.slice(2);
const out = new URL(`./data/${sub ? sub + "/" : ""}`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const get = async (p: string) => (await fetch(`${url}/api/${p}${p.includes("?") ? "&" : "?"}repo=${repo}`, { headers: { authorization: `Bearer ${admin}` } })).json() as Promise<any>;

const st = await get("state");
const events: any[] = (await get("events?after=0")).events; // full audit log (the state endpoint only returns the last 100)
writeFileSync(out + "events.json", JSON.stringify(events));

// ---- per-agent metrics from the audit log
const agents = new Map<string, any>();
const A = (n: string) => agents.get(n) ?? agents.set(n, { agent: n, opened: 0, firstLanded: 0, conflicts: 0, resolves: 0, checkRuns: 0, failedChecks: 0, parked: 0, reviews: 0, landedChanges: 0 }).get(n);
for (const e of events) {
  if (!e.agent) continue;
  const a = A(e.agent);
  if (e.type === "open" && !a.opened) a.opened = e.ts;
  if (e.type === "conflict") a.conflicts++;
  if (e.type === "resolve") a.resolves++;
  if (e.type === "job_queued") a.checkRuns++;
  if (e.type === "check_failed") a.failedChecks++;
  if (e.type === "blocked") a.parked++;
  if (e.type === "review_requested") a.reviews++;
  if (e.type === "landed") { a.landedChanges++; a.firstLanded ||= e.ts; }
}
const t0 = Math.min(...events.map((e) => e.ts));
const devs = [...agents.values()].filter((a) => a.opened).map((a) => ({ ...a, secondsToLand: a.firstLanded ? Math.round((a.firstLanded - t0) / 1000) : null }));
const landTimes = devs.map((d) => d.secondsToLand).filter((x): x is number => x !== null).sort((a, b) => a - b);
const pct = (p: number) => landTimes[Math.min(landTimes.length - 1, Math.floor(p * landTimes.length))];

// ---- final trunk: write it out and run its real tests
const trunkDir = out + "trunk/";
rmSync(trunkDir, { recursive: true, force: true });
mkdirSync(trunkDir, { recursive: true });
for (const [p, c] of Object.entries<string>(st.files)) writeFileSync(trunkDir + p, c);
writeFileSync(trunkDir + "package.json", '{"type":"commonjs"}'); // the repo root is ESM; the library under test is CommonJS
const t = spawnSync("node", ["--test"], { cwd: trunkDir, encoding: "utf8" });
const testOut = (t.stdout + t.stderr).split("\n");
const num = (k: string) => Number(testOut.find((l) => l.startsWith(`# ${k}`))?.split(" ").pop() ?? 0);
const exportsLine = (st.files["lib.js"] as string).match(/module\.exports = \{([^}]*)\}/)?.[1] ?? "";
const exported = exportsLine.split(",").map((s) => s.trim()).filter(Boolean);
// ground truth for "did anyone's landed work get lost?": which function each developer was asked to add
const FN: Record<string, string> = { ada: "slugify", ben: "clamp", cai: "chunk", dev: "unique", eli: "flatten", fay: "groupBy", gus: "capitalize", hui: "truncate", ivy: "average", jon: "median", kim: "range", leo: "zip", mia: "pick", ned: "omit", oli: "partition", pia: "countBy" };
const landedAgents = new Set(events.filter((e) => e.type === "landed").map((e) => e.agent));
const lostAfterLanding = Object.keys(FN).filter((a) => landedAgents.has(a) && !exported.includes(FN[a]) && FN[a] !== "slugify" || (a === "ada" && !exported.includes("slugify") && landedAgents.has("ada")));
const neverLanded = Object.keys(FN).filter((a) => !exported.includes(FN[a]) && !lostAfterLanding.includes(a));
writeFileSync(out + "review-quotes.json", JSON.stringify(events.filter((e) => e.type === "rejected").map((e) => ({ by: e.by, agent: e.agent, note: String(e.message).replace(/^.*?rejected [^']*'s change:?\s*/, "") }))));

// ---- provenance sample (a merged commit, if any)
const merged = st.commits.filter((c: any) => c.merged);
const sampleRev = (merged.at(-1) ?? st.commits.at(-1)).rev;
const prov = await get(`provenance/${sampleRev}`);
const chain = (await get("provenance")).chain;

// ---- real git against the Weave server
const gitUser = `gitdemo${Date.now() % 100000}`;
const hana = await (await fetch(`${url}/api/identities?repo=${repo}`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: gitUser, kind: "human" }) })).json() as any;
const dir = mkdtempSync(join(tmpdir(), "weave-clone-"));
const host = new URL(url);
const cloneUrl = `${host.protocol}//${gitUser}:${hana.token}@${host.host}/git/${repo}`;
const shown = `${host.protocol}//gitdemo:<token>@${host.host}/git/${repo}`;
const sh = (args: string[], cwd?: string) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); return (r.stdout + r.stderr).trimEnd(); };
const transcript: string[] = [];
transcript.push(`$ git clone ${shown}`, sh(["clone", "-q", cloneUrl, dir]) || "(cloned)");
transcript.push("$ git log --oneline | head -8", sh(["log", "--oneline", "-8"], dir));
transcript.push("$ git log -1 --format=%B   # the last landed change, with Weave's trailers", sh(["log", "-1", "--format=%an: %s%n%n%b"], dir));
transcript.push("$ git fsck --strict", sh(["fsck", "--strict"], dir) || "(clean)");
transcript.push(`$ grep -c "^test(" lib.test.js`, String((sh(["show", "HEAD:lib.test.js"], dir).match(/^test\(/gm) ?? []).length));
rmSync(dir, { recursive: true, force: true });
writeFileSync(out + "git-transcript.txt", transcript.join("\n") + "\n");

const report = {
  repo, generatedAt: new Date().toISOString(),
  agents: devs.length, developers: devs.filter((d) => /^(?!rev|runner)/.test(d.agent)).length,
  trunkRev: st.rev, landedChanges: st.commits.length - 1,
  totals: {
    conflicts: devs.reduce((n, d) => n + d.conflicts, 0), resolves: devs.reduce((n, d) => n + d.resolves, 0),
    ciRuns: devs.reduce((n, d) => n + d.checkRuns, 0), failedChecks: devs.reduce((n, d) => n + d.failedChecks, 0),
    parked: devs.reduce((n, d) => n + d.parked, 0), reviews: events.filter((e) => e.type === "approved" || e.type === "rejected").length,
    approvals: events.filter((e) => e.type === "approved").length, rejections: events.filter((e) => e.type === "rejected").length,
  },
  timeToLandSec: { first: landTimes[0], p50: pct(0.5), p90: pct(0.9), last: landTimes.at(-1) },
  integrity: { developersAsked: Object.keys(FN).length, functionsOnTrunk: Object.values(FN).filter((f) => exported.includes(f)).length, lostAfterLanding, neverLanded },
  finalTrunk: { files: Object.keys(st.files), testsRun: num("tests"), testsPassed: num("pass"), testsFailed: num("fail"), exportedFunctions: exported.length, exported },
  provenanceSample: { rev: sampleRev, record: prov.record, hashPrefix: String(prov.hash).slice(0, 16), signaturePrefix: String(prov.signature).slice(0, 16) },
  chain, perAgent: devs.sort((a, b) => a.agent.localeCompare(b.agent)),
};
writeFileSync(out + "swarm-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, perAgent: undefined, provenanceSample: { rev: sampleRev } }, null, 2));
