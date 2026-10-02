// #/settings: repository config (JSON), identities, webhooks. Admin-only parts fail gracefully.
import { ApiError, post } from "../api.js";
import { emptyState, errorBox, pageHeader, timeEl } from "../components.js";
import { add, clear, copyText, field, h, icon, openDialog, toast } from "../dom.js";

import { ownersCard, secretsCard, teamsCard } from "./settings-extra.js";

const KINDS = ["agent", "human", "reviewer", "verifier", "runner", "admin"];

export async function render(ctx) {
  const { root, api, signal } = ctx;
  ctx.setTitle("Settings");
  add(root, [pageHeader("Settings")]);
  const cfgHost = h("section", { class: "card" });
  const hookHost = h("section", { class: "card" });
  const idHost = h("section", { class: "card" });
  const teamHost = h("section", { class: "card" });
  const ownHost = h("section", { class: "card" });
  const secHost = h("section", { class: "card" });
  let hooks = [];
  root.append(cfgHost, ownHost, teamHost, secHost, hookHost, idHost);
  await Promise.all([loadConfig(), loadIdentities(), ownersCard(ownHost, ctx), teamsCard(teamHost, ctx), secretsCard(secHost, ctx)]);

  async function loadConfig() {
    clear(cfgHost);
    cfgHost.appendChild(h("h2", { class: "card-title", id: "h-cfg", text: "Repository configuration" }));
    let cfg;
    try {
      cfg = await api("config");
    } catch (e) {
      if (e.name === "AbortError") return;
      cfgHost.appendChild(e instanceof ApiError && e.missing ? emptyState("Not available", "This server has no config endpoint.", "gear") : errorBox(e, loadConfig));
      return;
    }
    const original = JSON.stringify(cfg, null, 2);
    const ta = h("textarea", { class: "json mono", id: "cfg-json", rows: 18, spellcheck: false, value: original });
    ta.value = original;
    const err = h("p", { class: "form-error", role: "alert" });
    const save = h("button", { class: "btn btn-primary", type: "button", text: "Save configuration", on: { click: async () => {
      err.textContent = "";
      let next;
      try {
        next = JSON.parse(ta.value);
        if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("the config must be a JSON object");
      } catch (e) {
        err.textContent = "Invalid JSON: " + e.message;
        return;
      }
      // webhook secrets are masked ("***") by the server: never send them back unless the user changed webhooks
      if (JSON.stringify(next.webhooks) === JSON.stringify(cfg.webhooks)) delete next.webhooks;
      else if ((next.webhooks ?? []).some((w) => w.secret === "***")) {
        err.textContent = "Webhook secrets are hidden by the server. Re-enter the secret for every webhook you changed (replace \"***\").";
        return;
      }
      save.disabled = true;
      try {
        await post("config", next, { signal });
        toast("Configuration saved", "ok");
        await loadConfig();
        await loadHooks();
      } catch (e) {
        err.textContent = e.forbidden ? `Not allowed: ${e.message} (editing configuration needs the admin scope).` : e.message;
        save.disabled = false;
      }
    } } });
    cfgHost.append(
      h("p", { class: "muted", text: "Checks, review paths, merge policy, shards, mirror and webhooks. Changes apply immediately. Only admins can save; everyone with read access can view." }),
      h("label", { class: "sr-only", htmlFor: "cfg-json", text: "Repository configuration as JSON" }), ta, err,
      h("div", { class: "composer-actions" }, h("button", { class: "btn", type: "button", text: "Reset", on: { click: () => ((ta.value = original), (err.textContent = "")) } }), save));
    hooks = cfg.webhooks ?? [];
    await loadHooks();
  }

  async function loadHooks() {
    clear(hookHost);
    hookHost.appendChild(h("h2", { class: "card-title", text: "Webhooks" }));
    if (!hooks.length) return void hookHost.appendChild(h("p", { class: "muted", text: "No webhooks configured. Add a webhooks array in the JSON above: signed deliveries with retries." }));
    hookHost.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: "Webhooks" } },
      h("thead", {}, h("tr", {}, ["URL", "Events", "Secret"].map((c) => h("th", { scope: "col", text: c })))),
      h("tbody", {}, hooks.map((w) => h("tr", {}, h("td", { class: "mono break", text: w.url }), h("td", {}, (w.events ?? ["*"]).map((e) => h("span", { class: "label", text: e }))), h("td", { class: "dim", text: w.secret ? "set (hidden)" : "none" })))))));
  }

  async function loadIdentities() {
    clear(idHost);
    idHost.appendChild(h("div", { class: "card-title-row" }, h("h2", { class: "card-title", text: "Identities" }), h("button", { class: "btn btn-sm", type: "button", on: { click: createIdentity }, text: "New identity" })));
    let list;
    try {
      list = await api("identities");
    } catch (e) {
      if (e.name === "AbortError") return;
      idHost.appendChild(e.forbidden ? h("p", { class: "muted" }, icon("shield", 14), " Listing identities needs the admin scope. ", e.message) : e instanceof ApiError && e.missing ? emptyState("Not available", "This server has no identities endpoint.", "user") : errorBox(e, loadIdentities));
      return;
    }
    if (!list.length) return void idHost.appendChild(h("p", { class: "muted", text: "No identities yet: the server is in open dev mode until WEAVE_ADMIN_TOKEN is set." }));
    idHost.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: "Identities" } },
      h("thead", {}, h("tr", {}, ["Name", "Kind", "Scopes", "Paths", "Model", "Created", ""].map((c, i) => h("th", { scope: "col", class: i > 2 && i < 6 ? "hide-sm" : "", text: c })))),
      h("tbody", {}, list.map((i) => h("tr", { class: i.disabled ? "disabled-row" : "" },
        h("td", {}, h("strong", { text: i.name }), i.disabled ? h("span", { class: "badge", text: "revoked" }) : null),
        h("td", {}, h("span", { class: "badge", text: i.kind })),
        h("td", {}, (i.scopes ?? []).map((s) => h("span", { class: "label", text: s }))),
        h("td", { class: "mono small hide-sm", text: i.paths?.length ? i.paths.join(", ") : "anywhere" }),
        h("td", { class: "mono small hide-sm", text: i.model ?? "" }),
        h("td", { class: "dim hide-sm" }, timeEl(i.createdAt)),
        h("td", { class: "right" }, i.disabled ? null : h("button", { class: "btn btn-sm btn-danger", type: "button", text: "Revoke", on: { click: async () => {
          try { await post(`identities/${encodeURIComponent(i.id)}/revoke`, {}, { signal }); toast(`${i.name} revoked`, "ok"); loadIdentities(); } catch (e) { toast(e.message, "error"); }
        } } }))))))));
  }

  function createIdentity() {
    const name = h("input", { type: "text", id: "id-name", required: true, pattern: "[A-Za-z0-9._-]+", placeholder: "fixer-bot" });
    const kind = h("select", { id: "id-kind" }, KINDS.map((k) => h("option", { value: k, text: k })));
    const paths = h("input", { type: "text", id: "id-paths", placeholder: "src/, docs/ (empty = anywhere)" });
    const model = h("input", { type: "text", id: "id-model", placeholder: "optional model id" });
    openDialog({ title: "New identity", build: () => h("div", { class: "stack" }, field("Name", name), field("Kind", kind, "Decides the default scopes: agents read and write; reviewers review; admins do everything."), field("Writable paths", paths), field("Model", model)),
      actions: [{ label: "Cancel" }, { label: "Create", kind: "primary", submit: true, onClick: async (close) => {
        const r = await post("identities", { name: name.value.trim(), kind: kind.value, paths: paths.value.split(",").map((s) => s.trim()).filter(Boolean), model: model.value || undefined });
        loadIdentities();
        close();
        showToken(r);
        return false;
      } }] });
  }
  function showToken(r) {
    openDialog({ title: "Token created", build: () => h("div", { class: "stack" }, h("p", {}, "Copy this token now for ", h("strong", { text: r.identity?.name ?? "the identity" }), ". It is shown once and cannot be recovered."), h("code", { class: "token-box", text: r.token })), actions: [{ label: "Copy token", kind: "primary", onClick: async () => { toast((await copyText(r.token)) ? "Token copied" : "Copy failed", "info", 1500); return false; } }, { label: "Done" }] });
  }
}
