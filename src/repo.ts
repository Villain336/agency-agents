// Weave core: trunk + agent sessions. Pure, synchronous logic with no Cloudflare APIs, so it is easy
// to test. Model: there is one trunk per shard. Agents never create branches; they open a *session*
// pinned to a trunk revision, edit an overlay, declare intent, and land atomically via a 3-way merge
// against whatever trunk is *now*. Landing is gated by policy: required checks (run by pull-based
// runners), a semantic-interaction gate, and risk-tiered review. Every landed commit carries a
// signed, hash-chained provenance record.

import { canonical, hmacSha256, randomToken, sha256 } from "./crypto.ts";
import { diffStat, fileDiff, type FileDiff } from "./diff.ts";
import { merge3, resolveSegments, splitLines, type Choice, type Segment } from "./merge.ts";
import { DEFAULT_POLICY, scoreRisk, type Need, type Policy, type RiskReport } from "./review.ts";
import { semanticRisk, type Risk } from "./semantic.ts";
import { shardOf } from "./shard.ts";

export type Status = "active" | "conflicted" | "needs_verify" | "verifying" | "in_review" | "landed" | "rejected";
export const LIVE: Status[] = ["active", "conflicted", "needs_verify", "verifying", "in_review"];

export type Kind = "agent" | "human" | "verifier" | "reviewer" | "runner" | "admin";
export type Scope = "read" | "write" | "review" | "verify" | "runner" | "admin";

export const DEFAULT_SCOPES: Record<Kind, Scope[]> = {
  agent: ["read", "write"],
  human: ["read", "write", "review"],
  verifier: ["read", "verify"],
  reviewer: ["read", "review"],
  runner: ["read", "runner"],
  admin: ["read", "write", "review", "verify", "runner", "admin"],
};

export interface Identity {
  id: string;
  name: string;
  kind: Kind;
  scopes: Scope[];
  /** path prefixes this identity may write; empty = anywhere */
  paths: string[];
  budget: { sessionsPerHour?: number; landsPerHour?: number };
  model?: string;
  tokenHash: string;
  createdAt: number;
  disabled?: boolean;
}

export interface Actor {
  id: string;
  name: string;
  kind: Kind;
  scopes: Scope[];
  paths: string[];
  /** true in dev "open mode" where nothing is enforced */
  open?: boolean;
}

export interface Check {
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  events: string[]; // event types, or ["*"]
}

export interface Config {
  reviewPaths: string[];
  /** shard name -> path prefixes; paths matching none belong to "main" */
  shards: Record<string, string[]>;
  /** the shard this repo instance serves (only meaningful when shards is non-empty) */
  shard: string;
  checks: Check[];
  policy: Partial<Policy>;
  webhooks: Webhook[];
  mirror?: { url: string };
}

export interface Conflict {
  path: string;
  kind: "text" | "delete-modify" | "add-add";
  segments: Segment[];
}

export interface Evidence {
  check: string;
  passed: boolean;
  jobId: string;
  rev: number;
  ts: number;
  runner?: string;
  output?: string;
}

export interface Approval {
  by: string;
  kind: Kind | "unknown";
  ts: number;
}

export interface Session {
  id: string;
  agent: string;
  actorId?: string;
  model?: string;
  promptHash?: string;
  goal: string;
  baseRev: number;
  /** path -> new content, or null for deletion */
  edits: Record<string, string | null>;
  /** per-path rebase point, set when a conflict on that path was resolved */
  pathBase: Record<string, number>;
  intent: string[];
  status: Status;
  conflicts: Conflict[];
  /** concurrent-change interactions a verifier must sign off on before landing */
  risks: Risk[];
  risk?: RiskReport;
  verified?: { by: string; rev: number };
  approvals: Approval[];
  evidence: Evidence[];
  previews: string[];
  verifyingSince?: number;
  reviewer?: string;
  landedRev?: number;
  createdAt: number;
}

export interface Provenance {
  rev: number;
  sessionId: string;
  goal: string;
  actor: { id: string; name: string; kind: string; model?: string };
  promptHash?: string;
  baseRev: number;
  paths: string[];
  merged: boolean;
  risk?: { score: number; tier: string; reasons: string[] };
  semantic: Risk[];
  evidence: { check: string; passed: boolean; jobId: string; rev: number }[];
  verifiedBy?: string;
  approvals: { by: string; kind: string }[];
  ts: number;
  prevHash: string;
}

export interface Commit {
  rev: number;
  sessionId: string;
  agent: string;
  message: string;
  paths: string[];
  /** true when the merge had to combine changes made concurrently by others */
  merged: boolean;
  ts: number;
  provenance?: Provenance;
  /** sha256 over prevHash + provenance: tamper-evident chain */
  hash?: string;
}

export interface WeaveEvent {
  id: number;
  ts: number;
  type: string;
  agent?: string;
  session?: string;
  by?: string;
  message: string;
  /** audit chain: sha256(prevHash + event) */
  hash?: string;
}

export interface Job {
  id: string;
  sessionId: string;
  check: string;
  command: string;
  timeoutMs: number;
  status: "queued" | "running" | "passed" | "failed";
  rev: number;
  /** sessions speculatively layered under this one (train mode) */
  basis: string[];
  /** full set of changes applied on top of rev's tree when running */
  overlay: Record<string, string | null>;
  editHash: string;
  createdAt: number;
  claimedBy?: string;
  leaseUntil?: number;
  output?: string;
  durationMs?: number;
  previewUrl?: string;
  finishedAt?: number;
}

