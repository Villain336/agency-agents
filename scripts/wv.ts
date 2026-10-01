// `wv`: a small command-line client for Weave, meant for agents and humans.
//   export WEAVE_URL=http://localhost:8788 WEAVE_TOKEN=wv_... WEAVE_REPO=default
//   node scripts/wv.ts status
//   node scripts/wv.ts open "add slugify" lib.js lib.test.js        # prints the session id
//   node scripts/wv.ts cat lib.js [--session ID]                    # read through your session (safe)
//   node scripts/wv.ts put ID lib.js ./local-copy.js                # write a session file from a local file
//   node scripts/wv.ts preview ID | submit ID ["message"] | session ID | wait ID [seconds]
//   node scripts/wv.ts conflicts ID                                  # show conflicts in readable form
//   node scripts/wv.ts resolve ID lib.js ./merged.js                # resolve a conflicted path by supplying the final merged file
//   node scripts/wv.ts queue | pack ID | review ID approve|reject ["note"] | comment ID path line "text"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Weave, WeaveError } from "../sdk/ts/weave.ts";

const url = process.env.WEAVE_URL ?? "http://localhost:8787";
const token = process.env.WEAVE_TOKEN;
const repo = process.env.WEAVE_REPO ?? "default";
const w = new Weave({ url, token, repo });
const [cmd, ...a] = process.argv.slice(2);
// `cat` of trunk remembers which revision it read; `put`/`resolve` pass it as basedOn so that anything
// that landed since is merged in instead of conflicting again (or being silently overwritten).
const revFile = join(tmpdir(), `wv-revs-${repo}-${(token ?? "anon").slice(-8)}.json`);
const revs: Record<string, number> = existsSync(revFile) ? JSON.parse(readFileSync(revFile, "utf8")) : {};
const remember = (path: string, rev: number) => writeFileSync(revFile, JSON.stringify({ ...revs, [path]: rev }));
const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const flag = (n: string) => { const i = a.indexOf(`--${n}`); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v; };

function showConflicts(s: any) {
  if (!s.conflicts?.length) return "no conflicts recorded";
  return s.conflicts.map((c: any) => `== ${c.path} (${c.kind}) ==\n` + c.segments.map((g: any, i: number) => g.kind === "ok" ? "" : `-- conflict ${i}\n<<<<<<< trunk (ours)\n${g.ours.join("\n")}\n=======\n${g.theirs.join("\n")}\n>>>>>>> yours (theirs)`).filter(Boolean).join("\n")).join("\n");
}

try {
  switch (cmd) {
    case "status": { const s: any = await w.status(); print({ rev: s.rev, files: s.files, policy: s.policy, checks: s.checks, protectedPaths: s.protectedPaths, liveSessions: s.sessions }); break; }
    case "open": { const [goal, ...paths] = a; const s: any = await w.open({ goal, intent: paths, id: flag("id") }); print(s.id); if (s.warnings?.length) console.error("warnings:", s.warnings.join("; ")); break; }
    case "cat": { const sid = flag("session"); let c: string | null; if (sid) c = await w.read(sid, a[0]); else { const r = await w.readTrunkAt(a[0]); c = r.content; remember(a[0], r.rev); } process.stdout.write(c ?? ""); break; }
    case "put": { const [id, path, file] = a; await w.write(id, path, readFileSync(file, "utf8"), revs[path]); print("ok"); break; }
    case "del": { await w.write(a[0], a[1], null); print("ok"); break; }
    case "preview": { const p: any = await w.preview(a[0]); print({ mergedWithConcurrentWork: p.merged, conflicts: p.conflicts.map((c: any) => c.path), semanticRisks: p.risks, trunkRev: p.baseRev }); break; }
    case "submit": { const allow = a.includes("--allow-revert"); const r: any = await w.request("POST", `sessions/${a[0]}/submit`, { message: a[1] && !a[1].startsWith("--") ? a[1] : undefined, allowRevert: allow }); print({ status: r.status, rev: r.rev, conflicts: r.conflicts?.map((c: any) => c.path), risk: r.risk && { score: r.risk.score, tier: r.risk.tier }, evidence: r.evidence, reverts: (r as any).reverts, hint: (r as any).reverts ? "Weave stopped this: it would remove work teammates landed. Run `session ID` for details, re-read trunk (`cat`), redo your edit on top of it, `put`, then submit again." : undefined }); break; }
    case "session": { const s: any = await w.session(a[0]); print({ status: s.status, baseRev: s.baseRev, blockedOn: s.blockedOn, landedRev: s.landedRev, conflictPaths: s.conflicts?.map((c: any) => c.path), risk: s.risk && { score: s.risk.score, tier: s.risk.tier, reasons: s.risk.reasons }, evidence: s.evidence?.map((e: any) => ({ check: e.check, passed: e.passed, output: e.passed ? undefined : e.output })), feedback: s.feedback }); break; }
    case "conflicts": { const s: any = await w.session(a[0]); print(showConflicts(s)); break; }
    case "resolve": { const [id, path, file] = a; await w.resolveWith(id, path, readFileSync(file, "utf8"), revs[path]); print("resolved " + path + "; now run: submit " + id); break; }
    case "wait": { const id = a[0]; const t0 = Date.now(); const max = Number(a[1] ?? 180) * 1000; for (;;) { const s: any = await w.session(id); if (["landed", "rejected", "conflicted", "active", "in_review", "needs_verify"].includes(s.status) || Date.now() - t0 > max) { print({ status: s.status, blockedOn: s.blockedOn, landedRev: s.landedRev }); break; } await new Promise((r) => setTimeout(r, 1500)); } break; }
    case "queue": print(await w.reviewQueue()); break;
    case "pack": { const p: any = await w.reviewPack(a[0]); if (p.warnings?.length) print("WARNINGS (read these first):\n- " + p.warnings.join("\n- ")); print({ goal: p.goal, agent: p.agent, status: p.status, risk: p.risk, stats: p.stats, behindBy: p.behindBy, evidence: p.evidence, comments: p.comments }); for (const f of p.files) print(f.patch); break; }
    case "review": { const r = await w.review(a[0], a[1] === "approve", a[2]); print({ status: r.status }); break; }
    case "comment": { await w.comment(a[0], { path: a[1], line: Number(a[2]), body: a[3] }); print("ok"); break; }
    case "history": print(await w.history(Number(a[0] ?? 20))); break;
    default: console.error("commands: status open cat put del preview submit session conflicts resolve wait queue pack review comment history"); process.exit(2);
  }
} catch (e) {
  console.error((e instanceof WeaveError ? `error ${e.status}: ` : "error: ") + (e as Error).message);
  process.exit(1);
}
