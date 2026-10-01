// Settings cards: Teams, Code owners editor, Secrets. Each loads on its own and degrades to a
// "not available" note when its endpoint is missing; admin-only actions report 403 politely.
import { ApiError, post } from "../api.js";
import { emptyState, errorBox } from "../components.js";
import { TEAM_NAME, cleanOwnerRules, ownerRef, parseList } from "../forge.js";
import { clear, confirmDialog, field, h, icon, openDialog, toast } from "../dom.js";

const denied = (e) => (e.forbidden ? `Not allowed: ${e.message} (this needs the admin scope).` : e.message);
const aborted = (e) => e?.name === "AbortError";
const title = (text, ...right) => h("div", { class: "card-title-row" }, h("h2", { class: "card-title", text }), ...right);

// ---- teams ----------------------------------------------------------------------------------------
export async function teamsCard(host, ctx) {
  const { api, signal } = ctx;
  async function load() {
    clear(host);
    let teams;
    try {
      teams = await api("teams");
    } catch (e) {
      if (aborted(e)) return;
      host.append(title("Teams"), e instanceof ApiError && e.missing ? emptyState("Not available", "This server has no teams endpoint.", "user") : errorBox(e, load));
      return;
    }
    host.appendChild(title("Teams", h("button", { class: "btn btn-sm", type: "button", text: "New team", on: { click: createTeam } })));
    host.appendChild(h("p", { class: "muted small", text: "Teams group identities so a code-owner rule can name team:<name> instead of listing people." }));
    if (!teams.length) return void host.appendChild(h("p", { class: "muted", text: "No teams yet." }));
    host.appendChild(h("ul", { class: "plain teams" }, teams.map((t) => h("li", { class: "team" },
      h("div", { class: "team-head" }, h("strong", { class: "mono", text: "team:" + t.name }), t.description ? h("span", { class: "dim", text: t.description }) : null),
      h("div", { class: "team-members" }, t.members.length ? t.members.map((m) => h("span", { class: "chip" }, m, h("button", { class: "chip-x", type: "button", title: `Remove ${m}`, aria: { label: `Remove ${m} from ${t.name}` }, on: { click: () => change(t.name, { remove: [m] }, `${m} removed from ${t.name}`) } }, icon("x", 10)))) : h("span", { class: "dim", text: "no members" })),
      h("div", { class: "team-actions" },
        h("button", { class: "btn btn-sm", type: "button", text: "Add members", on: { click: () => addMembers(t) } }),
        h("button", { class: "btn btn-sm btn-danger", type: "button", text: "Delete team", on: { click: () => del(t) } }))))));
  }
  async function change(name, body, msg) {
    try {
      await post("teams/" + encodeURIComponent(name), body, { signal });
      toast(msg, "ok");
      await load();
    } catch (e) {
      toast(denied(e), "error");
    }
  }
  function createTeam() {
    const name = h("input", { type: "text", id: "tm-name", required: true, pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]*", placeholder: "core" });
    const desc = h("input", { type: "text", id: "tm-desc", placeholder: "What this team owns" });
    const members = h("input", { type: "text", id: "tm-members", placeholder: "maria, claude-fixer" });
    openDialog({ title: "New team", build: () => h("div", { class: "stack" }, field("Name", name, "Letters, digits, dot, dash, underscore. Referenced as team:<name>."), field("Description", desc), field("Members", members, "Identity names, comma separated.")),
      actions: [{ label: "Cancel" }, { label: "Create team", kind: "primary", submit: true, onClick: async () => {
        if (!TEAM_NAME.test(name.value.trim())) throw new Error("Invalid team name.");
        try { await post("teams", { name: name.value.trim(), members: parseList(members.value), description: desc.value.trim() }); } catch (e) { throw new Error(denied(e)); }
        toast("Team created", "ok");
        load();
      } }] });
  }
  function addMembers(t) {
    const members = h("input", { type: "text", id: "tm-add", required: true, placeholder: "maria, test-writer" });
    openDialog({ title: `Add to ${t.name}`, build: () => h("div", { class: "stack" }, field("Members", members, "Identity names, comma separated.")),
      actions: [{ label: "Cancel" }, { label: "Add", kind: "primary", submit: true, onClick: async () => {
        try { await post("teams/" + encodeURIComponent(t.name), { add: parseList(members.value) }); } catch (e) { throw new Error(denied(e)); }
        toast("Members added", "ok");
        load();
      } }] });
  }
  async function del(t) {
    if (!(await confirmDialog(`Delete team ${t.name}?`, "Code-owner rules that mention team:" + t.name + " will no longer match anyone.", "Delete team", "danger"))) return;
    try {
      await post(`teams/${encodeURIComponent(t.name)}/delete`, {}, { signal });
      toast("Team deleted", "ok");
      load();
    } catch (e) {
      toast(denied(e), "error");
    }
  }
  await load();
}

// ---- code owners -----------------------------------------------------------------------------------
export async function ownersCard(host, ctx) {
  const { api, signal } = ctx;
  let teamNames = [];
  async function load() {
    clear(host);
    let cfg;
    try {
      cfg = await api("config");
    } catch (e) {
      if (aborted(e)) return;
      host.append(title("Code owners"), e instanceof ApiError && e.missing ? emptyState("Not available", "This server has no config endpoint.", "shield") : errorBox(e, load));
      return;
    }
    teamNames = await api("teams").then((t) => t.map((x) => x.name), () => []);
    const rows = (cfg.owners ?? []).map((r) => ({ pattern: r.pattern, owners: r.owners.join(", ") }));
    const body = h("div", { class: "owner-rows stack" });
    const err = h("p", { class: "form-error", role: "alert" });
    const draw = () => {
      clear(body);
      if (!rows.length) return void body.appendChild(h("p", { class: "muted", text: "No code-owner rules. A change touching a matching path then needs no owner approval." }));
      body.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "list-table owners-table", aria: { label: "Code owner rules" } },
        h("thead", {}, h("tr", {}, ["Path pattern", "Owners", ""].map((c) => h("th", { scope: "col", text: c })))),
        h("tbody", {}, rows.map((r, i) => h("tr", {},
          h("td", {}, h("input", { type: "text", class: "mono", id: `own-p-${i}`, value: r.pattern, placeholder: "src/auth/", spellcheck: false, aria: { label: `Pattern for rule ${i + 1}` }, on: { input: (e) => (r.pattern = e.target.value) } })),
          h("td", {}, h("input", { type: "text", id: `own-o-${i}`, value: r.owners, placeholder: "maria, team:core", spellcheck: false, aria: { label: `Owners for rule ${i + 1}` }, on: { input: (e) => (r.owners = e.target.value) } })),
          h("td", { class: "right" }, h("button", { class: "btn btn-sm btn-danger", type: "button", title: "Remove rule", aria: { label: `Remove rule ${i + 1}` }, on: { click: () => (rows.splice(i, 1), draw()) } }, icon("x", 14)))))))));
    };
    draw();
    const save = h("button", { class: "btn btn-primary", type: "button", text: "Save owners", on: { click: async () => {
      const { rules, error } = cleanOwnerRules(rows);
      err.textContent = error;
      if (error) return;
      const unknown = rules.flatMap((r) => r.owners).map(ownerRef).filter((o) => o.kind === "team" && !teamNames.includes(o.name));
      if (unknown.length && teamNames.length) return void (err.textContent = `Unknown team: ${[...new Set(unknown.map((o) => o.name))].join(", ")}. Create it above first.`);
      save.disabled = true;
      try {
        await post("config", { owners: rules }, { signal });
        toast("Code owners saved", "ok");
        ctx.refresh();
      } catch (e) {
        err.textContent = denied(e);
        save.disabled = false;
      }
    } } });
    host.append(title("Code owners"),
      h("p", { class: "muted small" }, "A change that touches a matching path needs approval from one of its owners before it can land. Owners are identity names or ", h("code", { class: "mono", text: "team:<name>" }), ". Patterns are CODEOWNERS-style paths."),
      body, err,
      h("div", { class: "composer-actions" }, h("button", { class: "btn", type: "button", text: "Add rule", on: { click: () => (rows.push({ pattern: "", owners: "" }), draw(), document.getElementById(`own-p-${rows.length - 1}`)?.focus()) } }), save));
  }
  await load();
}