export interface Comment {
  id: string;
  sessionId: string;
  path: string;
  line: number;
  endLine?: number;
  author: string;
  body: string;
  suggestion?: string;
  parent?: string;
  blocking: boolean;
  resolved: boolean;
  ts: number;
}

export interface OutboxItem {
  id: string;
  hookId: string;
  event: WeaveEvent;
  attempts: number;
  nextAt: number;
  status: "pending" | "delivered" | "failed";
  lastError?: string;
}

export interface State {
  rev: number;
  /** path -> versions, ascending by rev; content null = deleted */
  files: Record<string, { rev: number; content: string | null }[]>;
  commits: Commit[];
  sessions: Record<string, Session>;
  events: WeaveEvent[];
  identities: Record<string, Identity>;
  comments: Record<string, Comment>;
  jobs: Record<string, Job>;
  outbox: OutboxItem[];
  config: Config;
  secrets: { signingKey: string };
  auditHead: string;
  mirror: { lastRev: number };
  seq: { event: number; comment: number; job: number; outbox: number; identity: number };
  /** legacy mirror of config.reviewPaths, kept for older clients */
  reviewPaths: string[];
}

export class WeaveError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const defaultConfig = (): Config => ({ reviewPaths: [], shards: {}, shard: "main", checks: [], policy: {}, webhooks: [] });

export const emptyState = (): State => ({
  rev: 0, files: {}, commits: [], sessions: {}, events: [], identities: {}, comments: {}, jobs: {}, outbox: [],
  config: defaultConfig(), secrets: { signingKey: randomToken("sk", 32) }, auditHead: "", mirror: { lastRev: 0 },
  seq: { event: 0, comment: 0, job: 0, outbox: 0, identity: 0 }, reviewPaths: [],
});

/** Fill fields older persisted states don't have. */
export function upgradeState(s: Partial<State>): State {
  const e = emptyState();
  const st = { ...e, ...s } as State;
  st.config = { ...defaultConfig(), ...(s.config ?? {}) };
  if (s.reviewPaths?.length && !st.config.reviewPaths.length) st.config.reviewPaths = s.reviewPaths;
  st.seq = { ...e.seq, ...(s.seq ?? {}) };
  st.secrets = s.secrets ?? e.secrets;
  for (const x of Object.values(st.sessions)) {
    x.approvals ??= [];
    x.evidence ??= [];
    x.previews ??= [];
    x.risks ??= [];
  }
  return st;
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);

export class Repo {
  s: State;
  /** session ids mutated since the last persist (the store diffs everything else) */
  dirtySessions = new Set<string>();
  private now: () => number;
  private pumping = false;

  constructor(s: State = emptyState(), now: () => number = Date.now) {
    this.s = s;
    this.now = now;
  }

  get config(): Config {
    return this.s.config;
  }
  policy(): Policy {
    return { ...DEFAULT_POLICY, ...this.s.config.policy };
  }

