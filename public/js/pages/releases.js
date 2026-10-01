// #/releases: tags and releases.
import { post } from "../api.js";
import { agentChip, emptyState, link, md, pageHeader, timeEl, unavailable } from "../components.js";
import { add, field, h, icon, openDialog, toast } from "../dom.js";
import { buildHash } from "../router.js";

export async function render(ctx) {
  const { root, api, optional } = ctx;
  ctx.setTitle("Releases");
  const [tags, releases] = await Promise.all([optional(api("tags")), optional(api("releases"))]);
  if (tags === null && releases === null) return void add(root, [pageHeader("Releases"), unavailable("Tags and releases")]);

  const newRelease = () => {
    const tag = h("input", { type: "text", id: "rl-tag", required: true, placeholder: "v1.0.0", list: undefined });
    const title = h("input", { type: "text", id: "rl-title", required: true, placeholder: "Release title" });
    const notes = h("textarea", { rows: 8, id: "rl-notes", placeholder: "Release notes (Markdown)" });
    const draft = h("input", { type: "checkbox", id: "rl-draft" });
    const pre = h("input", { type: "checkbox", id: "rl-pre" });
    openDialog({ title: "New release", wide: true, build: () => h("div", { class: "stack" }, field("Tag", tag, "An existing tag, or a new name: it is created at trunk head."), field("Title", title), field("Notes", notes), h("div", { class: "check-row" }, draft, h("label", { htmlFor: "rl-draft", text: "Draft" })), h("div", { class: "check-row" }, pre, h("label", { htmlFor: "rl-pre", text: "Pre-release" }))),
      actions: [{ label: "Cancel" }, { label: "Publish release", kind: "primary", submit: true, onClick: async () => {
        const name = tag.value.trim();
        if (!(tags ?? []).some((t) => t.name === name)) await post("tags", { name, message: title.value });
        await post("releases", { tag: name, title: title.value, notes: notes.value, draft: draft.checked, prerelease: pre.checked });
        toast("Release created", "ok");
        ctx.refresh();
      } }] });
  };
  const newTag = () => {
    const name = h("input", { type: "text", id: "tg-name", required: true, placeholder: "v1.0.0" });
    const rev = h("input", { type: "number", id: "tg-rev", min: 1, placeholder: "head" });
    const msg = h("input", { type: "text", id: "tg-msg", placeholder: "Optional message" });
    openDialog({ title: "New tag", build: () => h("div", { class: "stack" }, field("Name", name, "Tags are immutable once created."), field("Revision", rev, "Leave empty for the current trunk head."), field("Message", msg)),
      actions: [{ label: "Cancel" }, { label: "Create tag", kind: "primary", submit: true, onClick: async () => { await post("tags", { name: name.value.trim(), rev: rev.value ? Number(rev.value) : undefined, message: msg.value || undefined }); toast("Tag created", "ok"); ctx.refresh(); } }] });
  };
  add(root, [pageHeader("Releases", tags ? h("button", { class: "btn", type: "button", on: { click: newTag } }, icon("tag", 14), "New tag") : null, releases ? h("button", { class: "btn btn-primary", type: "button", on: { click: newRelease } }, icon("plus", 14), "New release") : null)]);

  const cols = h("div", { class: "cols" });
  const main = h("div", { class: "col-main" });
  const side = h("aside", { class: "col-side" });
  cols.append(main, side);
  root.appendChild(cols);

  if (releases === null) main.appendChild(unavailable("Releases"));
  else if (!releases.length) main.appendChild(emptyState("No releases yet", "Tag a trunk revision and publish notes for it.", "tag"));
  else
    for (const r of releases.slice().sort((a, b) => b.ts - a.ts)) {
      const tg = (tags ?? []).find((t) => t.name === r.tag);
      main.appendChild(h("article", { class: "card release" },
        h("div", { class: "release-head" }, h("h2", { text: r.title || r.tag }), r.draft ? h("span", { class: "badge", text: "draft" }) : null, r.prerelease ? h("span", { class: "badge risk-medium", text: "pre-release" }) : null),
        h("div", { class: "change-meta" }, h("span", { class: "badge mono" }, icon("tag", 12), " " + r.tag), tg ? link("r" + tg.rev, buildHash("commit", { rev: tg.rev }), { class: "mono badge" }) : null, agentChip(r.author), timeEl(r.ts)),
        r.notes ? h("div", { class: "card-body" }, md(r.notes)) : null,
        tg ? h("div", { class: "small" }, link("Browse files at this tag", buildHash("home", {}, { rev: tg.rev })), " · ", link("Commit", buildHash("commit", { rev: tg.rev }))) : null));
    }

  if (tags === null) side.appendChild(unavailable("Tags"));
  else
    side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Tags" }), tags.length ? h("ul", { class: "plain taglist" }, tags.slice().sort((a, b) => b.ts - a.ts).map((t) => h("li", {}, h("div", {}, h("span", { class: "mono", text: t.name }), " ", link("r" + t.rev, buildHash("commit", { rev: t.rev }), { class: "mono dim" })), h("div", { class: "dim small" }, t.message ? t.message + " · " : "", t.tagger, " ", timeEl(t.ts))))) : h("p", { class: "muted", text: "No tags." })));
}
