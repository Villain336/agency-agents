// Pure helpers for the teams / owners / runs / packages pages (no DOM; unit-tested in test/ui-pure.test.ts).

/** "a, b  c" -> ["a","b","c"] (deduplicated, empties dropped) */
export const parseList = (s) => [...new Set(String(s ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

/** "team:core" -> {kind:"team", name:"core"}; anything else is an identity name */
export function ownerRef(o) {
  const m = /^team:(.+)$/.exec(o);
  return m ? { kind: "team", name: m[1] } : { kind: "identity", name: o };
}

/** Editor rows [{pattern, owners:string|string[]}] -> {rules, error}. Blank rows are dropped; a pattern needs an owner. */
export function cleanOwnerRules(rows) {
  const rules = [];
  for (const [i, r] of rows.entries()) {
    const pattern = String(r.pattern ?? "").trim();
    const owners = Array.isArray(r.owners) ? r.owners : parseList(r.owners);
    if (!pattern && !owners.length) continue;
    if (!pattern) return { rules: [], error: `Rule ${i + 1} has owners but no path pattern.` };
    if (!owners.length) return { rules: [], error: `Rule ${i + 1} (${pattern}) needs at least one owner.` };
    if (owners.includes("team:")) return { rules: [], error: `Rule ${i + 1}: "team:" must be followed by a team name.` };
    rules.push({ pattern, owners });
  }
  return { rules, error: "" };
}

/** requiredOwners from a review pack -> {total, pending, satisfied} */
export function ownerSummary(req) {
  const list = Array.isArray(req) ? req : [];
  const pending = list.filter((r) => !r.satisfied).length;
  return { total: list.length, pending, satisfied: list.length - pending };
}

export const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Newest first by numeric id suffix (w12 before w3). */
export const sortRuns = (runs) => [...runs].sort((a, b) => (Number(String(b.id).replace(/\D/g, "")) || 0) - (Number(String(a.id).replace(/\D/g, "")) || 0));

export const RUN_LABEL = { queued: "Queued", running: "Running", passed: "Passed", failed: "Failed" };
export const runPillClass = (status) => "pill run-" + (RUN_LABEL[status] ? status : "unknown");

/** Latest run per workflow name: Map<name, run> */
export function latestByWorkflow(runs) {
  const m = new Map();
  for (const r of sortRuns(runs)) if (!m.has(r.workflow)) m.set(r.workflow, r);
  return m;
}

/** What a run was triggered by, as text. */
export const triggerText = (r) => (r.trigger === "tag" ? `tag ${r.ref ?? ""}`.trim() : r.trigger === "landed" ? `landing r${r.rev}` : `manual by ${r.by}`);

const enc = (s) => encodeURIComponent(s);

/** Shell snippet to fetch one package file from the server. */
export function packageSnippets({ origin, name, version, file, repo }) {
  const q = repo && repo !== "default" ? `?repo=${enc(repo)}` : "";
  const url = `${origin}/api/packages/${enc(name)}/${enc(version)}/files/${enc(file)}${q}`;
  const safe = file.split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  return { url, curl: `curl -fsS -H "Authorization: Bearer $WEAVE_TOKEN" "${url}" \\\n  | jq -r .contentBase64 | base64 -d > ${safe}` };
}

/** Version to show first: the requested one, else latest, else newest non-yanked, else the last listed. */
export function pickVersion(releases, want, latest) {
  const list = releases ?? [];
  return list.find((r) => r.version === want) ?? list.find((r) => r.version === latest) ?? [...list].reverse().find((r) => !r.yanked) ?? list[list.length - 1];
}

export const totalBytes = (files) => (files ?? []).reduce((n, f) => n + (f.size || 0), 0);
export const shortSha = (s) => String(s ?? "").slice(0, 12);
