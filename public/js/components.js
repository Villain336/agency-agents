// Shared presentational pieces. All text goes through textContent.
import { add, clear, copyText, h, icon, toast } from "./dom.js";
import { highlight, langOf } from "./highlight.js";
import { parsePatch } from "./diff.js";
import { buildHash } from "./router.js";
import { fullTime, relTime } from "./time.js";
import { renderMarkdown } from "./markdown.js";

export const link = (text, hash, props = {}) => h("a", { href: hash, ...props }, text);

export function timeEl(ts) {
  if (typeof ts !== "number") return h("span");
  return h("time", { dateTime: new Date(ts).toISOString(), title: fullTime(ts), text: relTime(ts) });
}

const hue = (s) => {
  let n = 0;
  for (const c of String(s)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % 8;
};
export function avatar(name, size = 20) {
  const initials = String(name || "?").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  return h("span", { class: `avatar av-${hue(name)}`, aria: { hidden: "true" }, style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.46) + "px" }, text: initials });
}
export const agentChip = (name) => h("span", { class: "agent" }, avatar(name), h("span", { class: "agent-name", text: name || "unknown" }));

export const STATUS_LABEL = { active: "Active", conflicted: "Conflicted", needs_verify: "Needs verify", verifying: "Verifying", in_review: "In review", landed: "Landed", rejected: "Rejected", open: "Open", claimed: "Claimed", done: "Done", closed: "Closed" };
export const statusPill = (status) => h("span", { class: `pill st-${status}`, text: STATUS_LABEL[status] ?? status });
export function riskBadge(risk) {
  if (!risk) return h("span", { class: "badge risk-none", text: "no risk score", title: "Risk is computed once the change merges cleanly." });
  return h("span", { class: `badge risk-${risk.tier}`, title: (risk.reasons ?? []).join("\n") }, icon("shield", 12), ` ${risk.tier} risk`, h("b", { text: ` ${risk.score}` }));
}
export const priorityBadge = (p) => (p && p !== "normal" ? h("span", { class: `badge prio-${p}`, text: p }) : null);
export const labelChips = (labels) => (labels ?? []).map((l) => h("span", { class: "label", text: l }));

export function emptyState(title, message, ic = "file", action) {
  return h("div", { class: "empty" }, icon(ic, 32), h("h3", { text: title }), message ? h("p", { text: message }) : null, action ?? null);
}
export const unavailable = (what) => emptyState(`${what} are not available`, `This server does not expose the ${what.toLowerCase()} API yet, so this part of the UI is hidden. Everything else keeps working.`, "warn");
export function loading(label = "Loading") {
  return h("div", { class: "loading", role: "status", aria: { live: "polite" } }, h("span", { class: "spinner", aria: { hidden: "true" } }), h("span", { text: label + "…" }));
}
export function errorBox(err, retry) {
  const msg = err?.message ?? String(err);
  return h("div", { class: "alert alert-error", role: "alert" }, icon("warn"), h("div", { class: "grow" }, h("strong", { text: err?.status ? `Error ${err.status}` : "Something went wrong" }), h("p", { text: msg })), retry ? h("button", { class: "btn", type: "button", on: { click: retry }, text: "Retry" }) : null);
}

export const md = (src) => h("div", { class: "md" }, renderMarkdown(src));

/** Roving-tabindex tab list. items: [{id,label,count}] */
export function tabs(items, active, onSelect, label) {
  const list = h("div", { class: "tabs", role: "tablist", aria: { label } });
  const btns = items.map((it) =>
    h("button", { class: "tab", type: "button", role: "tab", id: `tab-${it.id}`, aria: { selected: it.id === active, controls: "tabpanel" }, tabIndex: it.id === active ? 0 : -1, on: { click: () => onSelect(it.id) } }, it.label, it.count !== undefined ? h("span", { class: "count", text: String(it.count) }) : null),
  );
  list.addEventListener("keydown", (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const j = e.key === "ArrowRight" ? (i + 1) % btns.length : e.key === "ArrowLeft" ? (i - 1 + btns.length) % btns.length : e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : -1;
    if (j >= 0) {
      e.preventDefault();
      btns[j].focus();
      btns[j].click();
    }
  });
  return add(list, btns);
}

export function pageHeader(title, ...right) {
  return h("div", { class: "page-head" }, h("h1", { text: title }), h("div", { class: "page-actions" }, right));
}

export function breadcrumb(path, rev, last = "tree") {
  const nav = h("nav", { class: "crumbs", aria: { label: "Path" } });
  const q = rev ? { rev } : {};
  nav.appendChild(link("root", buildHash("home", {}, q), { class: "crumb" }));
  const segs = path ? path.split("/") : [];
  segs.forEach((s, i) => {
    nav.appendChild(h("span", { class: "sep", aria: { hidden: "true" }, text: "/" }));
    const p = segs.slice(0, i + 1).join("/");
    if (i === segs.length - 1) nav.appendChild(h("span", { class: "crumb current", aria: { current: "page" }, text: s }));
    else nav.appendChild(link(s, buildHash("tree", { path: p }, q), { class: "crumb" }));
  });
  return nav;
}

