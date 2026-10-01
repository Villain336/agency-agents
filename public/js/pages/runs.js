// #/runs: workflows (with a Run button for manual ones) and recent workflow runs.
import { post } from "../api.js";
import { emptyState, link, pageHeader, timeEl, unavailable } from "../components.js";
import { RUN_LABEL, latestByWorkflow, runPillClass, sortRuns, triggerText } from "../forge.js";
import { add, h, icon, toast } from "../dom.js";
import { buildHash } from "../router.js";
import { fmtDuration, plural } from "../time.js";

export const runPill = (status) => h("span", { class: runPillClass(status), text: RUN_LABEL[status] ?? status });

export async function render(ctx) {
  const { root, api, optional, route } = ctx;
  ctx.setTitle("Runs");
  const wf = route.query.workflow ?? "";
  const st = route.query.status ?? "";
  const [workflows, runs] = await Promise.all([optional(api("workflows")), optional(api("runs", { query: { workflow: wf, status: st } }))]);
  if (workflows === null && runs === null) return void add(root, [pageHeader("Runs"), unavailable("Workflows and runs")]);
  add(root, [pageHeader("Runs")]);

  // ---- workflows
  const wfCard = h("section", { class: "card flush", aria: { label: "Workflows" } });
  wfCard.appendChild(h("h2", { class: "card-title pad-title", text: "Workflows" }));
  if (workflows === null) wfCard.appendChild(h("p", { class: "muted pad", text: "The workflow list is not available on this server." }));
  else if (!workflows.length) wfCard.appendChild(h("p", { class: "muted pad", text: "No workflows configured. Add a workflows array to the repository configuration: name, on (landed, tag, manual), command, optional paths and secrets." }));
  else {
    const latest = latestByWorkflow(runs ?? []);
    wfCard.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: "Workflows" } },
      h("thead", {}, h("tr", {}, ["Workflow", "Runs on", "Command", "Latest"].map((c, i) => h("th", { scope: "col", class: i === 2 ? "hide-sm" : "", text: c })))),
      h("tbody", {}, workflows.map((w) => {
        const last = latest.get(w.name);
        const btn = (w.on ?? []).includes("manual") ? h("button", { class: "btn btn-sm", type: "button", on: { click: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await post(`workflows/${encodeURIComponent(w.name)}/run`, {});
            toast(`Queued ${w.name} as ${r.id}`, "ok");
            location.hash = buildHash("run", { id: r.id });
          } catch (er) {
            toast(er.forbidden ? `Not allowed: ${er.message}` : er.message, "error");
            e.currentTarget.disabled = false;
          }
        } } }, icon("play", 12), "Run") : null;
        return h("tr", {},
          h("td", {}, h("strong", { text: w.name }), w.secrets?.length ? h("div", { class: "dim small" }, icon("key", 12), " " + w.secrets.join(", ")) : null, btn ? h("div", { class: "wf-run" }, btn) : null),
          h("td", {}, (w.on ?? []).map((o) => h("span", { class: "label", text: o })), w.paths?.length ? h("div", { class: "dim small mono", text: w.paths.join(", ") }) : null),
          h("td", { class: "mono small hide-sm break", text: w.command }),
          h("td", {}, last ? h("a", { href: buildHash("run", { id: last.id }), class: "run-link" }, runPill(last.status)) : h("span", { class: "dim", text: "never run" })),
          );
      })))));
  }
  root.appendChild(wfCard);

  // ---- runs
  const runCard = h("section", { class: "card flush", aria: { label: "Runs" } });
  const names = [...new Set([...(workflows ?? []).map((w) => w.name), ...(runs ?? []).map((r) => r.workflow)])];
  const go = (q) => (location.hash = buildHash("runs", {}, { workflow: wf, status: st, ...q }));
  const selWf = h("select", { id: "f-wf", aria: { label: "Filter by workflow" }, on: { change: (e) => go({ workflow: e.target.value }) } }, [h("option", { value: "", text: "All workflows" }), ...names.map((n) => h("option", { value: n, text: n, selected: n === wf }))]);
  const selSt = h("select", { id: "f-st", aria: { label: "Filter by status" }, on: { change: (e) => go({ status: e.target.value }) } }, [h("option", { value: "", text: "Any status" }), ...Object.entries(RUN_LABEL).map(([k, v]) => h("option", { value: k, text: v, selected: k === st }))]);
  runCard.appendChild(h("div", { class: "card-title-row pad-title" }, h("h2", { class: "card-title", text: "Recent runs" }), h("div", { class: "filters" }, selWf, selSt)));
  if (runs === null) runCard.appendChild(h("p", { class: "muted pad", text: "The run list is not available on this server." }));
  else if (!runs.length) runCard.appendChild(emptyState("No runs", wf || st ? "No run matches these filters." : "Runs appear when a landing, a tag or a manual trigger starts a workflow.", "play"));
  else {
    runCard.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: plural(runs.length, "run") } },
      h("thead", {}, h("tr", {}, ["Run", "Workflow", "Status", "Trigger", "Revision", "Duration", "Started"].map((c, i) => h("th", { scope: "col", class: i === 3 || i === 4 || i === 5 ? "hide-sm" : "", text: c })))),
      h("tbody", {}, sortRuns(runs).map((r) => h("tr", {},
        h("td", {}, link(r.id, buildHash("run", { id: r.id }), { class: "row-link mono" })),
        h("td", { text: r.workflow }),
        h("td", {}, runPill(r.status)),
        h("td", { class: "small hide-sm", text: triggerText(r) }),
        h("td", { class: "hide-sm" }, link("r" + r.rev, buildHash("commit", { rev: r.rev }), { class: "mono" })),
        h("td", { class: "dim hide-sm", text: r.durationMs !== undefined ? fmtDuration(r.durationMs) : "" }),
        h("td", { class: "dim" }, timeEl(r.createdAt))))))));
  }
  root.appendChild(runCard);
}
