// #/package/<name>[?v=<version>]: versions, files with sizes and sha256, yanked state, install snippet.
import { post } from "../api.js";
import { agentChip, copyButton, link, pageHeader, timeEl } from "../components.js";
import { packageSnippets, pickVersion, shortSha, totalBytes } from "../forge.js";
import { add, clear, confirmDialog, field, h, icon, openDialog, toast } from "../dom.js";
import { buildHash } from "../router.js";
import { fmtBytes, plural } from "../time.js";
import { session } from "../api.js";

export async function render(ctx) {
  const { root, api, route } = ctx;
  const name = route.params.name;
  ctx.setTitle(name);
  const pkg = await api("packages/" + encodeURIComponent(name));
  const releases = (pkg.releases ?? []).slice();
  const cur = pickVersion(releases, route.query.v, pkg.latest);

  add(root, [
    h("nav", { class: "crumbs", aria: { label: "Breadcrumb" } }, link("Packages", buildHash("packages"), { class: "crumb" }), h("span", { class: "sep", text: "/" }), h("span", { class: "crumb current mono", text: name })),
    pageHeader(name, pkg.latest ? h("span", { class: "badge mono", text: "latest " + pkg.latest }) : h("span", { class: "badge risk-medium", text: "all versions yanked" })),
  ]);
  if (pkg.description) root.appendChild(h("p", { class: "muted", text: pkg.description }));
  if (!cur) return void root.appendChild(h("p", { class: "muted", text: "This package has no versions." }));

  const cols = h("div", { class: "cols" });
  const main = h("div", { class: "col-main stack" });
  const side = h("aside", { class: "col-side" });
  cols.append(main, side);
  root.appendChild(cols);

  // ---- selected version
  const head = h("section", { class: "card" },
    h("div", { class: "release-head" }, h("h2", { class: "mono", text: `${name}@${cur.version}` }), cur.yanked ? h("span", { class: "badge risk-high", text: "yanked" }) : h("span", { class: "badge ok", text: "available" })),
    h("div", { class: "change-meta" }, agentChip(cur.publishedBy), h("span", { class: "dim" }, "published ", timeEl(cur.publishedAt)), h("span", { class: "dim", text: `${plural(cur.files.length, "file")}, ${fmtBytes(totalBytes(cur.files))}` })));
  if (cur.yanked) head.appendChild(h("div", { class: "alert alert-warn yank-note" }, icon("warn"), h("div", {}, h("strong", { text: "This version was yanked." }), h("p", { text: "Reason: " + cur.yanked + ". The files are still downloadable by exact version, but resolvers should skip it." }))));
  if (!cur.yanked) head.appendChild(h("div", { class: "composer-actions" }, h("button", { class: "btn btn-sm btn-danger", type: "button", text: "Yank this version", on: { click: () => yank(cur) } })));
  main.appendChild(head);

  // ---- files
  main.appendChild(h("section", { class: "card flush", aria: { label: "Files" } }, h("h2", { class: "card-title pad-title", text: "Files" }),
    h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: "Package files" } },
      h("thead", {}, h("tr", {}, ["File", "Size", "sha256"].map((c) => h("th", { scope: "col", text: c })))),
      h("tbody", {}, cur.files.map((f) => h("tr", {},
        h("td", { class: "mono break", text: f.name }),
        h("td", { class: "dim nowrap", text: fmtBytes(f.size) }),
        h("td", {}, h("code", { class: "mono small hash", title: f.sha256, text: shortSha(f.sha256) + "…" }), " ", copyButton(f.sha256, "Copy")))))))));

  // ---- install
  const first = cur.files[0];
  const snip = first ? packageSnippets({ origin: location.origin, name, version: cur.version, file: first.name, repo: session.repo }) : null;
  const sel = h("select", { id: "snip-file", aria: { label: "File to fetch" } }, cur.files.map((f) => h("option", { value: f.name, text: f.name })));
  const pre = h("pre", { class: "snippet mono", tabindex: 0, text: snip?.curl ?? "" });
  const copy = h("span", {});
  const setSnip = () => {
    const s = packageSnippets({ origin: location.origin, name, version: cur.version, file: sel.value, repo: session.repo });
    pre.textContent = s.curl;
    clear(copy).appendChild(copyButton(s.curl, "Copy snippet"));
  };
  sel.addEventListener("change", setSnip);
  if (snip) {
    setSnip();
    main.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Install" }),
      h("p", { class: "muted small", text: "Files are served base64-encoded over the API. Set WEAVE_TOKEN to a token with read access." }),
      h("div", { class: "snippet-bar" }, h("label", { class: "sr-only", htmlFor: "snip-file", text: "File to fetch" }), sel, copy), pre));
  }

  // ---- versions
  side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Versions" }),
    h("ul", { class: "plain verlist" }, releases.slice().reverse().map((r) => h("li", { class: r.version === cur.version ? "current" : "" },
      h("a", { href: buildHash("package", { name }, { v: r.version }), class: "mono", text: r.version }),
      r.version === pkg.latest ? h("span", { class: "badge ok", text: "latest" }) : null,
      r.yanked ? h("span", { class: "badge risk-high", title: r.yanked, text: "yanked" }) : null,
      h("div", { class: "dim small" }, timeEl(r.publishedAt)))))));

  function yank(v) {
    const reason = h("input", { type: "text", id: "yank-reason", required: true, placeholder: "e.g. contains a leaked credential" });
    openDialog({ title: `Yank ${v.version}`, build: () => h("div", { class: "stack" }, h("p", {}, "Yanking marks the version as not to be used. It is never deleted, and the files and hashes stay as published."), field("Reason", reason)),
      actions: [{ label: "Cancel" }, { label: "Yank version", kind: "danger", submit: true, onClick: async () => {
        await post(`packages/${encodeURIComponent(name)}/${encodeURIComponent(v.version)}/yank`, { reason: reason.value.trim() || "yanked" });
        toast(`${v.version} yanked`, "ok");
        ctx.refresh();
      } }] });
  }
}
