// Tiny DOM helpers. Everything is built with createElement/textContent; there is no innerHTML anywhere
// in this app, and no inline handlers (the CSP forbids them), so agent-authored text can only ever be text.
import { safeUrl } from "./markdown.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const BOOL = new Set(["disabled", "checked", "hidden", "required", "readOnly", "selected", "open", "multiple", "autofocus"]);
const PROPS = new Set(["value", "type", "placeholder", "name", "id", "title", "htmlFor", "rows", "min", "max", "tabIndex", "autocomplete", "spellcheck", "href", "src", "target", "rel", "colSpan", "scope", "role", "dateTime", "for", "maxLength", "step", "pattern"]);

/** h("div", {class:"x", on:{click:fn}, aria:{label:"y"}, data:{k:"v"}}, child, "text", [more]) */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "aria") for (const [a, av] of Object.entries(v)) e.setAttribute("aria-" + a, String(av));
    else if (k === "data") for (const [d, dv] of Object.entries(v)) e.dataset[d] = String(dv);
    else if (k === "style") Object.assign(e.style, v); // CSSOM only: inline style attributes are blocked by CSP
    else if (k === "href") {
      const u = safeUrl(String(v));
      if (u) e.setAttribute("href", u);
    } else if (k === "value") e.value = String(v);
    else if (BOOL.has(k)) e[k] = !!v;
    else if (PROPS.has(k)) e.setAttribute(k === "htmlFor" ? "for" : k, String(v));
    else if (/^on/i.test(k)) continue; // never allow inline handler attributes
  }
  add(e, kids);
  return e;
}

export function add(parent, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    parent.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return parent;
}

export const clear = (n) => {
  while (n.firstChild) n.removeChild(n.firstChild);
  return n;
};
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- icons (static path data only) -------------------------------------------------------------
const ICONS = {
  code: "M8 6 2 12l6 6M16 6l6 6-6 6",
  file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  commit: "M3 12h6M15 12h6M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  change: "M6 3v12M18 9v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 6h6a3 3 0 0 1 3 3",
  task: "M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  bell: "M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.6-1.6A4 4 0 0 1 15 7z",
  warn: "M12 3 2 20h20zM12 10v4M12 17v.5",
  check: "M4 12l5 5L20 6",
  x: "M5 5l14 14M19 5 5 19",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.4-2.7a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.2-.8.2-1.2z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  plus: "M12 5v14M5 12h14",
  copy: "M9 9h10v11H9zM5 15V4h10",
  chevron: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  comment: "M4 5h16v11H9l-5 4z",
  repo: "M5 4h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2zM5 17a2 2 0 0 1 2-2h12",
  clip: "M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};
export function icon(name, size = 16, cls = "") {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.setAttribute("class", "icon " + cls);
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.file);
  s.appendChild(p);
  return s;
}

// ---- toasts -------------------------------------------------------------------------------------
export function toast(message, kind = "info", ms) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const t = h("div", { class: "toast toast-" + kind, role: kind === "error" ? "alert" : "status" }, h("span", { text: String(message) }), h("button", { class: "icon-btn", type: "button", aria: { label: "Dismiss" }, on: { click: () => t.remove() } }, icon("x", 14)));
  host.appendChild(t);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(() => t.remove(), ms ?? (kind === "error" ? 9000 : 4000));
}

// ---- dialogs ------------------------------------------------------------------------------------
let dlgSeq = 0;
/** Modal built on <dialog> (focus trap, Esc to close). `build(close)` returns the body node. */
export function openDialog({ title, build, actions = [], wide = false, onClose }) {
  const dlg = h("dialog", { class: "modal" + (wide ? " modal-wide" : ""), aria: { labelledby: `dlg-t-${++dlgSeq}` } });
  const close = (value) => {
    if (dlg.open) dlg.close();
    dlg.remove();
    onClose?.(value);
  };
  const form = h("form", { class: "modal-form", on: { submit: (e) => e.preventDefault() } });
  const foot = h("div", { class: "modal-actions" });
  const body = build(close);
  for (const a of actions) {
    const b = h("button", { type: a.submit ? "submit" : "button", class: "btn " + (a.kind ? "btn-" + a.kind : ""), text: a.label });
    b.addEventListener("click", async (ev) => {
      if (a.submit && !form.reportValidity()) return;
      ev.preventDefault();
      b.disabled = true;
      try {
        const r = await a.onClick?.(close, body);
        if (r !== false) close(a.value);
      } catch (e) {
        toast(e?.message ?? String(e), "error");
      } finally {
        b.disabled = false;
      }
    });
    foot.appendChild(b);
  }
  add(form, [h("div", { class: "modal-head" }, h("h2", { id: `dlg-t-${dlgSeq}`, text: title }), h("button", { type: "button", class: "icon-btn", aria: { label: "Close" }, on: { click: () => close(undefined) } }, icon("x"))), h("div", { class: "modal-body" }, body), foot]);
  dlg.appendChild(form);
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(undefined);
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close(undefined); // backdrop click
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  return { close, dialog: dlg };
}

export const confirmDialog = (title, message, label = "Confirm", kind = "primary") =>
  new Promise((res) => openDialog({ title, build: () => h("p", { text: message }), actions: [{ label: "Cancel", value: false }, { label, kind, value: true, submit: true }], onClose: (v) => res(v === true) }));

/** field("Label", input) -> labelled form row. */
export function field(label, input, hint) {
  const id = input.id || (input.id = "f-" + Math.random().toString(36).slice(2, 8));
  return h("div", { class: "field" }, h("label", { htmlFor: id, text: label }), input, hint ? h("small", { class: "hint", text: hint }) : null);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = h("textarea", { class: "sr-only", value: text });
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    t.remove();
    return ok;
  }
}

/** localStorage that never throws. */
const mem = new Map();
export const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return mem.get(k) ?? null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      mem.set(k, v);
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      mem.delete(k);
    }
  },
};
