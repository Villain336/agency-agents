// Discrete-event simulation of N agents landing changes under three workflows, on virtual time.
//   push-race  : fetch, change, CI, push; a rejected push means fetch+rebase+CI again (what agents do with plain git)
//   queue(C)   : a merge queue that builds C PRs at once on top of the queue ahead of them; conflicts are ejected and re-queued
//   weave(R)   : the real Weave Repo (train mode) with R check runners; conflicts come back to the agent
// Baseline merges use real `git merge-file`; Weave uses its own Repo code unchanged.
import { Repo } from "../src/repo.ts";
import { gitMerge3 } from "./gitmerge.ts";
import { lostUpdates, makeOps, seedFiles, type Op, type WorkloadOptions } from "./workload.ts";

export interface SimParams {
  workload: WorkloadOptions;
  /** CI duration for one build, seconds */
  ciSec: number;
  /** time for an agent to redo its change after a conflict, seconds */
  reworkSec: number;
  /** time for a verifier to attest a flagged merge (Weave only), seconds */
  verifySec: number;
  /** build concurrency: queue batch size / number of Weave runners */
  concurrency: number;
}

export interface Result {
  policy: string;
  agents: number;
  makespanSec: number;
  ciRuns: number;
  retries: number;
  conflicts: number;
  verifications: number;
  lostUpdates: number;
  landed: number;
  p50Sec: number;
  p95Sec: number;
  landings: number[];
}

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
function finish(policy: string, ops: Op[], files: Record<string, string>, t: number[], m: Partial<Result>): Result {
  return { policy, agents: ops.length, makespanSec: Math.max(0, ...t), ciRuns: 0, retries: 0, conflicts: 0, verifications: 0, lostUpdates: lostUpdates(files, ops), landed: t.length, p50Sec: pct(t, 0.5), p95Sec: pct(t, 0.95), landings: [...t].sort((a, b) => a - b), ...m };
}

class Events<T> {
  private q: { t: number; n: number; v: T }[] = [];
  private n = 0;
  push(t: number, v: T) { this.q.push({ t, n: this.n++, v }); }
  pop(): { t: number; v: T } | undefined {
    if (!this.q.length) return undefined;
    let b = 0;
    for (let i = 1; i < this.q.length; i++) if (this.q[i].t < this.q[b].t || (this.q[i].t === this.q[b].t && this.q[i].n < this.q[b].n)) b = i;
    return this.q.splice(b, 1)[0];
  }
}

// ------------------------------------------------------------------ push-race
export function simPushRace(p: SimParams): Result {
  const ops = makeOps(p.workload);
  const main = seedFiles(p.workload);
  let mainRev = 0;
  const landed: number[] = [];
  let ciRuns = 0, retries = 0, conflicts = 0;
  type St = { baseRev: number; base: string; edited: string };
  const st = new Map<number, St>();
  const ev = new Events<{ kind: "work" | "pushTry"; agent: number }>();
  for (const op of ops) {
    st.set(op.agent, { baseRev: 0, base: main[op.path], edited: "" });
    ev.push(op.workSec, { kind: "work", agent: op.agent });
  }
  for (let e = ev.pop(); e; e = ev.pop()) {
    const op = ops[e.v.agent];
    const s = st.get(op.agent)!;
    if (e.v.kind === "work") {
      s.edited = op.apply(s.base);
      ciRuns++;
      ev.push(e.t + p.ciSec, { kind: "pushTry", agent: op.agent });
      continue;
    }
    // CI finished: try to push
    if (s.baseRev === mainRev) {
      main[op.path] = s.edited;
      mainRev++;
      landed.push(e.t);
      continue;
    }
    // rejected: fetch, rebase
    const merged = gitMerge3(s.base, main[op.path], s.edited);
    retries++;
    let delay = 0;
    if (merged === null) {
      conflicts++;
      s.edited = op.apply(main[op.path]); // agent redoes its change on the new main
      delay = p.reworkSec;
    } else s.edited = merged;
    s.base = main[op.path];
    s.baseRev = mainRev; // snapshot taken when the rebase started
    ciRuns++; // CI must pass on the rebased code
    ev.push(e.t + delay + p.ciSec, { kind: "pushTry", agent: op.agent });
  }
  return finish("push-race", ops, main, landed, { ciRuns, retries, conflicts });
}

