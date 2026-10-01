// #/tasks: list + board, filters, create dialog.
import { post } from "../api.js";
import { agentChip, emptyState, labelChips, link, pageHeader, priorityBadge, statusPill, timeEl, unavailable } from "../components.js";
import { add, clear, field, h, icon, openDialog, store, toast } from "../dom.js";
import { buildHash } from "../router.js";
import { plural } from "../time.js";

const STATUSES = ["open", "claimed", "done", "closed"];

export function createTaskDialog(onCreated) {
  const title = h("input", { type: "text", id: "nt-title", required: true, maxLength: 200, placeholder: "Short, imperative summary" });
  const body = h("textarea", { rows: 6, id: "nt-body", placeholder: "Context, acceptance criteria, files to touch (Markdown)" });
  const labels = h("input", { type: "text", id: "nt-labels", placeholder: "bug, docs, auth" });
  const prio = h("select", { id: "nt-prio" }, ["low", "normal", "high", "urgent"].map((p) => h("option", { value: p, text: p, selected: p === "normal" })));
  const deps = h("input", { type: "text", id: "nt-deps", placeholder: "e.g. 3, 5", pattern: "[0-9, ]*" });
  openDialog({
    title: "New task",
    wide: true,
    build: () => h("div", { class: "stack" }, field("Title", title), field("Description", body), h("div", { class: "grid2" }, field("Labels", labels, "Comma separated"), field("Priority", prio)), field("Depends on", deps, "Task numbers that must be done first")),
    actions: [
      { label: "Cancel" },
      { label: "Create task", kind: "primary", submit: true, onClick: async () => {
        const t = await post("tasks", { title: title.value.trim(), body: body.value, labels: labels.value.split(",").map((x) => x.trim()).filter(Boolean), priority: prio.value, dependsOn: deps.value.split(/[ ,]+/).filter(Boolean).map(Number) });
        toast(`Task #${t.number ?? ""} created`, "ok");
        onCreated?.(t);
      } },
    ],
  });
}

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  ctx.setTitle("Tasks");
  const f = { status: route.query.status ?? "", label: route.query.label ?? "", assignee: route.query.assignee ?? "", q: route.query.q ?? "" };
  let view = route.query.view ?? store.get("weave.tasks.view") ?? "list";
  const probe = await optional(api("tasks", { query: { status: f.status, label: f.label, assignee: f.assignee, q: f.q } }));
  if (probe === null) return void add(root, [pageHeader("Tasks"), unavailable("Tasks")]);
  const tasks = Array.isArray(probe) ? probe : probe.tasks ?? [];

  const go = (patch) => (location.hash = buildHash("tasks", {}, { ...f, view, ...patch }));
  const sel = (name, opts, value) => h("select", { id: "tf-" + name, on: { change: (e) => go({ [name]: e.target.value }) } }, opts.map(([v, l]) => h("option", { value: v, text: l, selected: v === value })));
  const text = (name, ph) => h("input", { type: "search", id: "tf-" + name, placeholder: ph, value: f[name], on: { keydown: (e) => e.key === "Enter" && go({ [name]: e.target.value }), change: (e) => go({ [name]: e.target.value }) } });
  const filters = h("div", { class: "filters", role: "search", aria: { label: "Filter tasks" } },
    h("label", { class: "inline" }, h("span", { class: "sr-only", text: "Search" }), text("q", "Search tasks")),
    h("label", { class: "inline" }, h("span", { class: "sr-only", text: "Status" }), sel("status", [["", "Any status"], ...STATUSES.map((s) => [s, s])], f.status)),
    h("label", { class: "inline" }, h("span", { class: "sr-only", text: "Label" }), text("label", "Label")),
    h("label", { class: "inline" }, h("span", { class: "sr-only", text: "Assignee" }), text("assignee", "Assignee")),
    h("div", { class: "seg", role: "group", aria: { label: "View" } }, ["list", "board"].map((v) => h("button", { type: "button", class: "btn btn-sm", aria: { pressed: String(view === v) }, on: { click: () => { view = v; store.set("weave.tasks.view", v); go({ view: v }); } }, text: v === "list" ? "List" : "Board" }))));

  const nextBtn = h("button", { class: "btn", type: "button", text: "Next up", title: "Best open, unblocked task", on: { click: async () => {
    try {
      const r = await optional(api("tasks/next"));
      if (!r?.task) return toast("Nothing is waiting: no open unclaimed task.", "info");
      location.hash = buildHash("task", { n: r.task.number });
    } catch (e) { toast(e.message, "error"); }
  } } });
  add(root, [pageHeader("Tasks", nextBtn, h("button", { class: "btn btn-primary", type: "button", on: { click: () => createTaskDialog((t) => (location.hash = buildHash("task", { n: t.number }))) } }, icon("plus", 14), "New task")), filters]);

  if (!tasks.length) {
    root.appendChild(emptyState("No tasks", f.status || f.label || f.assignee || f.q ? "Nothing matches these filters." : "Create the first task: agents can claim it, work on it in a session and land it.", "task"));
    return;
  }
  const card = (t) => h("div", { class: "task-card" },
    h("div", { class: "task-top" }, link(`#${t.number}`, buildHash("task", { n: t.number }), { class: "mono dim" }), priorityBadge(t.priority)),
    link(t.title, buildHash("task", { n: t.number }), { class: "task-title" }),
    h("div", { class: "task-sub" }, labelChips(t.labels), t.assignee ? agentChip(t.assignee) : h("span", { class: "dim small", text: "unassigned" })),
    t.sessions?.length ? h("div", { class: "dim small" }, icon("change", 12), " " + plural(t.sessions.length, "change")) : null);

  if (view === "board") {
    const cols = h("div", { class: "board", role: "list" });
    for (const st of STATUSES) {
      const items = tasks.filter((t) => t.status === st);
      cols.appendChild(h("section", { class: "board-col", role: "listitem", aria: { label: `${st}: ${items.length}` } }, h("h2", {}, statusPill(st), h("span", { class: "count", text: String(items.length) })), h("div", { class: "board-cards" }, items.length ? items.map(card) : h("p", { class: "muted small", text: "Nothing here" }))));
    }
    root.appendChild(cols);
    return;
  }
  const tb = h("tbody");
  for (const t of tasks) {
    tb.appendChild(h("tr", {},
      h("td", { class: "mono dim nowrap", text: "#" + t.number }),
      h("td", {}, link(t.title, buildHash("task", { n: t.number }), { class: "row-link" }), h("div", { class: "task-sub" }, labelChips(t.labels))),
      h("td", { class: "nowrap" }, statusPill(t.status), " ", priorityBadge(t.priority)),
      h("td", { class: "hide-sm" }, t.assignee ? agentChip(t.assignee) : h("span", { class: "dim", text: "—" })),
      h("td", { class: "right dim nowrap hide-sm" }, timeEl(t.updatedAt))));
  }
  root.appendChild(h("div", { class: "card flush" }, h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: "Tasks" } }, h("thead", {}, h("tr", {}, ["#", "Task", "Status", "Assignee", "Updated"].map((c, i) => h("th", { scope: "col", class: i > 2 ? "hide-sm" : "", text: c })))), tb))));
}
