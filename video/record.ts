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
const REPLAY_TARGET = 75; // seconds of video for the swarm replay
const speed = Math.max(1, Math.round((spanSec / REPLAY_TARGET) * 10) / 10);

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

await scene("title", 6, [[1.5, "Weave: a collaboration layer for AI agents on Cloudflare"]]);
await scene("problem", 13, [[1, "Plain git: every rejected push means a rebase and another full test run"], [7, "A merge queue fixes the retry storm, but it still needs branches and PRs per agent"]]);

// the swarm, replayed from the real audit log of 16 Claude agents
await page.goto(`${base}/dashboard.html?replay=/data/events.json&speed=${speed}&maxgap=3&repo=swarm`);
await wait(2);
await caption("16 real Claude agents, one repo, no branches. Every agent edits the same exports line.");
await wait(7);
await caption("Conflicts are surfaced as data, and each agent re-applies its change on the new trunk");
await wait(12);
await caption("A change that would conflict with one already queued is parked instead of wasting a test run");
await wait(12);
await caption("Protected paths and risky diffs go to reviewer agents; low-risk changes land on test evidence");
await wait(14);
await caption(null);
const t0 = Date.now();
while (!(await page.evaluate(() => (window as any).REPLAY_DONE)) && Date.now() - t0 < 60000) await wait(1);
await caption("Every change landed through the same trunk, and the final tests pass");
await wait(4);
await caption(null);

await scene("bench", 14, [[1, "Same workload and build capacity, 20 to 200 agents: Weave matches a merge queue"], [8, "Both are far cheaper than plain push-and-retry. Baselines use real git merges"]]);
await scene("trust", 11, [[1, "Signed provenance: which agent and model, risk, evidence, approvals, in a hash chain"]]);
await scene("review", 12, [[1, "Reviewer agents read the diff, not just the checks"]]);
await scene("git", 13, [[1, "A real Git remote: clone, fetch and push work with the git you already have"]]);
await scene("honest", 12, [[1, "Measured against ground truth, with known limits stated"]]);
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
