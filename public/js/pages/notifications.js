// #/notifications
import { post } from "../api.js";
import { emptyState, pageHeader, timeEl, unavailable } from "../components.js";
import { add, clear, h, icon, store, toast } from "../dom.js";
import { buildHash } from "../router.js";

const LABEL = { mention: "Mention", task_assigned: "Assigned", task_commented: "Comment", review_requested: "Review requested", change_landed: "Landed", change_conflicted: "Conflict" };
const target = (n) => (n.ref?.kind === "task" ? buildHash("task", { n: String(n.ref.id).replace(/\D/g, "") }) : n.ref?.kind === "session" ? buildHash("change", { id: n.ref.id }) : null);

export async function render(ctx) {
  const { root, api, optional, signal } = ctx;
  ctx.setTitle("Notifications");
  let list = await optional(api("notifications"));
  if (list === null) return void add(root, [pageHeader("Notifications"), unavailable("Notifications")]);
  list = list.slice().sort((a, b) => b.ts - a.ts);
  let onlyUnread = store.get("weave.notif.unread") === "1";
  const host = h("div", { class: "card flush" });
  const unreadLabel = h("span");
  const markAll = h("button", { class: "btn", type: "button", on: { click: async () => { try { await post("notifications/read", { all: true }, { signal }); list.forEach((n) => (n.read = true)); toast("All marked as read", "ok"); draw(); ctx.rerenderBell(); } catch (e) { toast(e.message, "error"); } } } }, icon("check", 14), "Mark all read");
  const toggle = h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: onlyUnread, on: { change: (e) => ((onlyUnread = e.target.checked), store.set("weave.notif.unread", onlyUnread ? "1" : "0"), draw()) } }), h("span", { text: "Unread only" }));
  add(root, [pageHeader("Notifications", toggle, markAll), host]);

  async function read(n) {
    if (n.read) return;
    n.read = true;
    try { await post("notifications/read", { ids: [n.id] }, { signal }); } catch { n.read = false; }
    ctx.rerenderBell();
  }
  function draw() {
    clear(host);
    const unread = list.filter((n) => !n.read).length;
    markAll.disabled = !unread;
    const shown = onlyUnread ? list.filter((n) => !n.read) : list;
    if (!shown.length) return void host.appendChild(emptyState(onlyUnread ? "You are all caught up" : "No notifications", "You are notified when you are mentioned, assigned a task, or a change you care about lands or conflicts.", "bell"));
    const ul = h("ul", { class: "notifs" });
    for (const n of shown) {
      const href = target(n);
      const body = h("div", { class: "notif-main" }, h("div", { class: "notif-type" }, h("span", { class: "badge", text: LABEL[n.type] ?? n.type }), timeEl(n.ts)), h("div", { class: "notif-msg", text: n.message }));
      const open = href ? h("a", { class: "notif-link", href, on: { click: () => read(n) } }, body) : body;
      ul.appendChild(h("li", { class: "notif" + (n.read ? "" : " unread") }, h("span", { class: "unread-dot", title: n.read ? "" : "Unread", aria: { hidden: "true" } }), open, n.read ? null : h("button", { class: "btn btn-sm", type: "button", text: "Mark read", on: { click: async () => { await read(n); draw(); } } })));
    }
    host.appendChild(ul);
    unreadLabel.textContent = `${unread} unread`;
  }
  draw();
}
