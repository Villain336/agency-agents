// #/task/<n>: detail, comment thread, claim/release/assign/close/reopen, linked changes.
import { api as rawApi, isAbort, post, session as auth } from "../api.js";
import { agentChip, emptyState, labelChips, link, md, priorityBadge, statusPill, timeEl, unavailable } from "../components.js";
import { add, clear, field, h, icon, openDialog, toast } from "../dom.js";
import { buildHash } from "../router.js";
import { fullTime } from "../time.js";

export async function render(ctx) {
  const { root, route, signal } = ctx;
  const n = route.params.n;
  const api = (p, o) => rawApi(p, { signal, ...o });
  ctx.setTitle("Task #" + n);
  let t;
  let linked = [];

  async function load() {
    t = await api(`tasks/${encodeURIComponent(n)}`);
    const sessions = await Promise.all((t.sessions ?? []).map((id) => api(`sessions/${id.split("/").map(encodeURIComponent).join("/")}`).catch(() => ({ id, goal: "(unavailable)", status: "unknown" }))));
    linked = sessions;
  }
  async function act(path, body, label) {
    try {
      await post(`tasks/${encodeURIComponent(n)}/${path}`, { ...body, author: auth.name || undefined, by: auth.name || undefined }, { signal });
      toast(label, "ok");
      await load();
      draw();
    } catch (e) {
      if (!isAbort(e)) toast(e.message, "error");
    }
  }
  function assignDialog() {
    const who = h("input", { type: "text", id: "as-to", required: true, value: t.assignee ?? "", placeholder: "identity name" });
    openDialog({ title: "Assign task", build: () => field("Assign to", who, "An identity name. They get a notification."), actions: [{ label: "Cancel" }, { label: "Assign", kind: "primary", submit: true, onClick: () => act("assign", { to: who.value.trim() }, "Assigned") }] });
  }

  function draw() {
    clear(root);
    ctx.setTitle(`#${t.number} ${t.title}`);
    const open = t.status === "open";
    const claimed = t.status === "claimed";
    const closed = t.status === "closed" || t.status === "done";
    const btn = (label, ic, fn, kind = "") => h("button", { class: "btn " + kind, type: "button", on: { click: fn } }, icon(ic, 14), label);
    const thread = h("div", { class: "thread-list" });
    for (const c of t.comments ?? []) thread.appendChild(h("article", { class: "comment card" }, h("div", { class: "comment-head" }, agentChip(c.author), timeEl(c.ts)), md(c.body)));
    const box = h("textarea", { rows: 3, id: "tc-body", required: true, placeholder: "Add a comment. Use @name to mention an identity." });
    const form = h("form", { class: "composer card", on: { submit: async (e) => { e.preventDefault(); if (!box.value.trim()) return; await act("comment", { body: box.value }, "Comment added"); } } }, h("label", { class: "sr-only", htmlFor: "tc-body", text: "Comment" }), box, h("div", { class: "composer-actions" }, h("button", { class: "btn btn-primary", type: "submit", text: "Comment" })));
    add(root, [
      h("nav", { class: "crumbs", aria: { label: "Breadcrumb" } }, link("Tasks", buildHash("tasks"), { class: "crumb" }), h("span", { class: "sep", text: "/" }), h("span", { class: "crumb current", text: "#" + t.number })),
      h("div", { class: "change-title" }, h("h1", {}, t.title, h("span", { class: "dim num-suffix", text: " #" + t.number })), statusPill(t.status)),
      h("div", { class: "change-meta" }, priorityBadge(t.priority), labelChips(t.labels), h("span", { class: "dim" }, "opened by "), agentChip(t.creator), h("span", { class: "dim" }, " ", timeEl(t.createdAt))),
      h("div", { class: "actionbar", role: "toolbar", aria: { label: "Task actions" } },
        btn("Claim", "user", () => act("claim", {}, "Claimed"), open ? "btn-primary" : ""),
        btn("Release", "x", () => act("release", {}, "Released")),
        btn("Assign…", "user", assignDialog),
        closed ? btn("Reopen", "plus", () => act("reopen", {}, "Reopened")) : btn("Close", "check", () => act("close", {}, "Closed"), "btn-danger")),
      h("div", { class: "cols" },
        h("div", { class: "col-main" }, h("section", { class: "card" }, t.body ? h("div", { class: "card-body" }, md(t.body)) : h("p", { class: "muted pad", text: "No description." })), h("h2", { class: "section-title", text: "Discussion" }), thread, form),
        h("aside", { class: "col-side" },
          h("section", { class: "card" }, h("h2", { class: "card-title", text: "Details" }), h("dl", { class: "kv" },
            h("dt", { text: "Assignee" }), h("dd", {}, t.assignee ? agentChip(t.assignee) : "—"),
            h("dt", { text: "Claim" }), h("dd", {}, t.claim ? h("span", {}, agentChip(t.claim.by), h("div", { class: "dim small", title: fullTime(t.claim.leaseUntil) }, "lease ends ", timeEl(t.claim.leaseUntil))) : "—"),
            h("dt", { text: "Updated" }), h("dd", {}, timeEl(t.updatedAt)),
            t.closedAt ? [h("dt", { text: "Closed" }), h("dd", {}, timeEl(t.closedAt))] : null,
            t.dependsOn?.length ? [h("dt", { text: "Depends on" }), h("dd", {}, t.dependsOn.map((d, i) => [i ? ", " : "", link("#" + d, buildHash("task", { n: d }))]))] : null)),
          h("section", { class: "card" }, h("h2", { class: "card-title", text: "Linked changes" }), linked.length ? h("ul", { class: "plain" }, linked.map((s) => h("li", { class: "linked" }, statusPill(s.status), link(s.goal || s.id, buildHash("change", { id: s.id }), { title: s.id })))) : h("p", { class: "muted", text: "No sessions linked yet. Agents link a session with taskNumber when they open it." })))),
    ]);
  }
  try {
    await load();
  } catch (e) {
    if (e.missing) return void add(root, [unavailable("Tasks")]);
    if (e.status === 404) return void add(root, [link("← All tasks", buildHash("tasks")), emptyState("Task not found", `There is no task #${n}.`, "task")]);
    throw e;
  }
  draw();
}
