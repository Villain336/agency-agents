// #/changes: Weave's pull requests. Sessions by tab: Live / Landed / Rejected.
import { agentChip, emptyState, link, pageHeader, riskBadge, statusPill, tabs, timeEl } from "../components.js";
import { add, clear, h, icon, store } from "../dom.js";
import { buildHash } from "../router.js";
import { plural } from "../time.js";

const LIVE = ["active", "conflicted", "needs_verify", "verifying", "in_review"];
const TAB_OF = (s) => (LIVE.includes(s.status) ? "live" : s.status === "landed" ? "landed" : "rejected");

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  ctx.setTitle("Changes");
  const [sessions, queue] = await Promise.all([api("sessions"), optional(api("review/queue")).catch(() => null)]);
  const all = sessions.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const counts = { live: 0, landed: 0, rejected: 0 };
  for (const s of all) counts[TAB_OF(s)]++;
  let tab = route.query.tab ?? store.get("weave.changes.tab") ?? "live";
  if (!counts[tab] && !counts.live && counts.landed) tab = "landed";
  let q = "";

  const tabHost = h("div", { class: "tabbar" });
  const list = h("div", { class: "panel", role: "tabpanel", id: "tabpanel" });
  const filter = h("input", { type: "search", placeholder: "Filter by goal, agent or path", class: "filter", aria: { label: "Filter changes" }, on: { input: (e) => ((q = e.target.value.toLowerCase()), draw()) } });

  function drawTabs() {
    clear(tabHost).appendChild(tabs([{ id: "live", label: "Live", count: counts.live }, { id: "landed", label: "Landed", count: counts.landed }, { id: "rejected", label: "Rejected", count: counts.rejected }], tab, (id) => { tab = id; store.set("weave.changes.tab", id); drawTabs(); draw(); }, "Change states"));
    tabHost.appendChild(filter);
    list.setAttribute("aria-labelledby", "tab-" + tab);
  }
  function draw() {
    clear(list);
    const rows = all.filter((s) => TAB_OF(s) === tab && (!q || [s.goal, s.agent, s.id, ...(s.paths ?? [])].join(" ").toLowerCase().includes(q)));
    if (!rows.length) {
      list.appendChild(emptyState(q ? "No matches" : tab === "live" ? "Nothing in flight" : `No ${tab} changes`, q ? "Try a different filter." : tab === "live" ? "When agents open sessions they show up here." : "", "change"));
      return;
    }
    const ul = h("ul", { class: "rows" });
    for (const s of rows) {
      const blocked = (s.conflictPaths?.length ?? 0) > 0;
      ul.appendChild(
        h("li", { class: "row" },
          h("div", { class: "row-main" },
            h("div", { class: "row-title" }, statusPill(s.status), link(s.goal || "(no goal)", buildHash("change", { id: s.id }), { class: "row-link", title: s.goal })),
            h("div", { class: "row-sub" }, agentChip(s.agent), s.model ? h("span", { class: "dim mono small", text: s.model }) : null, h("span", { class: "dim" }, "opened ", timeEl(s.createdAt)), h("span", { class: "dim mono small", title: "session id", text: s.id }), s.paths?.length ? h("span", { class: "dim", text: plural(s.paths.length, "file") }) : null, blocked ? h("span", { class: "badge risk-high" }, icon("warn", 12), ` conflicts in ${s.conflictPaths.length}`) : null)),
          h("div", { class: "row-side" }, riskBadge(s.risk), s.status === "landed" && s.landedRev ? link("r" + s.landedRev, buildHash("commit", { rev: s.landedRev }), { class: "mono badge" }) : null, s.approvals?.length ? h("span", { class: "badge ok", title: s.approvals.map((a) => a.by).join(", ") }, icon("check", 12), ` ${s.approvals.length}`) : null)),
      );
    }
    list.appendChild(ul);
  }

  add(root, [
    pageHeader("Changes", h("span", { class: "dim small", text: "Weave's pull requests: there are no branches, only sessions that land atomically." })),
    queue && queue.next?.length ? h("div", { class: "alert alert-info" }, icon("eye"), h("div", {}, h("strong", { text: `${plural(queue.next.length + (queue.deferred?.length ?? 0), "change")} waiting for review. ` }), "Riskiest first: ", queue.next.slice(0, 3).map((n, i) => [i ? ", " : "", link(n.goal.length > 48 ? n.goal.slice(0, 47) + "\u2026" : n.goal, buildHash("change", { id: n.id }))]), queue.deferred?.length ? ` (+${queue.deferred.length} beyond the attention budget of ${queue.budget})` : "")) : null,
    tabHost,
    list,
  ]);
  drawTabs();
  draw();
}
