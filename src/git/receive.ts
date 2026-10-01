// receive-pack (push). Pushed trees are turned into Weave session overlays:
//   refs/weave/sessions/<id>  -> create/replace that session's overlay, delete = abandon
//   refs/heads/main           -> open a session, write the edits, submit() (3-way merge on trunk)
import type { Repo } from "../repo.ts";
import { concat, ZERO_SHA } from "./bytes.ts";
import { flattenTree, GitView, MAIN_REF, OPEN_STATUSES, parseCommit, SESSION_PREFIX, type Lookup } from "./objects.ts";
import { parsePack, type GitObj } from "./pack.ts";
import { FLUSH, pkt, pktText, readPkts, sideband } from "./pkt.ts";

const AGENT = "agent=weave";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function advertiseReceive(view: GitView): Uint8Array {
  const caps = `report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 ${AGENT}`;
  const refs = view.refs();
  const parts: Uint8Array[] = [pkt("# service=git-receive-pack\n"), FLUSH];
  if (!refs.length) parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  refs.forEach((r, i) => parts.push(pkt(`${r.id} ${r.name}${i === 0 ? `\0${caps}` : ""}\n`)));
  parts.push(FLUSH);
  return concat(parts);
}

interface Plan { baseRev: number; edits: Record<string, string | null>; subject: string }

function plan(view: GitView, lookup: Lookup, commitId: string): Plan {
  const obj = lookup(commitId);
  if (!obj || obj.type !== 1) throw new Error("not a commit");
  const c = parseCommit(obj.data);
  let baseRev = view.repo.s.rev;
  let cur: string | undefined = c.parents[0];
  for (let guard = 0; cur && guard < 100000; guard++) {
    const r = view.revOf(cur) ?? view.sessionBaseOf(cur);
    if (r !== undefined) { baseRev = r; break; }
    const o = lookup(cur);
    if (!o || o.type !== 1) break;
    cur = parseCommit(o.data).parents[0];
  }
  const pushed = flattenTree(lookup, c.tree);
  const base = view.flatAt(baseRev);
  const edits: Record<string, string | null> = {};
  for (const [path, e] of pushed) {
    if (e.mode !== "100644" && e.mode !== "100755") throw new Error(`unsupported file mode ${e.mode} for ${path} (symlinks/submodules not supported)`);
    if (base.get(path) === e.id) continue;
    const blob = lookup(e.id);
    if (!blob || blob.type !== 3) throw new Error(`missing blob for ${path}`);
    try { edits[path] = utf8.decode(blob.data); } catch { throw new Error(`${path} is not valid UTF-8 text (binary files not supported)`); }
  }
  for (const path of base.keys()) if (!pushed.has(path)) edits[path] = null;
  return { baseRev, edits, subject: c.message.trim() || "git push" };
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");

function writeSession(repo: Repo, id: string, agent: string, p: Plan) {
  const existing = repo.s.sessions[id];
  if (existing && OPEN_STATUSES.includes(existing.status)) {
    if (existing.agent !== agent) throw new Error(`session ${id} belongs to ${existing.agent}`);
    Object.assign(existing, { baseRev: p.baseRev, edits: {}, pathBase: {}, conflicts: [], risks: [], intent: [], verified: undefined, status: "active", goal: p.subject });
  } else {
    const { session } = repo.open({ id, agent, goal: p.subject });
    session.baseRev = p.baseRev;
  }
  for (const [path, content] of Object.entries(p.edits)) repo.write(id, path, content);
}

export async function handleReceive(view: GitView, body: Uint8Array, agent: string): Promise<{ body: Uint8Array; mutated: boolean }> {
  const repo = view.repo;
  const { pkts, next } = readPkts(body, 0, true);
  const cmds: { old: string; id: string; ref: string }[] = [];
  let caps = "";
  for (const p of pkts) {
    if (p.kind !== "data") continue;
    let t = pktText(p);
    const nul = t.indexOf("\0");
    if (nul >= 0) { caps = t.slice(nul + 1); t = t.slice(0, nul); }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(t);
    if (m) cmds.push({ old: m[1], id: m[2], ref: m[3] });
  }
  const results: { ref: string; err: string | null }[] = [];
  let unpack = "ok";
  let mutated = false;
  view.ensureAll();
  view.refs(); // registers session commits (thin-pack bases, parent detection)

  let objs: Map<string, GitObj> | undefined;
  const packBytes = body.subarray(next);
  if (cmds.some((c) => c.id !== ZERO_SHA) && packBytes.length) {
    try { objs = parsePack(packBytes, view.get); } catch (e) { unpack = String((e as Error).message).replace(/\s+/g, " "); }
  }
  const lookup: Lookup = (id) => objs?.get(id) ?? view.get(id);

  for (const c of cmds) {
    if (unpack !== "ok") { results.push({ ref: c.ref, err: "unpacker error" }); continue; }
    try {
      if (c.ref === MAIN_REF) {
        if (c.id === ZERO_SHA) throw new Error("deleting main is not allowed");
        const p = plan(view, lookup, c.id);
        if (!Object.keys(p.edits).length) { results.push({ ref: c.ref, err: null }); continue; }
        let id: string, n = 1;
        do id = `git-${slug(agent)}-${n++}`; while (id in repo.s.sessions);
        mutated = true;
        writeSession(repo, id, agent, p);
        const r = repo.submit(id);
        const left = `left open as ${SESSION_PREFIX}${id}`;
        let err: string | null = null;
        if (r.status === "conflicted") err = `conflict in ${(r.conflicts ?? []).map((x) => x.path).join(", ")}; ${left}`;
        else if (r.status === "needs_verify") err = `needs verification (${[...new Set((r.risks ?? []).map((x) => x.path))].join(", ")}); ${left}`;
        else if (r.status === "in_review") err = `awaiting review of protected paths; ${left}`;
        results.push({ ref: c.ref, err });
      } else if (c.ref.startsWith(SESSION_PREFIX)) {
        const id = c.ref.slice(SESSION_PREFIX.length);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("invalid session id");
        if (c.id === ZERO_SHA) {
          const s = repo.s.sessions[id];
          if (!s || !OPEN_STATUSES.includes(s.status)) throw new Error("no such open session");
          if (s.agent !== agent) throw new Error(`session belongs to ${s.agent}`);
          mutated = true;
          repo.abandon(id);
        } else {
          const p = plan(view, lookup, c.id);
          mutated = true;
          writeSession(repo, id, agent, p);
        }
        results.push({ ref: c.ref, err: null });
      } else results.push({ ref: c.ref, err: `only ${MAIN_REF} and ${SESSION_PREFIX}* can be pushed` });
    } catch (e) {
      results.push({ ref: c.ref, err: String((e as Error).message).replace(/\s+/g, " ") });
    }
  }

  if (!/\breport-status\b/.test(caps)) return { body: new Uint8Array(0), mutated };
  const report = concat([
    pkt(`unpack ${unpack}\n`),
    ...results.map((r) => pkt(r.err === null ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.err}\n`)),
    FLUSH,
  ]);
  return { body: /\bside-band-64k\b/.test(caps) ? concat([sideband(1, report), FLUSH]) : report, mutated };
}
