// Test-only helpers (Node APIs allowed here).
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { emptyState, Repo } from "../src/repo.ts";
import { handleGitRequest, type GitHost } from "../src/git/index.ts";

export const tmp = (name: string) => mkdtempSync(join(tmpdir(), `weave-${name}-`));

export interface Run { code: number; stdout: string; stderr: string }

export function run(cwd: string, args: string[], input?: string | Buffer, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const home = join(tmpdir(), "weave-git-home");
    mkdirSync(home, { recursive: true });
    const p = spawn("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com",
        ...env,
      },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.stdin.end(input);
  });
}

/** Run git and throw (with stderr) on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code})\n${r.stderr}`);
  return r.stdout.trim();
}

export const TOKENS: Record<string, string> = { alice: "tok-alice", bob: "tok-bob", carol: "tok-carol" };

export function basicAuth(req: Request): { agent: string } | null {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return null;
  const [user, pass] = Buffer.from(h.slice(6), "base64").toString().split(/:(.*)/s);
  return TOKENS[user] !== undefined && TOKENS[user] === pass ? { agent: user } : null;
}

export interface TestServer { url: string; repo: Repo; persisted: () => number; close: () => Promise<void> }

export async function serve(repo: Repo): Promise<TestServer> {
  let persisted = 0;
  const host: GitHost = { repo, authenticate: basicAuth, persist: async () => void persisted++ };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const r = await handleGitRequest(
      new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }),
      host,
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/git`, repo, persisted: () => persisted,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

export const withCreds = (url: string, user: string, pass: string) => url.replace("http://", `http://${user}:${pass}@`);

/** Repo with a deterministic clock. */
export function newRepo(): Repo {
  let t = 1_700_000_000_000;
  return new Repo(emptyState(), () => (t += 60_000));
}

/** Land a whole change on trunk through a Weave session. */
export function land(repo: Repo, agent: string, goal: string, files: Record<string, string | null>): number {
  const id = `${agent}-${Object.keys(repo.s.sessions).length + 1}`;
  repo.open({ id, agent, goal });
  for (const [p, c] of Object.entries(files)) repo.write(id, p, c);
  const r = repo.submit(id);
  if (r.status !== "landed") throw new Error(`land failed: ${r.status}`);
  return r.rev as number;
}