// ------------------------------------------------------------------ merge queue
export function simQueue(p: SimParams): Result {
  const C = p.concurrency;
  const ops = makeOps(p.workload);
  const main = seedFiles(p.workload);
  const landed: number[] = [];
  let ciRuns = 0, retries = 0, conflicts = 0;
  type Pr = { agent: number; base: string; content: string };
  const queue: Pr[] = [];
  const ev = new Events<{ kind: "enter" | "waveDone"; pr?: Pr; wave?: Pr[]; temp?: Record<string, string> }>();
  let busy = false;
  const initial = seedFiles(p.workload);
  for (const op of ops) ev.push(op.workSec, { kind: "enter", pr: { agent: op.agent, base: initial[op.path], content: op.apply(initial[op.path]) } });
  const startWave = (t: number) => {
    if (busy || !queue.length) return;
    const temp: Record<string, string> = { ...main };
    const included: Pr[] = [];
    // build on top of the PRs ahead of it; stop once C builds are in the batch
    while (queue.length && included.length < C) {
      const pr = queue.shift()!;
      const op = ops[pr.agent];
      const merged = gitMerge3(pr.base, temp[op.path], pr.content);
      if (merged === null) {
        conflicts++;
        retries++;
        // ejected: author reworks on the latest trunk (as of when rework finishes, approximated by now) and re-enters at the tail
        ev.push(t + p.reworkSec, { kind: "enter", pr: { agent: pr.agent, base: main[op.path], content: op.apply(temp[op.path]) } });
        continue;
      }
      temp[op.path] = merged;
      included.push(pr);
    }
    if (!included.length) return;
    busy = true;
    ciRuns += included.length;
    ev.push(t + p.ciSec, { kind: "waveDone", wave: included, temp });
  };
  for (let e = ev.pop(); e; e = ev.pop()) {
    if (e.v.kind === "enter") queue.push(e.v.pr!);
    else {
      Object.assign(main, e.v.temp);
      for (const _ of e.v.wave!) landed.push(e.t);
      busy = false;
    }
    startWave(e.t);
  }
  return finish(`queue(C=${C})`, ops, main, landed, { ciRuns, retries, conflicts });
}

// ------------------------------------------------------------------ Weave
export function simWeave(p: SimParams, evidence: "train" | "paths" = "train"): Result {
  const R = p.concurrency;
  const ops = makeOps(p.workload);
  let t = 0;
  const repo = new Repo(undefined, () => Math.round(t * 1000));
  repo.seed(seedFiles(p.workload), "seed");
  repo.setConfig({ checks: [{ name: "unit", command: "ci", timeoutMs: p.ciSec * 1000 }], policy: { evidence, autoLandBelow: 1_000_000, humanAbove: 1_000_001 } });

  type Ev = { kind: "submit" | "rework" | "jobDone" | "verifyDone"; agent?: number; job?: string; sid?: string };
  const ev = new Events<Ev>();
  const gen = new Map<number, number>(); // agent -> session generation
  const sid = (a: number) => `a${a}-${gen.get(a) ?? 0}`;
  const landedAt = new Map<number, number>();
  const verifyScheduled = new Set<string>();
  let ciRuns = 0, retries = 0, conflicts = 0, verifications = 0, free = R;
  const reworkPending = new Set<number>();

  for (const op of ops) {
    gen.set(op.agent, 0);
    repo.open({ id: sid(op.agent), agent: `agent${op.agent}`, goal: `change ${op.agent}`, intent: [op.path] }); // everyone starts from r1
    ev.push(op.workSec, { kind: "submit", agent: op.agent });
  }

  const settle = () => {
    // runners pull jobs
    while (free > 0) {
      const j = repo.claimJob("bench", 10 * 60_000);
      if (!j) break;
      free--;
      ciRuns++;
      ev.push(t + p.ciSec, { kind: "jobDone", job: j.id });
    }
    for (const op of ops) {
      const s = repo.sessionRO(sid(op.agent));
      if (s.status === "landed" && !landedAt.has(op.agent)) landedAt.set(op.agent, t);
      if (s.status === "conflicted" && !reworkPending.has(op.agent)) {
        conflicts++;
        retries++;
        reworkPending.add(op.agent);
        ev.push(t + p.reworkSec, { kind: "rework", agent: op.agent });
      }
      if (s.status === "needs_verify" && !verifyScheduled.has(s.id)) {
        verifyScheduled.add(s.id);
        ev.push(t + p.verifySec, { kind: "verifyDone", sid: s.id });
      }
    }
  };

  for (let e = ev.pop(); e; e = ev.pop()) {
    t = e.t;
    const v = e.v;
    if (v.kind === "submit") repo.write(sid(v.agent!), ops[v.agent!].path, ops[v.agent!].apply(repo.fileAt(ops[v.agent!].path, repo.sessionRO(sid(v.agent!)).baseRev)!)), repo.submit(sid(v.agent!));
    else if (v.kind === "rework") {
      const op = ops[v.agent!];
      reworkPending.delete(v.agent!);
      repo.abandon(sid(v.agent!));
      gen.set(v.agent!, (gen.get(v.agent!) ?? 0) + 1);
      repo.open({ id: sid(v.agent!), agent: `agent${v.agent}`, goal: `change ${v.agent} (rework)`, intent: [op.path] });
      repo.write(sid(v.agent!), op.path, op.apply(repo.head(op.path)!));
      repo.submit(sid(v.agent!));
    } else if (v.kind === "jobDone") {
      free++;
      repo.jobResult(v.job!, "bench", { passed: true });
    } else if (v.kind === "verifyDone") {
      verifications++;
      if (repo.sessionRO(v.sid!).status === "needs_verify") repo.verify(v.sid!, "verifier", true);
    }
    settle();
  }
  (globalThis as any).__repo = repo;
  const times = [...landedAt.values()];
  const files = repo.filesAt();
  return finish(`weave(${evidence},R=${R})`, ops, files, times, { ciRuns, retries, conflicts, verifications });
}