export function lineCountBar(added, removed) {
  const total = added + removed || 1;
  const n = 5;
  const a = Math.round((added / total) * n);
  const box = h("span", { class: "diffstat", aria: { hidden: "true" } });
  for (let i = 0; i < n; i++) box.appendChild(h("i", { class: i < a ? "a" : i < (added ? a : 0) + Math.ceil((removed / total) * n) ? "r" : "" }));
  return box;
}

export function copyButton(text, label = "Copy") {
  return h("button", { class: "btn btn-sm", type: "button", on: { click: async () => toast((await copyText(text)) ? "Copied to clipboard" : "Copy failed", "info", 1800) } }, icon("copy", 14), label);
}

// ---- diff view ----------------------------------------------------------------------------------
const MAX_ROWS = 1500;

function codeCell(text, lang) {
  const td = h("td", { class: "code" });
  if (text.length > 400 || !lang || lang === "text") {
    td.textContent = text || "​";
    return td;
  }
  const toks = highlight(text, lang)[0] ?? [];
  for (const t of toks) td.appendChild(t.c ? h("span", { class: "tk-" + t.c, text: t.t }) : document.createTextNode(t.t));
  if (!toks.length) td.textContent = "​";
  return td;
}

/**
 * One file's diff. opts: {commentsByLine: Map<newN, Node[]>, onLineComment(line, text, afterRow), collapsed, key}
 * Returns the <section>. Rows carry data-line (new line number) so callers can attach threads.
 */
export function diffFile(file, opts = {}) {
  const hunks = parsePatch(file.patch);
  const lang = langOf(file.path);
  const rows = hunks.reduce((n, x) => n + x.lines.length + 1, 0);
  const startCollapsed = opts.collapsed ?? rows > 600;
  const sec = h("section", { class: "diff-file", id: opts.id, data: { path: file.path } });
  const body = h("div", { class: "diff-body" });
  const toggle = h("button", { class: "diff-toggle", type: "button", aria: { expanded: !startCollapsed }, on: { click: () => setOpen(toggle.getAttribute("aria-expanded") !== "true") } }, icon("down", 16, "chev"), h("span", { class: "diff-path", text: file.path }));
  const head = h("div", { class: "diff-head" }, toggle, h("span", { class: `badge fs-${file.status}`, text: file.status }), h("span", { class: "diff-counts" }, h("b", { class: "add", text: "+" + file.added }), " ", h("b", { class: "del", text: "−" + file.removed }), lineCountBar(file.added, file.removed)), link("View file", buildHash("blob", { path: file.path }), { class: "btn btn-sm" }));
  sec.append(head, body);
  let built = false;
  const render = (all = false) => {
    built = true;
    clear(body);
    if (!hunks.length) return body.appendChild(h("p", { class: "muted pad", text: file.status === "added" || file.status === "deleted" ? "Empty file." : "No textual changes." }));
    const table = h("table", { class: "diff", aria: { label: `Changes in ${file.path}` } });
    const tb = h("tbody");
    let count = 0;
    let more = 0;
    outer: for (const hunk of hunks) {
      tb.appendChild(h("tr", { class: "hunk" }, h("td", { colSpan: 3 }, h("span", { text: hunk.header.replace(/^(@@[^@]*@@).*$/, "$1") }), hunk.section ? h("span", { class: "hunk-sec", text: " " + hunk.section }) : null)));
      for (const l of hunk.lines) {
        if (!all && count++ >= MAX_ROWS) {
          more = rows - MAX_ROWS;
          break outer;
        }
        if (l.type === "meta") {
          tb.appendChild(h("tr", { class: "meta" }, h("td"), h("td"), h("td", { class: "code", text: l.text })));
          continue;
        }
        const tr = h("tr", { class: "ln " + l.type, data: l.newN ? { line: l.newN } : {} });
        const canComment = opts.onLineComment && l.newN;
        const numNew = h("td", { class: "num new" }, canComment ? h("button", { class: "add-comment", type: "button", aria: { label: `Comment on line ${l.newN}` }, title: "Add a comment", on: { click: () => opts.onLineComment(l.newN, l.text, tr) } }, icon("plus", 12)) : null, l.newN ?? "");
        const cc = codeCell(l.text, lang);
        cc.prepend(h("span", { class: "sign", text: l.type === "add" ? "+" : l.type === "del" ? "\u2212" : " " }));
        tr.append(h("td", { class: "num old", text: l.oldN ?? "" }), numNew, cc);
        tb.appendChild(tr);
        const extra = l.newN ? opts.commentsByLine?.get(l.newN) : null;
        if (extra) for (const node of extra) tb.appendChild(h("tr", { class: "thread-row" }, h("td", { colSpan: 3 }, node)));
      }
    }
    table.appendChild(tb);
    body.appendChild(h("div", { class: "table-scroll" }, table));
    if (more > 0) body.appendChild(h("button", { class: "btn btn-sm show-more", type: "button", on: { click: () => render(true) } }, `Show ${more} more rows`));
  };
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    sec.classList.toggle("collapsed", !open);
    if (open && !built) render();
  };
  sec.classList.toggle("collapsed", startCollapsed);
  if (!startCollapsed) render();
  return sec;
}

/** A file's collapse state helper for callers: expand/collapse all sections inside root. */
export function setAllDiffs(root, open) {
  for (const s of root.querySelectorAll(".diff-file")) {
    const t = s.querySelector(".diff-toggle");
    if ((t.getAttribute("aria-expanded") === "true") !== open) t.click();
  }
}
