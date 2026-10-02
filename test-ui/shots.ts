// Visits every page of the web UI against the mock at desktop and phone size, writes PNGs to
// test-ui/shots/ and reports console/CSP errors, failed requests and horizontal overflow.
//   npm run ui:shots [-- name-filter]
import { chromium, type Page } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.ts";

const out = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(out, { recursive: true });
const only = process.argv[2];
if (!only) for (const f of readdirSync(out)) if (f.endsWith(".png")) rmSync(out + f);

const chromePath = readdirSync("/opt/pw-browsers").filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(existsSync);
const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox", "--hide-scrollbars"] });
const mock = await startMock({});
const authMock = await startMock({ token: "s3cret" });
const partial = await startMock({ missing: ["tasks", "notifications", "tags", "releases", "repos", "tree", "blob", "history", "commit", "blame", "search", "stats", "readme", "provenance", "runs", "workflows", "packages", "teams", "secrets"] });

const SIZES = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const;
interface Shot { name: string; hash: string; base?: "main" | "auth" | "partial"; full?: boolean; light?: boolean; token?: string; run?: (p: Page) => Promise<void>; sizes?: (keyof typeof SIZES)[]; wait?: string }
const click = (sel: string, nth = 0) => async (p: Page) => void (await p.locator(sel).nth(nth).click());

