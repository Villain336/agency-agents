// #/commits[?path=]: history with "load older" pagination.
import { agentChip, emptyState, link, pageHeader, timeEl } from "../components.js";
import { add, h, icon } from "../dom.js";
import { buildHash } from "../router.js";
import { plural } from "../time.js";

const PAGE = 30;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const dayLabel = (ts) => new Date(ts).toLocaleDateString("en", { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export async function render(ctx) {
  const { root, route, api, optional } = ctx;
  const path = route.query.path ?? "";
  ctx.setTitle(path ? `History of ${path}` : "Commits");
  const list = h("div", { class: "commit-list" });
  const more = h("div", { class: "more" });
  add(root, [
    pageHeader(path ? "History" : "Commits", path ? h("span", { class: "chip" }, icon("file", 12), h("span", { class: "mono", text: path }), link("clear", buildHash("commits"), { class: "chip-x", aria: { label: "Clear path filter" } })) : null),
    list,
    more,
  ]);

  let degraded = false;
  let oldest = null;
  let lastDay = "";
  let group = null;
  async function load(before) {
    let res = await optional(api("history", { query: { path, limit: PAGE, before } }));
    if (!res) {
      degraded = true;
      const all = await api("commits", { query: { limit: 100 } });
      const filtered = path ? all.filter((c) => (c.paths ?? []).some((p) => p === path || p.startsWith(path + "/"))) : all;
      res = { commits: filtered, hasMore: false };
    }
    return res;
  }
  function draw(res) {
    if (!res.commits.length && oldest === null) {
      list.appendChild(emptyState("No commits", path ? `Nothing has touched ${path}.` : "Nothing has landed yet.", "commit"));
      return;
    }
    for (const c of res.commits) {
      const k = dayKey(c.ts);
      if (k !== lastDay) {
        lastDay = k;
        list.appendChild(h("h2", { class: "day", text: dayLabel(c.ts) }));
        group = h("ul", { class: "commits" });
        list.appendChild(group);
      }
      group.appendChild(
        h("li", { class: "commit" },
          h("div", { class: "commit-main" },
            link(c.message || "(no message)", buildHash("commit", { rev: c.rev }), { class: "commit-msg", title: c.message }),
            h("div", { class: "commit-sub" }, agentChip(c.agent), h("span", { class: "dim" }, "landed ", timeEl(c.ts)), c.merged ? h("span", { class: "badge", title: "Weave merged this with concurrent changes", text: "auto-merged" }) : null, c.risk ? h("span", { class: `badge risk-${c.risk}`, text: c.risk + " risk" }) : null, c.paths?.length ? h("span", { class: "dim", text: plural(c.paths.length, "file") }) : null)),
          h("div", { class: "commit-ids" }, link("r" + c.rev, buildHash("commit", { rev: c.rev }), { class: "mono rev" }), c.hash ? h("code", { class: "dim", title: "provenance chain hash", text: c.hash.slice(0, 8) }) : null, link("browse", buildHash("home", {}, { rev: c.rev }), { class: "dim small", title: "Browse the tree at this revision" }))),
      );
      oldest = c.rev;
    }
    more.replaceChildren();
    if (res.hasMore) {
      const b = h("button", { class: "btn", type: "button", text: "Load older commits", on: { click: async () => { b.disabled = true; try { draw(await load(oldest)); } catch (e) { b.disabled = false; throw e; } } } });
      more.appendChild(b);
    } else if (res.commits.length) more.appendChild(h("p", { class: "muted center-text", text: degraded ? "Showing the most recent commits (this server has no paged history API)." : "That is the whole history." }));
  }
  draw(await load());
}