// ---- secrets ---------------------------------------------------------------------------------------
export async function secretsCard(host, ctx) {
  const { api, signal } = ctx;
  async function load() {
    clear(host);
    let list;
    try {
      list = await api("secrets");
    } catch (e) {
      if (aborted(e)) return;
      host.append(title("Secrets"), e.forbidden ? h("p", { class: "muted" }, icon("shield", 14), " Listing secrets needs the admin scope. ", e.message) : e instanceof ApiError && e.missing ? emptyState("Not available", "This server has no secrets endpoint.", "key") : errorBox(e, load));
      return;
    }
    host.appendChild(title("Secrets", h("button", { class: "btn btn-sm", type: "button", text: "Add secret", on: { click: addSecret } })));
    host.appendChild(h("p", { class: "muted small", text: "Delivered to workflow runs that list them, as environment variables. Values are write-only: they can be replaced but never read back." }));
    if (!list.length) return void host.appendChild(h("p", { class: "muted", text: "No secrets stored." }));
    host.appendChild(h("ul", { class: "plain secrets" }, list.map((s) => h("li", { class: "secret" }, icon("key", 14), h("code", { class: "mono grow break", text: s.name }), h("span", { class: "dim small", text: "value hidden" }), h("button", { class: "btn btn-sm btn-danger", type: "button", text: "Delete", aria: { label: `Delete secret ${s.name}` }, on: { click: () => del(s.name) } })))));
  }
  function addSecret() {
    const name = h("input", { type: "text", id: "sc-name", required: true, pattern: "[A-Za-z_][A-Za-z0-9_]*", placeholder: "DEPLOY_TOKEN", autocomplete: "off", spellcheck: false });
    const value = h("input", { type: "password", id: "sc-value", required: true, autocomplete: "new-password", spellcheck: false });
    openDialog({ title: "Add secret", build: () => h("div", { class: "stack" }, field("Name", name, "Environment variable name. Setting an existing name replaces its value."), field("Value", value, "Stored on the server; never shown again.")),
      actions: [{ label: "Cancel" }, { label: "Save secret", kind: "primary", submit: true, onClick: async () => {
        try { await post("secrets", { name: name.value.trim(), value: value.value }); } catch (e) { throw new Error(denied(e)); }
        toast("Secret saved", "ok");
        load();
      } }] });
  }
  async function del(name) {
    if (!(await confirmDialog(`Delete secret ${name}?`, "Workflows that list it will run without it.", "Delete secret", "danger"))) return;
    try {
      await post(`secrets/${encodeURIComponent(name)}/delete`, {}, { signal });
      toast("Secret deleted", "ok");
      load();
    } catch (e) {
      toast(denied(e), "error");
    }
  }
  await load();
}
