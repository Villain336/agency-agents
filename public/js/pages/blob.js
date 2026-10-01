// #/blob/<path>[?rev=][#L12]: file viewer with line numbers, syntax highlighting, blame, permalink.
import { agentChip, breadcrumb, emptyState, link, md } from "../components.js";
import { add, clear, copyText, h, icon, toast } from "../dom.js";
import { highlight, langOf } from "../highlight.js";
import { buildHash, parseLineFrag } from "../router.js";
import { fmtBytes, plural, relTime } from "../time.js";

const CAP = 4000;

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  const path = route.params.path;
  const rev = route.query.rev;
  ctx.setTitle(path.split("/").pop());
  if (!path) return void root.appendChild(emptyState("No file selected", "Pick a file from the code tab.", "file"));

  let blob = await optional(api("blob", { query: { path, rev } }));
  if (!blob) {
    const t = await api("trunk/file", { query: { path, rev } });
    blob = { path, rev: t.rev, content: t.content, size: (t.content ?? "").length, language: "text", lines: (t.content ?? "").split("\n").length };
  }
  if (blob.content === null || blob.content === undefined) {
    add(root, [h("div", { class: "page-head" }, breadcrumb(path, rev)), emptyState("File not found", `${path} does not exist at r${blob.rev ?? rev ?? "head"}.`, "file")]);
    return;
  }
  const text = String(blob.content);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const lang = langOf(path, blob.language);
  const isMd = lang === "md";
  let view = isMd && !route.frag ? "preview" : "code";
  let blameOn = false;
  let blame = null;
  let shown = Math.min(lines.length, CAP);

  const body = h("div", { class: "card flush blob" });
  const blameBtn = h("button", { class: "btn btn-sm", type: "button", aria: { pressed: "false" }, on: { click: toggleBlame } }, icon("user", 14), "Blame");
  const previewBtn = isMd ? h("button", { class: "btn btn-sm", type: "button", aria: { pressed: String(view === "preview") }, on: { click: () => ((view = view === "preview" ? "code" : "preview"), previewBtn.setAttribute("aria-pressed", String(view === "preview")), draw()) } }, icon("eye", 14), "Preview") : null;
  const permalink = buildHash("blob", { path }, { rev: blob.rev });
  const fullPermalink = () => location.origin + location.pathname + permalink + (location.hash.includes("#L") ? location.hash.slice(location.hash.indexOf("#L")) : "");
  add(root, [
    h("div", { class: "page-head" }, breadcrumb(path, rev), h("div", { class: "page-actions" }, previewBtn, blameBtn, link("History", buildHash("commits", {}, { path }), { class: "btn btn-sm" }), h("button", { class: "btn btn-sm", type: "button", title: "Copy a link pinned to this revision", on: { click: async () => toast((await copyText(fullPermalink())) ? `Permalink to r${blob.rev} copied` : "Copy failed", "info", 2000) } }, icon("clip", 14), "Permalink"))),
    h("div", { class: "file-meta" }, h("span", { class: "badge", text: "r" + blob.rev }), h("span", { text: plural(blob.lines ?? lines.length, "line") }), h("span", { class: "dim", text: "·" }), h("span", { text: fmtBytes(blob.size ?? text.length) }), h("span", { class: "dim", text: "·" }), h("span", { class: "mono", text: lang }), !rev && blob.rev ? link("pinned link", permalink, { class: "dim small" }) : null),
    body,
  ]);

  let sel = parseLineFrag(route.frag);
  let lastClicked = sel?.from ?? null;
  const rows = new Map();

  function markSel() {
    for (const [n, tr] of rows) tr.classList.toggle("sel", !!sel && n >= sel.from && n <= sel.to);
  }
  function pick(n, shift) {
    if (shift && lastClicked) sel = { from: Math.min(lastClicked, n), to: Math.max(lastClicked, n) };
    else sel = { from: n, to: n };
    lastClicked = n;
    const frag = sel.from === sel.to ? `L${sel.from}` : `L${sel.from}-L${sel.to}`;
    history.replaceState(null, "", location.pathname + location.search + buildHash("blob", { path }, rev ? { rev } : {}, frag));
    markSel();
    copyText(location.href).then((ok) => toast(ok ? `Link to ${frag} copied` : `Anchored at ${frag}`, "info", 1800));
  }
  ctx.onFrag((f) => {
    sel = parseLineFrag(f);
    markSel();
    if (sel) rows.get(sel.from)?.scrollIntoView({ block: "center" });
  });

  function draw() {
    clear(body);
    rows.clear();
    if (view === "preview") return body.appendChild(h("div", { class: "card-body" }, md(text)));
    const hl = highlight(text.endsWith("\n") ? text.slice(0, -1) : text, lang);
    const table = h("table", { class: "code-table" + (blameOn ? " with-blame" : ""), aria: { label: `Source of ${path}` } });
    const tb = h("tbody");
    let prevRev = null;
    for (let i = 0; i < shown; i++) {
      const n = i + 1;
      const tr = h("tr", { id: "L" + n, class: "cl" });
      if (blameOn) {
        const b = blame?.[i];
        const first = b && b.rev !== prevRev;
        prevRev = b?.rev ?? null;
        tr.classList.toggle("bl-start", !!first);
        tr.classList.add("bg-" + ((b?.rev ?? 0) % 2));
        tr.appendChild(h("td", { class: "blame" }, first ? [agentChip(b.agent, 16), link("r" + b.rev, buildHash("commit", { rev: b.rev }), { class: "mono", title: `${b.message ?? ""}\n${b.agent} · ${relTime(b.ts)}` })] : null));
      }
      const code = h("td", { class: "code" });
      for (const t of hl[i] ?? []) code.appendChild(t.c ? h("span", { class: "tk-" + t.c, text: t.t }) : document.createTextNode(t.t));
      if (!hl[i]?.length) code.textContent = "​";
      tr.append(h("td", { class: "num" }, h("button", { type: "button", class: "lnk", aria: { label: `Line ${n}, copy link` }, text: String(n), on: { click: (e) => pick(n, e.shiftKey) } })), code);
      rows.set(n, tr);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    body.appendChild(h("div", { class: "table-scroll" }, table));
    if (shown < lines.length) body.appendChild(h("button", { class: "btn show-more", type: "button", on: { click: () => ((shown = lines.length), draw()) } }, `Show all ${lines.length} lines`));
    markSel();
  }

  async function toggleBlame() {
    if (!blameOn && !blame) {
      blameBtn.disabled = true;
      try {
        const b = await optional(api("blame", { query: { path, rev: blob.rev } }));
        if (!b) {
          toast("Blame is not available on this server.", "error");
          return;
        }
        blame = b.lines;
      } catch (e) {
        if (e?.name !== "AbortError") toast(e.message, "error");
        return;
      } finally {
        blameBtn.disabled = false;
      }
    }
    blameOn = !blameOn;
    blameBtn.setAttribute("aria-pressed", String(blameOn));
    if (view === "preview") {
      view = "code";
      previewBtn?.setAttribute("aria-pressed", "false");
    }
    draw();
  }

  draw();
  if (sel && view === "code") requestAnimationFrame(() => rows.get(sel.from)?.scrollIntoView({ block: "center" }));
}