const shots: Shot[] = [
  { name: "01-home", hash: "#/" },
  { name: "02-tree-src", hash: "#/tree/src" },
  { name: "03-tree-handlers-longname", hash: "#/tree/src/handlers" },
  { name: "04-blob-ts", hash: "#/blob/src/auth/session.ts#L20" },
  { name: "05-blob-blame", hash: "#/blob/src/auth/session.ts", run: async (p) => { await p.getByRole("button", { name: "Blame" }).click(); await p.waitForSelector("td.blame a"); } },
  { name: "06-blob-markdown-source", hash: "#/blob/README.md#L3" },
  { name: "07-blob-markdown-preview", hash: "#/blob/docs/guide.md" },
  { name: "08-blob-long-file", hash: "#/blob/src/i18n/catalog.ts#L150", full: false },
  { name: "09-blob-py", hash: "#/blob/scripts/seed.py" },
  { name: "10-blob-html-css", hash: "#/blob/public/index.html" },
  { name: "11-commits", hash: "#/commits", full: false },
  { name: "12-commits-path", hash: "#/commits?path=src/auth" },
  { name: "13-commit", hash: "#/commit/30" },
  { name: "14-commit-bulk-diff", hash: "#/commit/29", full: false },
  { name: "20-changes-live", hash: "#/changes" },
  { name: "21-changes-landed", hash: "#/changes?tab=landed", full: false },
  { name: "22-changes-rejected", hash: "#/changes?tab=rejected" },
  { name: "23-change-key", hash: "#/change/claude-fixer-q4z" },
  { name: "24-change-composer", hash: "#/change/claude-fixer-q4z", run: async (p) => { await p.locator("table.diff tr.ln.add").nth(3).hover(); await p.locator("table.diff tr.ln.add .add-comment").nth(3).click(); await p.locator(".composer textarea").first().fill("Should this use a `Map` keyed by token hash instead?"); await p.getByLabel("Suggest a replacement").check(); }, full: false },
  { name: "25-change-approve-blocked", hash: "#/change/claude-fixer-q4z", run: async (p) => { await p.getByRole("button", { name: "Approve" }).click(); await p.getByRole("dialog").getByRole("button", { name: "Approve" }).click(); await p.waitForSelector(".toast-error"); }, full: false },
  { name: "26-change-landed", hash: "#/change/security-reviewer-r30" },
  { name: "27-change-xss", hash: "#/change/rogue-agent-xss", full: false },
  { name: "28-change-conflicted", hash: "#/change/docs-agent-81c" },
  { name: "29-change-active", hash: "#/change/refactor-bot-m1x" },
  { name: "30-tasks-list", hash: "#/tasks" },
  { name: "31-tasks-board", hash: "#/tasks?view=board" },
  { name: "32-task-detail", hash: "#/task/1" },
  { name: "33-task-create-dialog", hash: "#/tasks", run: async (p) => { await p.getByRole("button", { name: "New task" }).click(); }, full: false },
  { name: "40-search", hash: "#/search?q=refresh" },
  { name: "41-search-regex", hash: "#/search?q=export%5Cs%2Bfunction%20%5Cw%2B&regex=1&cs=1" },
  { name: "42-search-empty", hash: "#/search?q=zzzznothing" },
  { name: "43-activity", hash: "#/activity", full: false },
  { name: "44-releases", hash: "#/releases" },
  { name: "45-notifications", hash: "#/notifications" },
  { name: "46-settings", hash: "#/settings" },
  { name: "47-repos", hash: "#/repos" },
  { name: "70-runs", hash: "#/runs" },
  { name: "71-runs-filtered", hash: "#/runs?workflow=deploy-preview&status=failed", full: false },
  { name: "72-run-failed", hash: "#/run/w3" },
  { name: "73-run-running", hash: "#/run/w5", full: false },
  { name: "74-packages", hash: "#/packages" },
  { name: "75-package", hash: "#/package/%40orbit%2Fclient" },
  { name: "76-package-yanked", hash: "#/package/%40orbit%2Fclient?v=1.1.0" },
  { name: "77-settings-forge", hash: "#/settings" },
  { name: "78-owners-validation", hash: "#/settings", run: async (p) => { await p.getByRole("button", { name: "Add rule" }).click(); await p.locator("#own-p-3").fill("src/api/"); await p.getByRole("button", { name: "Save owners" }).click(); await p.waitForSelector(".form-error:not(:empty)"); }, full: false },
  { name: "79-team-dialog", hash: "#/settings", run: async (p) => { await p.getByRole("button", { name: "New team" }).click(); }, full: false },
  { name: "80-secret-dialog", hash: "#/settings", run: async (p) => { await p.getByRole("button", { name: "Add secret" }).click(); }, full: false },
  { name: "81-change-owners-pending", hash: "#/change/claude-fixer-q4z", run: async (p) => { await p.locator(".owners-card").scrollIntoViewIfNeeded(); }, full: false },
  { name: "82-run-manual", hash: "#/runs", run: async (p) => { await p.getByRole("button", { name: "Run" }).first().click(); await p.waitForURL(/#\/run\/w\d+/); await p.waitForSelector(".run-output, .card h2"); }, full: false },
  { name: "48-notfound", hash: "#/nope/zzz", full: false },
  { name: "50-signin", hash: "#/", base: "auth", full: false },
  { name: "51-signed-in", hash: "#/", base: "auth", token: "s3cret", full: false },
  { name: "52-degraded-home", hash: "#/", base: "partial" },
  { name: "53-degraded-tasks", hash: "#/tasks", base: "partial", full: false },
  { name: "57-degraded-runs", hash: "#/runs", base: "partial", full: false },
  { name: "58-degraded-packages", hash: "#/packages", base: "partial", full: false },
  { name: "59-degraded-settings", hash: "#/settings", base: "partial" },
  { name: "54-degraded-releases", hash: "#/releases", base: "partial", full: false },
  { name: "55-degraded-blob", hash: "#/blob/README.md", base: "partial", full: false },
  { name: "56-degraded-commits", hash: "#/commits", base: "partial", full: false },
  { name: "60-light-home", hash: "#/", light: true, sizes: ["desktop"] },
  { name: "61-light-change", hash: "#/change/claude-fixer-q4z", light: true, sizes: ["desktop"], full: false },
  { name: "63-light-package", hash: "#/package/%40orbit%2Fclient", light: true, sizes: ["desktop"], full: false },
  { name: "62-light-blob", hash: "#/blob/src/auth/session.ts", light: true, sizes: ["desktop"], full: false },
];

const problems: string[] = [];
let count = 0;
for (const s of shots) {
  if (only && !s.name.includes(only)) continue;
  for (const [sizeName, size] of Object.entries(SIZES) as [keyof typeof SIZES, { width: number; height: number }][]) {
    if (s.sizes && !s.sizes.includes(sizeName)) continue;
    const base = s.base === "auth" ? authMock : s.base === "partial" ? partial : mock;
    const ctx = await browser.newContext({ viewport: size, colorScheme: s.light ? "light" : "dark", deviceScaleFactor: 1 });
    if (s.token) await ctx.addInitScript((t) => localStorage.setItem("weave.token", t), s.token);
    const page = await ctx.newPage();
    const tag = `${s.name}@${sizeName}`;
    page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/Failed to load resource/.test(m.text())) problems.push(`${tag} console.${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`${tag} pageerror: ${e.message}`));
    page.on("response", (r) => { if (r.status() >= 400 && !(s.base && [401, 404].includes(r.status())) && !(s.name.startsWith("25-") && r.status() === 409) && !(r.status() === 404 && /\/api\/(whoami)/.test(r.url()))) problems.push(`${tag} HTTP ${r.status()} ${r.url().replace(base.url, "")}`); });
    try {
      await page.goto(base.url + "/" + s.hash, { waitUntil: "load" });
      await page.waitForFunction(() => !document.querySelector("#main .loading"), null, { timeout: 8000 });
      await page.waitForTimeout(250);
      if (s.run) await s.run(page);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const bad: string[] = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width && r.right > w + 1 && !(el as HTMLElement).closest(".table-scroll, .mainnav, .board, pre, .md table, .suggest-body, .code-table, .token-box, dialog, .toasts, textarea")) bad.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().split(" ")[0]} right=${Math.round(r.right)}`);
        }
        return { scrollW: document.documentElement.scrollWidth, w, bad: [...new Set(bad)].slice(0, 5) };
      });
      if (overflow.scrollW > overflow.w + 1) problems.push(`${tag} HORIZONTAL OVERFLOW: scrollWidth ${overflow.scrollW} > ${overflow.w}; offenders: ${overflow.bad.join(", ")}`);
      await page.screenshot({ path: `${out}${s.name}-${sizeName}.png`, fullPage: s.full !== false });
      count++;
    } catch (e: any) {
      problems.push(`${tag} FAILED: ${String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `${out}${s.name}-${sizeName}-FAILED.png` }).catch(() => {});
    }
    await ctx.close();
  }
}
await browser.close();
await Promise.all([mock.close(), authMock.close(), partial.close()]);
console.log(`wrote ${count} screenshots to ${out}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.log("  - " + p);
  process.exitCode = 1;
} else console.log("no console errors, CSP violations, failed requests or horizontal overflow");