  // ---- trunk ----------------------------------------------------------
  fileAt(path: string, rev: number): string | null {
    const v = this.s.files[path];
    if (!v) return null;
    for (let i = v.length - 1; i >= 0; i--) if (v[i].rev <= rev) return v[i].content;
    return null;
  }
  head(path: string) {
    return this.fileAt(path, this.s.rev);
  }
  listFiles(rev = this.s.rev): string[] {
    return Object.keys(this.s.files).filter((p) => this.fileAt(p, rev) !== null).sort();
  }
  filesAt(rev = this.s.rev): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.listFiles(rev)) out[p] = this.fileAt(p, rev)!;
    return out;
  }

  private commit(sessionId: string, agent: string, message: string, changes: Record<string, string | null>, merged: boolean, prov?: Omit<Provenance, "rev" | "prevHash" | "ts" | "paths" | "merged" | "sessionId" | "baseRev"> & { baseRev?: number }) {
    const rev = ++this.s.rev;
    for (const [p, content] of Object.entries(changes)) (this.s.files[p] ??= []).push({ rev, content });
    const ts = this.now();
    const prevHash = this.s.commits.at(-1)?.hash ?? "";
    const provenance: Provenance = {
      semantic: [], evidence: [], approvals: [], goal: message, actor: { id: "system", name: agent, kind: "system" },
      ...prov, rev, sessionId, baseRev: prov?.baseRev ?? rev - 1, paths: Object.keys(changes).sort(), merged, ts, prevHash,
    };
    const hash = sha256(prevHash + canonical(provenance));
    this.s.commits.push({ rev, sessionId, agent, message, paths: Object.keys(changes), merged, ts, provenance, hash });
    return rev;
  }

  /** Seed trunk directly (no session). */
  seed(files: Record<string, string>, message = "seed") {
    return this.commit("seed", "system", message, files, false);
  }

  setReviewPaths(paths: string[]) {
    this.s.config.reviewPaths = paths;
    this.s.reviewPaths = paths;
  }

  setConfig(patch: Partial<Config>) {
    const c = this.s.config;
    if (patch.reviewPaths) this.setReviewPaths(patch.reviewPaths);
    if (patch.shards) c.shards = patch.shards;
    if (patch.shard) c.shard = patch.shard;
    if (patch.checks) c.checks = patch.checks.map((k) => ({ name: k.name, command: k.command, timeoutMs: k.timeoutMs ?? 120_000 }));
    if (patch.policy) c.policy = patch.policy;
    if (patch.mirror !== undefined) c.mirror = patch.mirror;
    if (patch.webhooks)
      c.webhooks = patch.webhooks.map((w, i) => ({ id: w.id ?? `wh${i + 1}`, url: w.url, secret: w.secret ?? "", events: w.events?.length ? w.events : ["*"] }));
    this.log("config", "repository configuration updated");
  }

  // ---- audit log + webhook outbox --------------------------------------
  private log(type: string, message: string, s?: Session, by?: string) {
    const id = ++this.s.seq.event;
    const base = { id, ts: this.now(), type, message, agent: s?.agent, session: s?.id, by };
    const hash = sha256(this.s.auditHead + canonical(base));
    this.s.auditHead = hash;
    const ev: WeaveEvent = { ...base, hash };
    this.s.events.push(ev);
    if (this.s.events.length > 500) this.s.events.splice(0, this.s.events.length - 500);
    for (const w of this.s.config.webhooks) {
      if (w.events.includes("*") || w.events.includes(type))
        this.s.outbox.push({ id: `d${++this.s.seq.outbox}`, hookId: w.id, event: ev, attempts: 0, nextAt: ev.ts, status: "pending" });
    }
    if (this.s.outbox.length > 500) this.s.outbox = this.s.outbox.filter((o) => o.status === "pending").concat(this.s.outbox.filter((o) => o.status !== "pending").slice(-200));
  }

  // ---- identities ------------------------------------------------------
  createIdentity(o: { name: string; kind: Kind; scopes?: Scope[]; paths?: string[]; budget?: Identity["budget"]; model?: string }) {
    if (!o.name || !/^[\w.-]+$/.test(o.name)) throw new WeaveError("identity name must match [A-Za-z0-9_.-]+");
    if (!(o.kind in DEFAULT_SCOPES)) throw new WeaveError(`unknown kind: ${o.kind}`);
    if (Object.values(this.s.identities).some((i) => i.name === o.name && !i.disabled)) throw new WeaveError(`identity ${o.name} already exists`, 409);
    const token = randomToken("wv", 24);
    const id = `id${++this.s.seq.identity}`;
    const identity: Identity = {
      id, name: o.name, kind: o.kind, scopes: o.scopes ?? DEFAULT_SCOPES[o.kind], paths: o.paths ?? [], budget: o.budget ?? {},
      model: o.model, tokenHash: sha256(token), createdAt: this.now(),
    };
    this.s.identities[id] = identity;
    this.log("identity", `created ${o.kind} identity ${o.name}`);
    return { identity: this.publicIdentity(identity), token };
  }
  private publicIdentity(i: Identity) {
    const { tokenHash: _t, ...rest } = i;
    return rest;
  }
  listIdentities() {
    return Object.values(this.s.identities).map((i) => this.publicIdentity(i));
  }
  authenticate(token: string): Actor | null {
    const h = sha256(token);
    for (const i of Object.values(this.s.identities)) {
      if (!i.disabled && i.tokenHash === h) return { id: i.id, name: i.name, kind: i.kind, scopes: i.scopes, paths: i.paths };
    }
    return null;
  }
  revokeIdentity(id: string) {
    const i = this.s.identities[id];
    if (!i) throw new WeaveError(`no such identity: ${id}`, 404);
    i.disabled = true;
    this.log("identity", `revoked identity ${i.name}`);
  }
  identityOf(actorId?: string): Identity | undefined {
    return actorId ? this.s.identities[actorId] : undefined;
  }

  private checkBudget(actor: Actor | undefined, what: "open" | "land") {
    if (!actor || actor.open) return;
    const b = this.s.identities[actor.id]?.budget;
    const limit = what === "open" ? b?.sessionsPerHour : b?.landsPerHour;
    if (limit === undefined) return;
    const since = this.now() - 3_600_000;
    const used =
      what === "open"
        ? Object.values(this.s.sessions).filter((x) => x.actorId === actor.id && x.createdAt > since).length
        : this.s.commits.filter((c) => c.ts > since && c.provenance?.actor.id === actor.id).length;
    if (used >= limit) throw new WeaveError(`${actor.name} exceeded its budget of ${limit} ${what === "open" ? "sessions" : "landings"} per hour`, 429);
  }

  // ---- sessions -------------------------------------------------------
  session(id: string): Session {
    const s = this.s.sessions[id];
    if (!s) throw new WeaveError(`no such session: ${id}`, 404);
    this.dirtySessions.add(id);
    return s;
  }
  sessionRO(id: string): Session {
    const s = this.s.sessions[id];
    if (!s) throw new WeaveError(`no such session: ${id}`, 404);
    return s;
  }

  private assertOwner(s: Session, actor?: Actor) {
    if (!actor || actor.open || actor.scopes.includes("admin")) return;
    if (s.actorId && s.actorId !== actor.id) throw new WeaveError(`session ${s.id} belongs to ${s.agent}`, 403);
  }

  open(opts: { id?: string; agent: string; goal: string; intent?: string[]; actor?: Actor; model?: string; prompt?: string }): { session: Session; warnings: string[] } {
    this.checkBudget(opts.actor, "open");
    const id = opts.id ?? `${opts.agent}-${Object.keys(this.s.sessions).length + 1}`;
    const existing = this.s.sessions[id];
    if (existing && LIVE.includes(existing.status)) throw new WeaveError(`session ${id} is still ${existing.status}`, 409);
    const ident = this.identityOf(opts.actor?.id);
    const session: Session = {
      id, agent: opts.agent, actorId: opts.actor && !opts.actor.open ? opts.actor.id : undefined, model: opts.model ?? ident?.model,
      promptHash: opts.prompt ? sha256(opts.prompt) : undefined, goal: opts.goal, baseRev: this.s.rev, edits: {}, pathBase: {},
      intent: [], status: "active", conflicts: [], risks: [], approvals: [], evidence: [], previews: [], createdAt: this.now(),
    };
    this.s.sessions[id] = session;
    this.dirtySessions.add(id);
    this.log("open", `${opts.agent} started: ${opts.goal}`, session);
    return { session, warnings: this.declare(id, opts.intent ?? [], true) };
  }

  /** Declare which paths this session intends to touch; returns overlap warnings with live sessions. */
  declare(id: string, paths: string[], quiet = false): string[] {
    const s = this.session(id);
    s.intent = [...new Set([...s.intent, ...paths])];
    const warnings: string[] = [];
    for (const o of Object.values(this.s.sessions)) {
      if (o.id === id || !LIVE.includes(o.status)) continue;
      const overlap = s.intent.filter((p) => o.intent.includes(p) || p in o.edits);
      if (overlap.length) warnings.push(`${o.agent} is also working on ${overlap.join(", ")} (${o.goal})`);
    }
    if (!quiet && paths.length) this.log("intent", `${s.agent} intends to touch ${paths.join(", ")}`, s);
    if (warnings.length) this.log("overlap", `heads-up for ${s.agent}: ${warnings.join("; ")}`, s);
    return warnings;
  }

  read(id: string, path: string): string | null {
    const s = this.sessionRO(id);
    return path in s.edits ? s.edits[path] : this.fileAt(path, s.baseRev);
  }

  private assertWritable(path: string, actor?: Actor) {
    const c = this.s.config;
    if (Object.keys(c.shards).length) {
      const owner = shardOf(path, c.shards);
      if (owner !== c.shard) throw new WeaveError(`${path} belongs to shard "${owner}", this session is on shard "${c.shard}"; open a session there`, 409);
    }
    if (actor && !actor.open && actor.paths.length && !actor.paths.some((p) => path.startsWith(p)))
      throw new WeaveError(`${actor.name} may not write ${path} (allowed: ${actor.paths.join(", ")})`, 403);
  }

  write(id: string, path: string, content: string | null, actor?: Actor) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    if (s.status === "landed" || s.status === "rejected") throw new WeaveError(`session ${id} is ${s.status}`, 409);
    if (s.status === "conflicted") throw new WeaveError(`session ${id} has unresolved conflicts; resolve them first`, 409);
    this.assertWritable(path, actor);
    s.edits[path] = content;
    s.verified = undefined; // an attestation covers the content it saw
    s.approvals = [];
    if (!s.intent.includes(path)) s.intent.push(path);
    s.status = "active";
  }

  // ---- landing --------------------------------------------------------
  private mergeAll(s: Session, overlay: Record<string, string | null> = {}): { changes: Record<string, string | null>; conflicts: Conflict[]; merged: boolean; risks: Risk[] } {
    const changes: Record<string, string | null> = {};
    const conflicts: Conflict[] = [];
    const risks: Risk[] = [];
    let merged = false;
    for (const [path, theirs] of Object.entries(s.edits)) {
      const baseRev = s.pathBase[path] ?? s.baseRev;
      const base = this.fileAt(path, baseRev);
      const ours = path in overlay ? overlay[path] : this.head(path);
      if (theirs === ours) { if (ours !== base) merged = true; continue; } // already there
      if (ours === base) { changes[path] = theirs; continue; } // trunk untouched: fast-forward
      merged = true;
      const whole = (kind: Conflict["kind"]) =>
        conflicts.push({ path, kind, segments: [{ kind: "conflict", base: splitLines(base ?? ""), ours: splitLines(ours ?? ""), theirs: splitLines(theirs ?? "") }] });
      if (base === null) { whole("add-add"); continue; }
      if (ours === null || theirs === null) { whole("delete-modify"); continue; }
      const r = merge3(base, ours, theirs);
      if (r.conflicts) conflicts.push({ path, kind: "text", segments: r.segments });
      else {
        changes[path] = r.text;
        risks.push(...semanticRisk(path, base, ours, theirs));
      }
    }
    return { changes, conflicts, merged, risks };
  }

  private editHash(s: Session) {
    return sha256(canonical(s.edits));
  }

  /** An attestation holds while no later trunk commit has touched this session's paths. */
  private attested(s: Session): boolean {
    const v = s.verified;
    if (!v) return false;
    const paths = new Set(Object.keys(s.edits));
    return !this.s.commits.some((c) => c.rev > v.rev && c.paths.some((p) => paths.has(p)));
  }

  /** Dry-run: what trunk would look like for this session's paths if it landed now. */
  preview(id: string) {
    const s = this.sessionRO(id);
    const r = this.mergeAll(s);
    return { baseRev: this.s.rev, merged: r.merged, files: r.changes, conflicts: r.conflicts, risks: r.risks };
  }

  private riskOf(s: Session, r: ReturnType<Repo["mergeAll"]>): RiskReport {
    const mine = Object.values(this.s.sessions).filter((x) => x.agent === s.agent && x.id !== s.id).slice(-5);
    return scoreRisk({
      paths: Object.keys(r.changes), before: (p) => this.head(p), after: r.changes, semantic: r.risks, merged: r.merged,
      protectedPaths: this.s.config.reviewPaths, recentRejects: mine.filter((x) => x.status === "rejected").length, policy: this.policy(),
    });
  }

  /** Try to land a session onto trunk atomically, subject to policy gates. */
  submit(id: string, message?: string, actor?: Actor): { status: Status; rev?: number; conflicts?: Conflict[]; risks?: Risk[]; risk?: RiskReport; jobs?: string[]; evidence?: Evidence[] } {
    const s = this.session(id);
    this.assertOwner(s, actor);
    if (s.status === "landed" || s.status === "rejected") throw new WeaveError(`session ${id} is ${s.status}`, 409);
    if (!Object.keys(s.edits).length) throw new WeaveError("nothing to land: session has no edits");
    const r = this.mergeAll(s);
    if (r.conflicts.length) {
      s.status = "conflicted";
      s.conflicts = r.conflicts;
      this.log("conflict", `${s.agent} hit ${r.conflicts.length} conflict(s) in ${r.conflicts.map((c) => c.path).join(", ")}`, s);
      return { status: "conflicted", conflicts: r.conflicts };
    }
    s.conflicts = [];
    s.risks = r.risks;
    if (!Object.keys(r.changes).length) {
      // every edit already matches trunk: nothing to commit
      s.status = "landed";
      s.landedRev = this.s.rev;
      this.log("noop", `${s.agent}'s change was already on trunk; nothing to land`, s);
      return { status: "landed", rev: this.s.rev };
    }
    const risk = (s.risk = this.riskOf(s, r));

    // 1. required checks, run by pull-based runners
    let checked = false;
    if (this.s.config.checks.length) {
      const st = this.ensureChecks(s, r.changes);
      if (st === "fail") {
        s.status = "active";
        const failed = s.evidence.filter((e) => !e.passed).slice(-3);
        this.log("checks_failed", `${s.agent}'s checks failed: ${failed.map((e) => e.check).join(", ")}`, s);
        return { status: "active", evidence: failed, risk };
      }
      if (st === "pending") {
        s.verifyingSince ??= this.now();
        if (s.status !== "verifying") this.log("verifying", `${s.agent}'s change is waiting on ${this.s.config.checks.length} check(s)`, s);
        s.status = "verifying";
        return { status: "verifying", jobs: Object.values(this.s.jobs).filter((j) => j.sessionId === id && (j.status === "queued" || j.status === "running")).map((j) => j.id), risk };
      }
      checked = true;
    }
    // 2. semantic-interaction gate: checks passing on the merged result, or a verifier's attestation, clears it
    if (r.risks.length && !checked && !this.attested(s)) {
      s.status = "needs_verify";
      this.log("needs_verify", `${s.agent}'s change merged cleanly but interacts with concurrent work (${r.risks.map((k) => k.symbols[0] + ` in ${k.path}`).join(", ")}); needs a verifier`, s);
      return { status: "needs_verify", risks: r.risks, risk };
    }
    // 3. risk-tiered review
    if (risk.need !== "none" && !this.approved(s, risk.need)) {
      if (s.status !== "in_review") this.log("review_requested", `${s.agent}'s ${risk.tier}-risk change (${risk.score}) needs ${risk.need === "human" ? "a human" : "a"} reviewer: ${risk.reasons.slice(0, 3).join("; ")}`, s);
      s.status = "in_review";
      return { status: "in_review", risk };
    }
    return this.land(s, r.changes, r.merged, risk, message, actor);
  }

  private approved(s: Session, need: Need): boolean {
    const ok = s.approvals.filter((a) => a.by !== s.agent);
    if (need === "any") return ok.length > 0;
    return ok.some((a) => a.kind === "human");
  }

  private land(s: Session, changes: Record<string, string | null>, merged: boolean, risk: RiskReport, message?: string, actor?: Actor) {
    this.checkBudget(actor ?? this.actorFor(s), "land");
    const msg = message ?? s.goal;
    const ident = this.identityOf(s.actorId);
    s.landedRev = this.commit(s.id, s.agent, msg, changes, merged, {
      goal: s.goal, actor: { id: s.actorId ?? "open", name: s.agent, kind: ident?.kind ?? "agent", model: s.model }, promptHash: s.promptHash,
      baseRev: s.baseRev, risk: { score: risk.score, tier: risk.tier, reasons: risk.reasons }, semantic: s.risks,
      evidence: s.evidence.filter((e) => e.passed).map((e) => ({ check: e.check, passed: e.passed, jobId: e.jobId, rev: e.rev })),
      verifiedBy: s.verified?.by, approvals: s.approvals.map((a) => ({ by: a.by, kind: a.kind })),
    });
    s.status = "landed";
    this.log("landed", `${s.agent} landed r${s.landedRev}${merged ? " (auto-merged with concurrent work)" : ""}: ${msg}`, s);
    this.pump();
    return { status: "landed" as Status, rev: s.landedRev, risk };
  }

  private actorFor(s: Session): Actor | undefined {
    const i = this.identityOf(s.actorId);
    return i ? { id: i.id, name: i.name, kind: i.kind, scopes: i.scopes, paths: i.paths } : undefined;
  }

  /** After a landing, sessions parked on checks may now be able to land. */
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const waiting = Object.values(this.s.sessions).filter((x) => x.status === "verifying").sort((a, b) => (a.verifyingSince ?? 0) - (b.verifyingSince ?? 0));
      for (const w of waiting) if (w.status === "verifying") this.submit(w.id);
    } finally {
      this.pumping = false;
    }
  }

  // ---- checks / runner jobs -------------------------------------------
  private jobState(j: Job, s: Session): "pass" | "fail" | "pending" | "stale" {
    if (j.status === "queued" || j.status === "running") return "pending";
    if (j.status === "failed") return "fail";
    const later = this.s.commits.filter((c) => c.rev > j.rev);
    const mode = this.policy().evidence;
    if (mode === "strict") return later.length ? "stale" : "pass";
    if (mode === "train") {
      for (const id of j.basis) {
        const b = this.s.sessions[id];
        if (!b) return "stale";
        if (b.status === "landed") continue;
        if (b.status === "verifying" || b.status === "in_review" || b.status === "needs_verify") return "pending";
        return "stale";
      }
      return later.every((c) => j.basis.includes(c.sessionId)) ? "pass" : "stale";
    }
    const paths = new Set(Object.keys(s.edits));
    return later.some((c) => c.paths.some((p) => paths.has(p))) ? "stale" : "pass";
  }

  private ensureChecks(s: Session, changes: Record<string, string | null>): "pass" | "pending" | "fail" {
    const eh = this.editHash(s);
    let pending = false;
    for (const check of this.s.config.checks) {
      const latest = Object.values(this.s.jobs).filter((j) => j.sessionId === s.id && j.check === check.name && j.editHash === eh).sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0];
      if (latest) {
        const st = this.jobState(latest, s);
        if (st === "pass") continue;
        if (st === "fail") return "fail";
        if (st === "pending") { pending = true; continue; }
      }
      this.enqueue(s, check, changes, eh);
      pending = true;
    }
    return pending ? "pending" : "pass";
  }

  private enqueue(s: Session, check: Check, changes: Record<string, string | null>, editHash: string) {
    let overlay: Record<string, string | null> = {};
    const basis: string[] = [];
    let mine = changes;
    if (this.policy().evidence === "train") {
      s.verifyingSince ??= this.now();
      const preds = Object.values(this.s.sessions).filter((x) => x.id !== s.id && x.status === "verifying" && (x.verifyingSince ?? 0) < s.verifyingSince!).sort((a, b) => (a.verifyingSince ?? 0) - (b.verifyingSince ?? 0));
      for (const p of preds) {
        const pr = this.mergeAll(p, overlay);
        if (!pr.conflicts.length) { Object.assign(overlay, pr.changes); basis.push(p.id); }
      }
      if (basis.length) {
        const mr = this.mergeAll(s, overlay);
        if (mr.conflicts.length) { overlay = {}; basis.length = 0; } else mine = mr.changes;
      }
    }
    const id = `j${++this.s.seq.job}`;
    this.s.jobs[id] = { id, sessionId: s.id, check: check.name, command: check.command, timeoutMs: check.timeoutMs ?? 120_000, status: "queued", rev: this.s.rev, basis, overlay: { ...overlay, ...mine }, editHash, createdAt: this.now() };
    this.log("job_queued", `check "${check.name}" queued for ${s.agent}${basis.length ? ` (speculatively on top of ${basis.length} queued change(s))` : ""}`, s);
    const live = Object.values(this.s.jobs);
    if (live.length > 300) for (const j of live.slice(0, live.length - 300)) if (j.status === "passed" || j.status === "failed") delete this.s.jobs[j.id];
  }

  /** A runner pulls the next job. Expired leases are requeued first. */
  claimJob(runner: string, leaseMs = 300_000): (Job & { files: Record<string, string> }) | null {
    const t = this.now();
    for (const j of Object.values(this.s.jobs)) if (j.status === "running" && (j.leaseUntil ?? 0) < t) j.status = "queued";
    const next = Object.values(this.s.jobs)
      .filter((j) => j.status === "queued" && this.s.sessions[j.sessionId]?.status === "verifying")
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
    if (!next) return null;
    next.status = "running";
    next.claimedBy = runner;
    next.leaseUntil = t + leaseMs;
    const files = this.filesAt(next.rev);
    for (const [p, c] of Object.entries(next.overlay)) c === null ? delete files[p] : (files[p] = c);
    return { ...next, files };
  }

  jobResult(id: string, runner: string, r: { passed: boolean; output?: string; durationMs?: number; previewUrl?: string }) {
    const j = this.s.jobs[id];
    if (!j) throw new WeaveError(`no such job: ${id}`, 404);
    if (j.status !== "running") throw new WeaveError(`job ${id} is ${j.status}`, 409);
    if (j.claimedBy && j.claimedBy !== runner) throw new WeaveError(`job ${id} is leased to another runner`, 403);
    j.status = r.passed ? "passed" : "failed";
    j.output = clip(r.output ?? "");
    j.durationMs = r.durationMs;
    j.previewUrl = r.previewUrl;
    j.finishedAt = this.now();
    const s = this.session(j.sessionId);
    s.evidence.push({ check: j.check, passed: r.passed, jobId: j.id, rev: j.rev, ts: this.now(), runner, output: j.output });
    if (r.previewUrl) s.previews.push(r.previewUrl);
    this.log(r.passed ? "check_passed" : "check_failed", `${runner} ran "${j.check}" for ${s.agent}: ${r.passed ? "passed" : "FAILED"}`, s, runner);
    if (s.status === "verifying") this.submit(s.id);
    this.pump(); // a failure may invalidate speculative jobs queued behind this one
    return { job: j, session: s.status };
  }

  /** Forget failed evidence for the session's current edits so checks run again (e.g. after a flake). */
  rerunChecks(id: string) {
    const s = this.session(id);
    const eh = this.editHash(s);
    for (const j of Object.values(this.s.jobs)) if (j.sessionId === id && j.editHash === eh && j.status === "failed") delete this.s.jobs[j.id];
    return this.submit(id);
  }

  // ---- conflicts, verification, review ---------------------------------
  /** Resolve conflicts on one path with explicit choices or a blanket strategy; keeps the session open. */
  resolve(id: string, path: string, how: Choice[] | "ours" | "theirs" | "both", actor?: Actor) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    const c = s.conflicts.find((x) => x.path === path);
    if (!c) throw new WeaveError(`no conflict on ${path}`, 404);
    const n = c.segments.filter((x) => x.kind === "conflict").length;
    const choices = typeof how === "string" ? Array<Choice>(n).fill(how) : how;
    if (c.kind !== "text") {
      const ch = choices[0];
      const seg = c.segments[0] as Extract<Segment, { kind: "conflict" }>;
      const pick = ch === "ours" ? seg.ours : ch === "theirs" ? seg.theirs : ch === "both" ? [...seg.ours, ...seg.theirs] : splitLines((ch as { text: string }).text);
      const deleted = (ch === "ours" && this.head(path) === null) || (ch === "theirs" && s.edits[path] === null);
      s.edits[path] = deleted ? null : pick.join("\n");
    } else s.edits[path] = resolveSegments(c.segments, choices);
    s.pathBase[path] = this.s.rev;
    s.conflicts = s.conflicts.filter((x) => x !== c);
    s.verified = undefined;
    s.approvals = [];
    this.log("resolve", `${s.agent} resolved ${path}`, s);
    if (!s.conflicts.length) s.status = "active";
    return s;
  }

  /** A verifier (test runner, reviewer agent) attests the merged result is sound, or sends it back. */
  verify(id: string, verifier: string, passed: boolean, note = "") {
    const s = this.session(id);
    if (s.status !== "needs_verify") throw new WeaveError(`session ${id} is not awaiting verification`, 409);
    if (verifier === s.agent) throw new WeaveError("an agent cannot verify its own change", 403);
    if (!passed) {
      s.status = "active";
      this.log("verify_failed", `${verifier} rejected the merged result of ${s.agent}'s change${note ? `: ${note}` : ""}`, s, verifier);
      return { status: s.status };
    }
    s.verified = { by: verifier, rev: this.s.rev };
    this.log("verified", `${verifier} verified ${s.agent}'s merged change`, s, verifier);
    s.status = "active";
    return this.submit(id);
  }

  review(id: string, reviewer: string | { name: string; kind?: Kind | "unknown" }, approve: boolean, note = "") {
    const who = typeof reviewer === "string" ? { name: reviewer, kind: "unknown" as const } : { name: reviewer.name, kind: reviewer.kind ?? "unknown" };
    const s = this.session(id);
    if (s.status !== "in_review") throw new WeaveError(`session ${id} is not awaiting review`, 409);
    if (who.name === s.agent) throw new WeaveError("an agent cannot review its own change", 403);
    if (!approve) {
      s.status = "rejected";
      this.log("rejected", `${who.name} rejected ${s.agent}'s change${note ? `: ${note}` : ""}`, s, who.name);
      return { status: s.status };
    }
    const open = Object.values(this.s.comments).filter((c) => c.sessionId === id && c.blocking && !c.resolved && !c.parent);
    if (open.length) throw new WeaveError(`${open.length} blocking comment thread(s) are unresolved`, 409);
    s.approvals.push({ by: who.name, kind: who.kind, ts: this.now() });
    s.reviewer = who.name;
    this.log("approved", `${who.name} approved ${s.agent}'s change`, s, who.name);
    return this.submit(id); // re-merge against *current* trunk; approval never lands a stale diff
  }

  abandon(id: string, actor?: Actor) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    s.status = "rejected";
    this.log("abandoned", `${s.agent} abandoned their session`, s);
    this.pump();
  }

  // ---- review experience ------------------------------------------------
  addComment(id: string, c: { path: string; line: number; endLine?: number; author: string; body: string; suggestion?: string; parent?: string; blocking?: boolean }): Comment {
    const s = this.session(id);
    if (!c.body?.trim() && c.suggestion === undefined) throw new WeaveError("comment needs a body or a suggestion");
    if (c.parent && !this.s.comments[c.parent]) throw new WeaveError(`no such comment: ${c.parent}`, 404);
    const cm: Comment = { id: `c${++this.s.seq.comment}`, sessionId: id, path: c.path, line: c.line, endLine: c.endLine, author: c.author, body: c.body ?? "", suggestion: c.suggestion, parent: c.parent, blocking: !!c.blocking, resolved: false, ts: this.now() };
    this.s.comments[cm.id] = cm;
    this.log("comment", `${c.author} commented on ${c.path}:${c.line}${c.suggestion !== undefined ? " (with a suggested change)" : ""}`, s, c.author);
    return cm;
  }
  resolveComment(commentId: string, by: string) {
    const c = this.s.comments[commentId];
    if (!c) throw new WeaveError(`no such comment: ${commentId}`, 404);
    const root = c.parent ? this.s.comments[c.parent] ?? c : c;
    root.resolved = true;
    this.log("comment_resolved", `${by} resolved a thread on ${root.path}:${root.line}`, this.sessionRO(root.sessionId), by);
    return root;
  }
  /** Apply a reviewer's suggested change to the session's own overlay (owner only). */
  applySuggestion(commentId: string, actor?: Actor) {
    const c = this.s.comments[commentId];
    if (!c || c.suggestion === undefined) throw new WeaveError("comment has no suggestion", 404);
    const s = this.session(c.sessionId);
    const cur = this.read(s.id, c.path);
    if (cur === null) throw new WeaveError(`${c.path} does not exist in this session`, 409);
    const lines = splitLines(cur);
    lines.splice(c.line - 1, (c.endLine ?? c.line) - c.line + 1, ...splitLines(c.suggestion));
    this.write(s.id, c.path, lines.join("\n"), actor);
    this.resolveComment(commentId, s.agent);
    return s;
  }
  comments(id: string) {
    return Object.values(this.s.comments).filter((c) => c.sessionId === id);
  }

  /** Everything a reviewer needs, ranked by what matters: risk, evidence, then per-file diffs. */
  reviewPack(id: string) {
    const s = this.sessionRO(id);
    const r = this.mergeAll(s);
    const risk = r.conflicts.length ? undefined : this.riskOf(s, r);
    const files: FileDiff[] = Object.entries(r.changes).map(([p, after]) => fileDiff(p, this.head(p), after));
    return {
      id: s.id, agent: s.agent, goal: s.goal, status: s.status, model: s.model, baseRev: s.baseRev, headRev: this.s.rev,
      risk, need: risk?.need, approvals: s.approvals, semantic: r.risks, conflicts: r.conflicts.map((c) => ({ path: c.path, kind: c.kind })),
      evidence: s.evidence.map((e) => ({ check: e.check, passed: e.passed, rev: e.rev, runner: e.runner })), previews: s.previews,
      stats: { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) },
      files, comments: this.comments(id),
    };
  }

  /** Human attention budget: the riskiest waiting items first, capped; the rest are deferred. */
  reviewQueue(kind: Kind | "unknown" = "unknown") {
    const waiting = Object.values(this.s.sessions).filter((x) => x.status === "in_review");
    const ranked = waiting
      .map((x) => ({ id: x.id, agent: x.agent, goal: x.goal, score: x.risk?.score ?? 0, tier: x.risk?.tier ?? "medium", need: x.risk?.need ?? "any", waitingMs: this.now() - x.createdAt }))
      .sort((a, b) => b.score - a.score || b.waitingMs - a.waitingMs);
    const eligible = ranked.filter((x) => x.need !== "human" || kind === "human" || kind === "admin" || kind === "unknown");
    const budget = this.policy().attentionBudget;
    return { budget, next: eligible.slice(0, budget), deferred: eligible.slice(budget), notForYou: ranked.filter((x) => !eligible.includes(x)) };
  }

  // ---- provenance -----------------------------------------------------
  signature(c: Commit): string {
    return hmacSha256(this.s.secrets.signingKey, c.hash ?? "");
  }
  provenance(rev: number) {
    const c = this.s.commits.find((x) => x.rev === rev);
    if (!c) throw new WeaveError(`no such revision: r${rev}`, 404);
    return { rev, record: c.provenance, hash: c.hash, signature: this.signature(c) };
  }
  /** Recompute the whole chain; any edited, removed or reordered record is detected. */
  verifyChain(): { ok: boolean; checked: number; firstBad?: number } {
    let prev = "";
    for (const c of this.s.commits) {
      if (!c.provenance) continue;
      if (c.provenance.prevHash !== prev || sha256(prev + canonical(c.provenance)) !== c.hash) return { ok: false, checked: c.rev - 1, firstBad: c.rev };
      prev = c.hash!;
    }
    return { ok: true, checked: this.s.commits.length };
  }
  verifyAudit(): { ok: boolean; checked: number } {
    // the in-memory window is a suffix of the chain; verify internal consistency of the window
    let prev: string | undefined;
    for (const e of this.s.events) {
      if (prev !== undefined) {
        const { hash, ...base } = e;
        if (sha256(prev + canonical(base)) !== hash) return { ok: false, checked: e.id };
      }
      prev = e.hash;
    }
    return { ok: true, checked: this.s.events.length };
  }

  /** Snapshot for read APIs (never includes secrets or token hashes). */
  publicState() {
    const { secrets: _s, identities: _i, jobs: _j, outbox: _o, ...rest } = this.s;
    return rest;
  }
}
