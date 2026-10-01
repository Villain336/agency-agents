// #/run/<id>: one workflow run with its output. Polls while the run is queued or running.
import { agentChip, errorBox, link, pageHeader, timeEl } from "../components.js";
import { triggerText } from "../forge.js";
import { add, clear, h } from "../dom.js";
import { buildHash } from "../router.js";
import { fmtDuration, fullTime } from "../time.js";
import { runPill } from "./runs.js";

export async function render(ctx) {
  const { root, api, route } = ctx;
  const id = route.params.id;
  ctx.setTitle("Run " + id);
  let run = await api("runs/" + encodeURIComponent(id));
  const host = h("div", {});
  root.appendChild(host);
  draw();

  function draw() {
    clear(host);
    const live = run.status === "queued" || run.status === "running";
    const out = run.output ?? "";
    add(host, [
      h("nav", { class: "crumbs", aria: { label: "Breadcrumb" } }, link("Runs", buildHash("runs"), { class: "crumb" }), h("span", { class: "sep", text: "/" }), h("span", { class: "crumb current mono", text: run.id })),
      pageHeader(run.workflow, runPill(run.status)),
      h("section", { class: "card" }, h("dl", { class: "kv" },
        h("dt", { text: "Trigger" }), h("dd", { text: triggerText(run) }),
        h("dt", { text: "Revision" }), h("dd", {}, link("r" + run.rev, buildHash("commit", { rev: run.rev }), { class: "mono" })),
        h("dt", { text: "Started by" }), h("dd", {}, agentChip(run.by)),
        h("dt", { text: "Created" }), h("dd", {}, timeEl(run.createdAt), h("span", { class: "dim small", text: " " + fullTime(run.createdAt) })),
        run.claimedBy ? [h("dt", { text: "Runner" }), h("dd", { text: run.claimedBy })] : null,
        run.durationMs !== undefined ? [h("dt", { text: "Duration" }), h("dd", { text: fmtDuration(run.durationMs) })] : null,
        h("dt", { text: "Command" }), h("dd", {}, h("code", { class: "mono break", text: run.command })),
        run.secrets?.length ? [h("dt", { text: "Secrets" }), h("dd", {}, run.secrets.map((s) => h("span", { class: "label", text: s })), h("span", { class: "dim small", text: " delivered as environment variables, values never shown" }))] : null)),
      h("section", { class: "card flush" },
        h("h2", { class: "card-title pad-title", text: "Output" }),
        out ? h("pre", { class: "run-output mono", tabindex: 0, aria: { label: "Run output" }, text: out }) : h("p", { class: "muted pad", text: live ? (run.status === "queued" ? "Waiting for a runner to claim this run." : "Running. Output appears when the run finishes.") : "This run produced no output." })),
    ]);
  }

  if (run.status === "queued" || run.status === "running") {
    const t = setInterval(async () => {
      try {
        run = await api("runs/" + encodeURIComponent(id));
        draw();
        if (run.status !== "queued" && run.status !== "running") clearInterval(t);
      } catch (e) {
        clearInterval(t);
        if (e.name !== "AbortError") host.prepend(errorBox(e));
      }
    }, 4000);
    ctx.onCleanup(() => clearInterval(t));
  }
}
