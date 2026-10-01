// Import the current git checkout into Weave.   node scripts/import.ts [baseUrl] [repoName]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8787";
const repo = process.argv[3] ?? "default";
const files: Record<string, string> = {};
for (const f of execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean)) {
  const buf = readFileSync(f);
  if (!buf.includes(0)) files[f] = buf.toString("utf8"); // skip binary files
}
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const r = await fetch(`${base}/api/import?repo=${repo}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files, message: `import from git@${head}` }) });
console.log(r.status, await r.text(), `(${Object.keys(files).length} files)`);
