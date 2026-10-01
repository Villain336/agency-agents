// Pull-based check runner. Claims verification jobs from Weave, materializes the exact merged
// result in a temp directory, runs the configured command, and reports the result.
//
//   node scripts/runner.ts --url http://localhost:8787 --token wv_... [--name runner-1] [--once]
//        [--allow node,npm,npx,pytest] [--repo default]
//
// SECURITY: jobs execute code written by agents. Run this inside a sandbox (container/VM with no
// secrets and restricted network); this script only scrubs the environment and enforces a timeout
// and a command allowlist. Never run it on a machine that holds credentials you care about.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const url = arg("url", "http://localhost:8787")!;
const token = arg("token", process.env.WEAVE_TOKEN);
const name = arg("name", "runner-1")!;
const repo = arg("repo", "default")!;
const once = process.argv.includes("--once");
const allow = new Set(arg("allow", "node,npm,npx,pnpm,yarn,python,python3,pytest,go,cargo,make")!.split(","));

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${url}/api/${path}${path.includes("?") ? "&" : "?"}repo=${repo}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === "POST" ? JSON.stringify(body ?? { runner: name }) : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error ?? ""}`);
  return j;
};

function run(command: string, cwd: string, timeoutMs: number): Promise<{ passed: boolean; output: string }> {
  const bin = command.trim().split(/\s+/)[0];
  if (!allow.has(bin)) return Promise.resolve({ passed: false, output: `runner refused: "${bin}" is not in the allowlist (${[...allow].join(", ")})` });
  return new Promise((res) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: cwd, CI: "1", NODE_ENV: "test" }; // scrubbed: no tokens leak into agent code
    const p = spawn("sh", ["-c", command], { cwd, env, detached: true });
    let out = "";
    const add = (b: Buffer) => (out += b.toString()).length > 200_000 && (out = out.slice(-100_000));
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    const timer = setTimeout(() => {
      try { process.kill(-p.pid!, "SIGKILL"); } catch {}
      res({ passed: false, output: out + `\n[killed after ${timeoutMs}ms]` });
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      res({ passed: code === 0, output: out + `\n[exit ${code}]` });
    });
  });
}

async function handle(job: any) {
  const dir = mkdtempSync(join(tmpdir(), "weave-job-"));
  const t0 = Date.now();
  try {
    for (const [p, c] of Object.entries<string>(job.files)) {
      const dest = resolve(dir, p);
      if (!dest.startsWith(dir + sep)) throw new Error(`refusing path outside the job directory: ${p}`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, c);
    }
    const r = await run(job.command, dir, job.timeoutMs);
    await api("POST", `runner/jobs/${job.id}/result`, { runner: name, passed: r.passed, output: r.output, durationMs: Date.now() - t0 });
    console.log(`[${name}] ${job.id} ${job.check}: ${r.passed ? "PASS" : "FAIL"} (${Date.now() - t0}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (;;) {
  let job: any = null;
  try {
    job = (await api("POST", "runner/claim", { runner: name })).job;
  } catch (e) {
    console.error(`[${name}] claim failed: ${(e as Error).message}`);
  }
  if (job) {
    try { await handle(job); } catch (e) { console.error(`[${name}] job ${job.id} error: ${(e as Error).message}`); }
    continue;
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, 1000));
}
