// Weave web UI: app shell, hash routing, sign-in, repo switcher, notification bell.
import { ApiError, api, isAbort, onUnauthorized, optional, session } from "./js/api.js";
import { emptyState, errorBox, loading } from "./js/components.js";
import { $, $$, clear, field, h, icon, openDialog, toast } from "./js/dom.js";
import { buildHash, parseHash, sectionOf } from "./js/router.js";

const PAGES = { home: "code", tree: "code", blob: "blob", commits: "commits", commit: "commit", changes: "changes", change: "change", tasks: "tasks", task: "task", search: "search", activity: "activity", releases: "releases", notifications: "notifications", settings: "settings", repos: "repos" };
const TITLES = { home: "Code", tree: "Code", blob: "File", commits: "Commits", commit: "Commit", changes: "Changes", change: "Change", tasks: "Tasks", task: "Task", search: "Search", activity: "Activity", releases: "Releases", notifications: "Notifications", settings: "Settings", repos: "Repositories" };

const main = $("#main");
let ctrl = null;
let prev = null;
let cleanups = [];
let fragHandler = null;

function setTitle(t) {
  document.title = t ? `${t} · Weave` : "Weave";
}

// ---- routing ------------------------------------------------------------------------------------
async function route() {
  const r = parseHash(location.hash);
  // only the #fragment changed on the same page (e.g. a new #L anchor): let the page handle it
  if (prev && fragHandler && prev.name === r.name && JSON.stringify([prev.params, prev.query]) === JSON.stringify([r.params, r.query]) && prev.frag !== r.frag) {
    prev = r;
    fragHandler(r.frag);
    return;
  }
  prev = r;
  ctrl?.abort();
  for (const f of cleanups) f();
  cleanups = [];
  fragHandler = null;
  ctrl = new AbortController();
  const signal = ctrl.signal;
  const sec = sectionOf(r.name);
  for (const a of $$("#nav a")) {
    if (a.dataset.section === sec) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const root = h("div", { class: "page page-" + r.name });
  main.replaceChildren(root);
  root.appendChild(loading());
  setTitle(TITLES[r.name] ?? "Not found");
  const ctx = {
    root, route: r, signal,
    api: (p, o) => api(p, { signal, ...o }),
    optional,
    setTitle,
    refresh: () => route(),
    onCleanup: (f) => cleanups.push(f),
    onFrag: (f) => (fragHandler = f),
    rerenderBell: refreshBell,
  };
  try {
    if (r.name === "notfound") {
      clear(root).appendChild(emptyState("Page not found", `There is no page at #/${r.params.path}.`, "search", h("a", { class: "btn", href: "#/", text: "Go to the repository" })));
      return;
    }
    const mod = await import(`./js/pages/${PAGES[r.name]}.js`);
    if (signal.aborted) return;
    clear(root);
    await mod.render(ctx);
    if (signal.aborted) return;
    if (!r.frag) {
      window.scrollTo(0, 0);
      if (document.activeElement === document.body || main.contains(document.activeElement)) main.focus({ preventScroll: true });
    }
  } catch (e) {
    if (isAbort(e) || signal.aborted) return;
    clear(root);
    if (e instanceof ApiError && e.unauthorized) return renderSignIn(root, e);
    if (e instanceof ApiError && e.missing) {
      root.appendChild(emptyState("Not available on this server", "The API behind this page is not implemented here yet.", "warn"));
      return;
    }
    root.appendChild(errorBox(e, () => route()));
    if (!(e instanceof ApiError)) console.error(e);
  }
}

// ---- sign-in ------------------------------------------------------------------------------------
function renderSignIn(root, err) {
  clear(root);
  const input = h("input", { type: "password", id: "signin-token", autocomplete: "off", placeholder: "weave token", spellcheck: "false", required: true });
  const form = h(
    "form",
    { class: "card signin", on: { submit: (e) => { e.preventDefault(); session.token = input.value.trim(); setAccountLabel(); route(); refreshBell(); loadRepos(); } } },
    h("h1", { text: "Sign in to Weave" }),
    h("p", { class: "muted", text: session.token ? "That token was not accepted." : "This server requires a token. Agents and people each have their own; ask an admin to create one for you." }),
    err?.message ? h("p", { class: "muted small", text: err.message }) : null,
    field("Token", input, "Stored in this browser only and sent as Authorization: Bearer."),
    h("button", { class: "btn btn-primary", type: "submit", text: "Sign in" }),
  );
  root.appendChild(h("div", { class: "center" }, form));
  setTitle("Sign in");
  input.focus();
}
onUnauthorized(() => {
  $("#bell").hidden = true;
});

function accountDialog() {
  const tok = h("input", { type: "password", id: "acct-token", autocomplete: "off", value: session.token, placeholder: "no token (open dev mode)", spellcheck: "false" });
  const name = h("input", { type: "text", id: "acct-name", value: session.name, placeholder: "anonymous", autocomplete: "off" });
  openDialog({
    title: "Account",
    build: () => h("div", { class: "stack" }, field("Token", tok, "Sent as Authorization: Bearer on every request. Leave empty when the server runs in open dev mode."), field("Display name", name, "Only used in open dev mode, where the server trusts the name you send as author, reviewer or agent.")),
    actions: [
      { label: "Sign out", kind: "danger", onClick: () => { session.token = ""; setAccountLabel(); route(); refreshBell(); } },
      { label: "Save", kind: "primary", submit: true, onClick: () => { session.token = tok.value.trim(); session.name = name.value.trim(); setAccountLabel(); route(); refreshBell(); loadRepos(); } },
    ],
  });
}
function setAccountLabel() {
  $("#token-label").textContent = session.name || (session.token ? "Signed in" : "Sign in");
}

// ---- notification bell --------------------------------------------------------------------------
async function refreshBell() {
  try {
    const list = await optional(api("notifications", { query: { unread: 1 } }));
    const bell = $("#bell");
    if (!list) return void (bell.hidden = true);
    bell.hidden = false;
    const n = Array.isArray(list) ? list.filter((x) => !x.read).length : 0;
    const c = $("#bell-count");
    c.hidden = n === 0;
    c.textContent = n > 99 ? "99+" : String(n);
    bell.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
  } catch {
    /* bell is best-effort */
  }
}

// ---- repo switcher ------------------------------------------------------------------------------
async function loadRepos() {
  const sel = $("#repo-select");
  clear(sel);
  let repos = null;
  try {
    repos = await optional(api("repos"));
  } catch {
    /* 401 etc: sign-in handles it */
  }
  const names = Array.isArray(repos) && repos.length ? repos.map((r) => r.name) : [session.repo];
  if (!names.includes(session.repo)) names.push(session.repo);
  for (const n of names) sel.appendChild(h("option", { value: n, text: n }));
  sel.value = session.repo;
  sel.disabled = !Array.isArray(repos);
  sel.title = sel.disabled ? "Repository list is not available on this server" : "Switch repository";
}

// ---- wiring -------------------------------------------------------------------------------------
$("#bell-icon").replaceWith(icon("bell", 18));
$("#token-icon").replaceWith(icon("key", 16));
$("#token-btn").addEventListener("click", accountDialog);
$("#repo-select").addEventListener("change", (e) => {
  session.repo = e.target.value;
  if (location.hash && location.hash !== "#/") location.hash = "#/";
  else route();
  refreshBell();
});
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#global-q").value.trim();
  if (q) location.hash = buildHash("search", {}, { q });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "") && !document.activeElement?.isContentEditable) {
    e.preventDefault();
    $("#global-q").focus();
    $("#global-q").select();
  }
  if (e.key === "Escape" && document.activeElement === $("#global-q")) $("#global-q").blur();
});
window.addEventListener("hashchange", route);
window.addEventListener("weave:toast", (e) => toast(e.detail.message, e.detail.kind));
setAccountLabel();
loadRepos();
refreshBell();
setInterval(() => !document.hidden && refreshBell(), 30000);
route();
