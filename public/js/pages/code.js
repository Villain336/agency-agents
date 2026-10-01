// #/ and #/tree/<path>: directory listing, last-commit info, README, repo stats.
import { session } from "../api.js";
import { agentChip, breadcrumb, copyButton, emptyState, link, md, timeEl } from "../components.js";
import { add, h, icon } from "../dom.js";
import { buildHash } from "../router.js";
import { fmtBytes, plural } from "../time.js";

/** Fallback when /api/tree is missing: build a listing from the flat trunk file list. */
function treeFromFiles(files, path) {
  const prefix = path ? path + "/" : "";
  const dirs = new Set();
  const out = [];
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const i = rest.indexOf("/");
    if (i < 0) out.push({ name: rest, path: f, type: "file" });
    else dirs.add(rest.slice(0, i));
  }
  const d = [...dirs].sort().map((n) => ({ name: n, path: prefix + n, type: "dir" }));
  return [...d, ...out.sort((a, b) => a.name.localeCompare(b.name))];
}

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  const path = route.params.path ?? "";
  const rev = route.query.rev;
  ctx.setTitle(path ? path : "Code");

  let tree = await optional(api("tree", { query: { path, rev } }));
  let degraded = false;
  if (!tree) {
    const t = await api("trunk/files", { query: { rev } });
    tree = { rev: t.rev, path, entries: treeFromFiles(t.files, path) };
    degraded = true;
  }
  const entries = tree.entries ?? [];
  const latest = entries.filter((e) => e.lastRev).sort((a, b) => b.lastRev - a.lastRev)[0];

  const main = h("div", { class: "col-main" });
  const side = h("aside", { class: "col-side", aria: { label: "Repository details" } });
  add(root, [
    h("div", { class: "page-head" }, breadcrumb(path, rev), h("div", { class: "page-actions" }, link("History", buildHash("commits", {}, { path }), { class: "btn btn-sm" }, ), rev ? h("span", { class: "badge", text: "viewing r" + rev }) : h("span", { class: "badge", title: "trunk revision", text: "r" + tree.rev }))),
    h("div", { class: "cols" }, main, side),
  ]);
  if (degraded) main.appendChild(h("p", { class: "note", text: "The browse API is not available on this server, so last-commit details are hidden. Showing the file list only." }));

  if (!entries.length) {
    main.appendChild(emptyState(path ? "This directory is empty" : "This repository has no files yet", path ? undefined : "Agents land changes through sessions; the first landed change will show up here.", "folder"));
  } else {
    const table = h("table", { class: "files", aria: { label: path ? `Files in ${path}` : "Files in the repository root" } });
    table.appendChild(h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Name" }), h("th", { scope: "col", class: "hide-sm", text: "Last commit" }), h("th", { scope: "col", class: "hide-md", text: "Agent" }), h("th", { scope: "col", class: "right", text: "Updated" }))));
    const tb = h("tbody");
    if (path) {
      const up = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      tb.appendChild(h("tr", {}, h("td", { colSpan: 4 }, link("..", buildHash("tree", { path: up }, rev ? { rev } : {}), { class: "fname", aria: { label: "Parent directory" } }))));
    }
    for (const e of entries) {
      const hash = e.type === "dir" ? buildHash("tree", { path: e.path }, rev ? { rev } : {}) : buildHash("blob", { path: e.path }, rev ? { rev } : {});
      tb.appendChild(
        h("tr", {},
          h("td", { class: "name" }, h("span", { class: "fname-wrap" }, icon(e.type === "dir" ? "folder" : "file", 16, e.type === "dir" ? "ic-dir" : "ic-file"), link(e.name, hash, { class: "fname", title: e.path }))),
          h("td", { class: "msg hide-sm" }, e.lastMessage ? link(e.lastMessage, buildHash("commit", { rev: e.lastRev }), { class: "dim", title: e.lastMessage }) : ""),
          h("td", { class: "hide-md" }, e.lastAgent ? agentChip(e.lastAgent) : ""),
          h("td", { class: "right dim nowrap" }, e.lastTs ? timeEl(e.lastTs) : "", e.size !== undefined && e.type === "file" ? h("span", { class: "size hide-md", text: " · " + fmtBytes(e.size) }) : null),
        ),
      );
    }
    table.appendChild(tb);
    const card = h("div", { class: "card flush" });
    if (latest) {
      card.appendChild(h("div", { class: "latest" }, agentChip(latest.lastAgent), link(latest.lastMessage, buildHash("commit", { rev: latest.lastRev }), { class: "latest-msg", title: latest.lastMessage }), h("span", { class: "dim nowrap" }, link("r" + latest.lastRev, buildHash("commit", { rev: latest.lastRev }), { class: "mono" }), " · ", timeEl(latest.lastTs))));
    }
    card.appendChild(h("div", { class: "table-scroll" }, table));
    main.appendChild(card);
  }

  // README: root uses /api/readme, subdirectories look for a README entry
  (async () => {
    try {
      let readme = null;
      if (!path) readme = await optional(api("readme", { query: { rev } }));
      if (!readme || !readme.path) {
        const e = entries.find((x) => x.type === "file" && /^readme(\.md|\.markdown)?$/i.test(x.name));
        if (e) {
          const b = await optional(api("blob", { query: { path: e.path, rev } })) ?? (await api("trunk/file", { query: { path: e.path, rev } }));
          readme = { path: e.path, content: b.content };
        }
      }
      if (readme?.path && typeof readme.content === "string") {
        main.appendChild(h("article", { class: "card readme", aria: { label: "README" } }, h("div", { class: "card-head" }, icon("file", 14), link(readme.path.split("/").pop(), buildHash("blob", { path: readme.path }))), h("div", { class: "card-body" }, md(readme.content))));
      }
    } catch (e) {
      if (e?.name !== "AbortError") main.appendChild(h("p", { class: "muted", text: "Could not load the README: " + e.message }));
    }
  })();

  // Sidebar: clone + stats (both optional)
  const cloneUrl = `${location.origin}/git/${encodeURIComponent(session.repo)}`;
  side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Clone" }), h("code", { class: "clone", text: `git clone ${cloneUrl}` }), copyButton(`git clone ${cloneUrl}`, "Copy")));
  (async () => {
    try {
      const st = await optional(api("stats"));
      if (!st) return;
      const langs = Object.entries(st.languages ?? {}).sort((a, b) => b[1] - a[1]);
      const total = langs.reduce((n, [, c]) => n + c, 0) || 1;
      const bar = h("div", { class: "langbar", role: "img", aria: { label: "Languages: " + langs.map(([l, c]) => `${l} ${c}`).join(", ") } });
      langs.forEach(([l, c], i) => bar.appendChild(h("i", { class: "lang-" + (i % 6), style: { width: (c / total) * 100 + "%" }, title: l })));
      side.appendChild(
        h("section", { class: "card" }, h("h2", { class: "card-title", text: "About" }),
          h("dl", { class: "kv" }, h("dt", { text: "Files" }), h("dd", { text: String(st.files) }), h("dt", { text: "Lines" }), h("dd", { text: Number(st.loc).toLocaleString("en") }), h("dt", { text: "Commits" }), h("dd", { text: String(st.commits) }), st.sessions ? [h("dt", { text: "Changes" }), h("dd", { text: `${st.sessions.live} live, ${st.sessions.landed} landed` })] : null),
          langs.length ? [bar, h("ul", { class: "legend" }, langs.slice(0, 6).map(([l, c], i) => h("li", {}, h("i", { class: "lang-" + i }), ` ${l} `, h("span", { class: "dim", text: String(c) }))))] : null),
      );
      if (st.contributors?.length)
        side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: plural(st.contributors.length, "contributor") }), h("ul", { class: "plain contrib" }, st.contributors.slice(0, 8).map((c) => h("li", {}, agentChip(c.agent), h("span", { class: "dim", text: plural(c.commits, "commit") }))))));
    } catch {
      /* stats are decoration */
    }
  })();
}
