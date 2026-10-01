// #/repos: repository switcher. The selected repo is stored locally and sent as ?repo=.
import { ApiError, post, session } from "../api.js";
import { emptyState, link, pageHeader, timeEl, unavailable } from "../components.js";
import { add, field, h, icon, openDialog, toast } from "../dom.js";
import { buildHash } from "../router.js";

export async function render(ctx) {
  const { root, api, optional } = ctx;
  ctx.setTitle("Repositories");
  const repos = await optional(api("repos", { query: {} }));
  const use = (name) => {
    session.repo = name;
    toast(`Now using ${name}`, "ok", 2200);
    location.hash = "#/";
    location.reload(); // header selector, bell and every cached view follow the new repo
  };
  const manual = h("form", { class: "inline-form", on: { submit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) use(v); } } }, h("label", { class: "sr-only", htmlFor: "repo-name", text: "Repository name" }), h("input", { type: "text", id: "repo-name", placeholder: "repository name", value: session.repo, autocomplete: "off", spellcheck: false }), h("button", { class: "btn", type: "submit", text: "Switch" }));
  const input = manual.querySelector("input");

  const create = () => {
    const name = h("input", { type: "text", id: "rp-name", required: true, pattern: "[A-Za-z0-9._-]+", placeholder: "my-repo" });
    const desc = h("input", { type: "text", id: "rp-desc", placeholder: "What lives here?" });
    const from = h("select", { id: "rp-from" }, [h("option", { value: "", text: "Empty repository" }), ...(repos ?? []).map((r) => h("option", { value: r.name, text: "Fork of " + r.name }))]);
    openDialog({ title: "New repository", build: () => h("div", { class: "stack" }, field("Name", name, "Letters, digits, dots, dashes."), field("Description", desc), field("Start from", from)), actions: [{ label: "Cancel" }, { label: "Create", kind: "primary", submit: true, onClick: async () => {
      await post("repos", { name: name.value.trim(), description: desc.value || undefined, fork: from.value ? { from: from.value } : undefined });
      toast("Repository created (admin)", "ok");
      ctx.refresh();
    } }] });
  };

  add(root, [pageHeader("Repositories", repos ? h("button", { class: "btn btn-primary", type: "button", on: { click: create } }, icon("plus", 14), "New repository") : null), h("p", { class: "muted" }, "Current repository: ", h("strong", { text: session.repo }), ". The selection is stored in this browser and sent as ", h("code", { text: "?repo=" }), " on every request.")]);
  if (!repos) {
    add(root, [unavailable("Repository list"), h("section", { class: "card" }, h("h2", { class: "card-title", text: "Switch by name" }), manual)]);
    return;
  }
  if (!repos.length) return void root.appendChild(emptyState("No repositories", "Create one to get started.", "repo"));
  const grid = h("div", { class: "repo-grid" });
  for (const r of repos) {
    const current = r.name === session.repo;
    grid.appendChild(h("article", { class: "card repo-card" + (current ? " current" : "") },
      h("h2", {}, icon("repo", 16), " ", r.name, current ? h("span", { class: "badge ok", text: "current" }) : null),
      h("p", { class: r.description ? "" : "muted", text: r.description || "No description." }),
      h("div", { class: "dim small" }, "r" + r.rev, " · created ", timeEl(r.createdAt), r.forkedFrom ? ` · forked from ${typeof r.forkedFrom === "string" ? r.forkedFrom : r.forkedFrom.from}` : ""),
      h("div", { class: "repo-actions" }, current ? link("Open", buildHash("home"), { class: "btn btn-sm" }) : h("button", { class: "btn btn-sm btn-primary", type: "button", on: { click: () => use(r.name) }, text: "Use this repository" }))));
  }
  root.appendChild(grid);
  root.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Switch by name" }), manual));
}
void ApiError;
