// #/commit/<rev>: unified diff per file + provenance summary.
import { agentChip, diffFile, emptyState, link, md, riskBadge, setAllDiffs, statusPill, timeEl } from "../components.js";
import { add, h, icon } from "../dom.js";
import { buildHash } from "../router.js";
import { fullTime, plural } from "../time.js";

export function evidenceList(evidence) {
  if (!evidence?.length) return h("p", { class: "muted", text: "No check evidence recorded." });
  return h("ul", { class: "evidence" }, evidence.map((e) => h("li", { class: e.passed ? "ok" : "bad" }, icon(e.passed ? "check" : "x", 14), h("span", { class: "ev-name", text: e.check }), h("span", { class: "dim", text: e.rev !== undefined ? "r" + e.rev : "" }), e.current === false ? h("span", { class: "badge stale", title: "Produced for different edits or an older trunk", text: "stale" }) : e.current === true ? h("span", { class: "badge current", text: "current" }) : null, e.runner ? h("span", { class: "dim small", text: "by " + e.runner }) : null)));
}

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  const rev = route.params.rev;
  ctx.setTitle("Commit r" + rev);
  const [data, prov] = await Promise.all([api(`commit/${encodeURIComponent(rev)}`), optional(api(`provenance/${encodeURIComponent(rev)}`)).catch(() => null)]);
  const c = data.commit;
  const rec = prov?.record;
  const files = data.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const risk = c.risk ? (typeof c.risk === "string" ? { tier: c.risk, score: rec?.risk?.score ?? "", reasons: rec?.risk?.reasons } : c.risk) : rec?.risk;
  const approvals = c.approvals ?? rec?.approvals ?? [];
  const evidence = c.evidence ?? rec?.evidence ?? [];

  const files$ = h("div", { class: "diff-files" });
  for (const f of files) files$.appendChild(diffFile(f, { id: "f-" + f.path }));

  const goal = rec?.goal;
  add(root, [
    h("div", { class: "page-head" }, h("h1", { class: "commit-title" }, c.message || "(no message)"), h("div", { class: "page-actions" }, link("← r" + (c.rev - 1), buildHash("commit", { rev: c.rev - 1 }), { class: `btn btn-sm${c.rev <= 1 ? " disabled" : ""}`, aria: { disabled: c.rev <= 1 } }), link("r" + (c.rev + 1) + " →", buildHash("commit", { rev: c.rev + 1 }), { class: "btn btn-sm" }), link("Browse files", buildHash("home", {}, { rev: c.rev }), { class: "btn btn-sm" }))),
    h("div", { class: "commit-meta" }, agentChip(c.agent), h("span", { class: "dim" }, "landed ", h("time", { title: fullTime(c.ts), dateTime: new Date(c.ts).toISOString(), text: new Date(c.ts).toISOString().slice(0, 16).replace("T", " ") + " UTC" })), h("span", { class: "mono badge", text: "r" + c.rev }), c.merged ? h("span", { class: "badge", text: "auto-merged with concurrent work" }) : null),
    h("section", { class: "card prov", aria: { label: "Provenance" } },
      h("h2", { class: "card-title" }, icon("shield", 16), " Provenance ", h("span", { class: "dim small", text: "signed, hash-chained record of how this change was made" })),
      h("div", { class: "grid-prov" },
        h("div", {}, h("h3", { text: "Author" }), h("p", {}, agentChip(c.agent), rec?.actor?.kind ? h("span", { class: "badge", text: rec.actor.kind }) : null), h("p", { class: "dim small" }, rec?.actor?.model ? ["model ", h("span", { class: "mono", text: rec.actor.model })] : "model not recorded"), rec?.promptHash ? h("p", { class: "dim small" }, "prompt hash ", h("code", { text: String(rec.promptHash).slice(0, 12) })) : null),
        h("div", {}, h("h3", { text: "Risk" }), h("p", {}, riskBadge(risk && typeof risk === "object" ? risk : null)), risk?.reasons?.length ? h("ul", { class: "reasons small" }, risk.reasons.map((r) => h("li", { text: r }))) : null),
        h("div", {}, h("h3", { text: "Evidence" }), evidenceList(evidence)),
        h("div", {}, h("h3", { text: "Approvals" }), approvals.length ? h("ul", { class: "plain" }, approvals.map((a) => h("li", {}, agentChip(a.by), h("span", { class: "badge", text: a.kind })))) : h("p", { class: "muted", text: "None needed or recorded." }), rec?.verifiedBy ? h("p", { class: "small" }, "Verified by ", agentChip(rec.verifiedBy)) : null)),
      goal ? h("p", { class: "goal" }, h("strong", { text: "Goal: " }), goal) : null,
      rec?.semantic?.length ? h("div", { class: "alert alert-warn" }, icon("warn"), h("div", {}, h("strong", { text: "Interacted with concurrent work" }), h("ul", {}, rec.semantic.map((s) => h("li", { text: s.detail ?? JSON.stringify(s) }))))) : null,
      rec?.autoResolved?.length ? h("p", { class: "small dim", text: "Auto-resolved overlapping edits: " + rec.autoResolved.map((a) => `${a.path} (${a.count})`).join(", ") }) : null,
      h("div", { class: "hashes small dim" }, rec?.sessionId ? h("span", {}, "change ", link(rec.sessionId, buildHash("change", { id: rec.sessionId }), { class: "mono" })) : null, rec ? h("span", { text: `based on r${rec.baseRev}` }) : null, prov?.hash ? h("span", {}, "hash ", h("code", { text: prov.hash.slice(0, 16) })) : null, prov?.signature ? h("span", {}, "signature ", h("code", { text: prov.signature.slice(0, 16) })) : null, !prov ? h("span", { text: "Provenance endpoint unavailable; showing what the commit carries." }) : null)),
    h("div", { class: "toolbar" }, h("strong", { text: `${plural(files.length, "file")} changed` }), h("span", { class: "diff-counts" }, h("b", { class: "add", text: "+" + added }), " ", h("b", { class: "del", text: "−" + removed })), h("span", { class: "grow" }), h("button", { class: "btn btn-sm", type: "button", on: { click: () => setAllDiffs(files$, false) }, text: "Collapse all" }), h("button", { class: "btn btn-sm", type: "button", on: { click: () => setAllDiffs(files$, true) }, text: "Expand all" })),
    files.length ? files$ : emptyState("No file changes", "This revision did not change any files.", "file"),
  ]);
}
