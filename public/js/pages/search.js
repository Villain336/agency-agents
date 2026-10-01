// #/search?q=: code search grouped by file, regex / case toggles, click through to blob#L.
import { emptyState, link, pageHeader, unavailable } from "../components.js";
import { add, clear, h, icon } from "../dom.js";
import { buildHash } from "../router.js";
import { plural } from "../time.js";

function snippet(r) {
  const text = r.text ?? "";
  const s = Math.max(0, Math.min(r.matchStart ?? 0, text.length));
  const e = Math.max(s, Math.min(r.matchEnd ?? s, text.length));
  const from = s > 140 ? s - 100 : 0;
  const to = Math.min(text.length, e + 160);
  const span = h("span", { class: "snippet" });
  if (from > 0) span.appendChild(document.createTextNode("…"));
  span.append(document.createTextNode(text.slice(from, s)));
  if (e > s) span.appendChild(h("mark", { text: text.slice(s, e) }));
  span.append(document.createTextNode(text.slice(e, to)));
  if (to < text.length) span.appendChild(document.createTextNode("…"));
  return span;
}

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  const st = { q: route.query.q ?? "", regex: route.query.regex === "1", cs: route.query.cs === "1", path: route.query.path ?? "" };
  ctx.setTitle(st.q ? `Search: ${st.q}` : "Search");
  const go = (patch) => {
    const n = { ...st, ...patch };
    location.hash = buildHash("search", {}, { q: n.q, regex: n.regex ? "1" : "", cs: n.cs ? "1" : "", path: n.path });
  };
  const q = h("input", { type: "search", id: "s-q", value: st.q, placeholder: "Search the code at trunk", autocomplete: "off", spellcheck: false });
  const path = h("input", { type: "text", id: "s-path", value: st.path, placeholder: "path glob, e.g. src/**/*.ts", autocomplete: "off", spellcheck: false });
  const toggle = (key, label, title) => h("label", { class: "toggle", title }, h("input", { type: "checkbox", checked: st[key], on: { change: (e) => go({ [key]: e.target.checked }) } }), h("span", { text: label }));
  const form = h("form", { class: "search-form", role: "search", on: { submit: (e) => { e.preventDefault(); go({ q: q.value.trim(), path: path.value.trim() }); } } },
    h("div", { class: "search-row" }, h("label", { class: "sr-only", htmlFor: "s-q", text: "Query" }), q, h("button", { class: "btn btn-primary", type: "submit" }, icon("search", 14), "Search")),
    h("div", { class: "search-opts" }, toggle("regex", ".* Regex", "Treat the query as a regular expression"), toggle("cs", "Aa Match case", "Case sensitive"), h("label", { class: "inline grow" }, h("span", { class: "sr-only", text: "Path filter" }), path)));
  const out = h("div", { class: "results", aria: { live: "polite" } });
  add(root, [pageHeader("Search"), form, out]);
  if (!st.q) return void out.appendChild(emptyState("Search the code", "Type a query above, or press / anywhere to jump to the search box.", "search"));
  q.focus({ preventScroll: true });
  out.appendChild(h("p", { class: "muted", text: "Searching…" }));
  let res;
  try {
    res = await optional(api("search", { query: { q: st.q, regex: st.regex ? 1 : "", caseSensitive: st.cs ? 1 : "", path: st.path, limit: 300 } }));
  } catch (e) {
    clear(out);
    if (e.status === 400) return void out.appendChild(h("div", { class: "alert alert-error", role: "alert" }, icon("warn"), h("p", { text: e.message })));
    throw e;
  }
  clear(out);
  if (!res) return void out.appendChild(unavailable("Code search"));
  if (!res.results.length) return void out.appendChild(emptyState("No matches", `Nothing at r${res.rev} matches ${st.regex ? "that pattern" : "“" + st.q + "”"}.`, "search"));
  const groups = new Map();
  for (const r of res.results) (groups.get(r.path) ?? groups.set(r.path, []).get(r.path)).push(r);
  out.appendChild(h("p", { class: "muted result-count", text: `${plural(res.total ?? res.results.length, "match", "matches")} in ${plural(groups.size, "file")} at r${res.rev}${res.truncated ? " (truncated: refine the query)" : ""}` }));
  for (const [p, rs] of groups) {
    out.appendChild(h("section", { class: "card flush result-file" },
      h("div", { class: "card-head" }, icon("file", 14), link(p, buildHash("blob", { path: p }), { class: "mono" }), h("span", { class: "dim small", text: plural(rs.length, "match", "matches") })),
      h("ul", { class: "hits" }, rs.map((r) => h("li", {}, h("a", { href: buildHash("blob", { path: p }, {}, "L" + r.line), class: "hit", aria: { label: `${p} line ${r.line}` } }, h("span", { class: "ln", text: String(r.line) }), snippet(r))))),
    ));
  }
}
