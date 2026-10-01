// Records the demo video: real dashboard replay + generated scene cards, with on-screen captions.
//   node video/record.ts [out=video/out]
// Needs: video/data/{events.json,swarm-report.json,review-quotes.json,git-transcript.txt,bench.json} (see video/capture.ts)
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = process.argv[2] ?? root + "video/out/";
mkdirSync(out, { recursive: true });
copyFileSync(root + "bench/results.json", root + "video/data/bench.json");

const PORT = 8801;
const server = spawn("node", [root + "video/serve.ts", String(PORT), "http://localhost:1", "x"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const base = `http://localhost:${PORT}`;

const events = JSON.parse(readFileSync(root + "video/data/events.json", "utf8")) as { ts: number; id: number }[];
const spanSec = (Math.max(...events.map((e) => e.ts)) - Math.min(...events.map((e) => e.ts))) / 1000;
const REPLAY_TARGET = 95; // seconds of video for the swarm replay
const speed = 1; // the real log is only ~2 minutes; at normal speed the replay fills the swarm scene

const chromePath = readdirSync("/opt/pw-browsers").filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(existsSync);
const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox", "--hide-scrollbars"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out + "raw", size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const wait = (s: number) => page.waitForTimeout(s * 1000);
const caption = (t: string | null) => page.evaluate((x) => (window as any).setCaption?.(x), t);
const scene = async (name: string, seconds: number, caps: [number, string][] = []) => {
  await page.goto(`${base}/scenes.html?scene=${name}`);
  await wait(0.6);
  let t = 0;
  for (const [at, text] of caps) { await wait(Math.max(0, at - t)); await caption(text); t = at; }
  await wait(Math.max(0, seconds - t));
  await caption(null);
};

const log = (m: string) => console.error(`[record] ${m}`);
log(`events span ${spanSec.toFixed(0)}s, replaying at x${speed}`);

await scene("title", 8, [[1.5, "Weave: a collaboration layer for AI agents on Cloudflare"]]);
await scene("problem", 25, [[1, "Plain git: every rejected push means a rebase and another full test run"], [13, "A merge queue fixes the retry storm, but still wants a branch and a PR per agent"]]);

// the swarm, replayed from the real audit log of 16 Claude agents
await page.goto(`${base}/dashboard.html?replay=/data/events.json&speed=${speed}&maxgap=3&repo=swarm`);
await wait(2);
await caption("16 real Claude agents add 16 functions to one library at the same time. No branches, no PRs.");
await wait(10);
await caption("Every agent must edit the same exports line and append to the same test file");
await wait(16);
await caption("Weave merges list items and appended blocks itself, and records each auto-merge");
await wait(18);
await caption("Required tests run on the exact merged code; README is protected, so reviewer agents look at it");
await wait(18);
await caption(null);
const t0 = Date.now();
while (!(await page.evaluate(() => (window as any).REPLAY_DONE)) && Date.now() - t0 < 90000) await wait(1);
await caption("All 16 landed. The final trunk passes 34 of 34 tests.");
await wait(6);
await caption(null);

await scene("journey", 40, [[1, "Run 1 found silent data loss: two landed changes were erased, and every test still passed"], [14, "Run 2 stopped the loss, but my fix made conflicts worse: 64 instead of 37"], [27, "Run 3 added list and union merging: 2 conflicts, all 16 landed. One sample each."]]);
await scene("bench", 40, [[1, "Same workload and build capacity, 20 to 200 agents: Weave matches a merge queue"], [14, "Both are far cheaper than plain push-and-retry. Baselines use real git merges"], [27, "My queue model likely flatters Weave: read this as parity, not a win"]]);
await scene("trust", 28, [[1, "Signed provenance: which agent and model, risk, evidence, approvals, in a hash chain"]]);
await scene("review", 17, [[1, "Reviewer agents read the diff, not just the checks"]]);
await scene("git", 30, [[1, "A real Git remote: clone, fetch and push work with the git you already have"]]);
await scene("honest", 25, [[1, "Measured against ground truth, with known limits stated"], [13, "Limits: indirect dependencies are missed; the GitHub mirror is untested against GitHub"]]);
await scene("outro", 8);

const video = page.video();
await ctx.close();
await browser.close();
server.kill();
const webm = await video!.path();
const target = out + "weave-demo.webm";
renameSync(webm, target);
rmSync(out + "raw", { recursive: true, force: true });
const mp4 = out + "weave-demo.mp4";
const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", target, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast", "-movflags", "+faststart", mp4], { encoding: "utf8" });
log(enc.status === 0 ? `wrote ${mp4} (${(statSync(mp4).size / 1e6).toFixed(1)} MB)` : `mp4 encode failed: ${enc.stderr.slice(0, 200)}; webm is at ${target}`);
writeFileSync(out + "duration.txt", spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", existsSync(mp4) ? mp4 : target], { encoding: "utf8" }).stdout);
log(`duration ${readFileSync(out + "duration.txt", "utf8").trim()}s`);
