// #/packages: the package registry list.
import { emptyState, link, pageHeader, timeEl, unavailable } from "../components.js";
import { add, h, icon } from "../dom.js";
import { buildHash } from "../router.js";
import { plural } from "../time.js";

export async function render(ctx) {
  const { root, api, optional } = ctx;
  ctx.setTitle("Packages");
  const list = await optional(api("packages"));
  if (list === null) return void add(root, [pageHeader("Packages"), unavailable("Packages")]);
  add(root, [pageHeader("Packages")]);
  if (!list.length) return void root.appendChild(emptyState("No packages published", "Publish immutable semver versions with POST /api/packages: name, version and files. Each file is stored with its sha256.", "box"));
  root.appendChild(h("section", { class: "card flush" }, h("div", { class: "table-scroll" }, h("table", { class: "list-table", aria: { label: "Packages" } },
    h("thead", {}, h("tr", {}, ["Package", "Latest", "Versions", "Updated"].map((c, i) => h("th", { scope: "col", class: i === 2 ? "hide-sm" : "", text: c })))),
    h("tbody", {}, list.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => h("tr", {},
      h("td", {}, h("div", { class: "pkg-name" }, icon("box", 14), link(p.name, buildHash("package", { name: p.name }), { class: "row-link mono break" })), p.description ? h("div", { class: "dim small", text: p.description }) : null),
      h("td", {}, p.latest ? h("span", { class: "badge mono", text: p.latest }) : h("span", { class: "badge risk-medium", text: "all yanked" })),
      h("td", { class: "dim hide-sm", text: plural(p.versions?.length ?? 0, "version") }),
      h("td", { class: "dim" }, timeEl(p.updatedAt)))))))));
}
