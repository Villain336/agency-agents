// #/activity: audit event feed with live long-poll (/api/events?after=&wait=20).
import { agentChip, emptyState, link, pageHeader, timeEl } from "../components.js";
import { add, h, icon } from "../dom.js";
import { buildHash } from "../router.js";

const GOOD = new Set(["landed", "check_passed", "approved", "verified", "noop"]);
const BAD = new Set(["conflict", "rejected", "check_failed", "checks_failed", "verify_failed", "mirror_failed", "abandoned"]);
const WAIT = new Set(["review_requested", "needs_verify", "verifying", "job_queued", "blocked", "overlap"]);
const tone = (t) => (GOOD.has(t) ? "good" : BAD.has(t) ? "bad" : WAIT.has(t) ? "wait" : "info");

export async function render(ctx) {
  const { root, api, signal } = ctx;
  ctx.setTitle("Activity");
  const first = await api("events", { query: { after: 0 } });
  let events = (first.events ?? []).slice().reverse();
  let after = first.last ?? 0;
  let live = true;
  let filter = "";
  const status = h("span", { class: "live-state", role: "status", text: "Live" });
  const pauseBtn = h("button", { class: "btn btn-sm", type: "button", aria: { pressed: "false" }, on: { click: () => { live = !live; pauseBtn.setAttribute("aria-pressed", String(!live)); pauseBtn.textContent = live ? "Pause" : "Resume"; status.textContent = live ? "Live" : "Paused"; status.classList.toggle("paused", !live); if (live) poll(); } }, text: "Pause" });
  const select = h("select", { id: "ev-type", aria: { label: "Filter by event type" }, on: { change: (e) => ((filter = e.target.value), draw()) } });
  const list = h("ol", { class: "feed", aria: { label: "Events, newest first" } });
  add(root, [pageHeader("Activity", h("span", { class: "live-wrap" }, h("span", { class: "live-dot", aria: { hidden: "true" } }), status), select, pauseBtn), list]);

  const row = (e, fresh) =>
    h("li", { class: `ev tone-${tone(e.type)}${fresh ? " fresh" : ""}` },
      h("span", { class: "ev-dot", aria: { hidden: "true" } }),
      h("div", { class: "ev-main" },
        h("div", { class: "ev-line" }, h("span", { class: "ev-type", text: e.type.replace(/_/g, " ") }), e.agent ? agentChip(e.agent) : null, e.by && e.by !== e.agent ? h("span", { class: "dim small", text: "by " + e.by }) : null),
        h("div", { class: "ev-msg", text: e.message }),
        e.session ? h("div", { class: "small" }, link(e.session, buildHash("change", { id: e.session }), { class: "mono" })) : null),
      h("span", { class: "ev-time dim nowrap" }, timeEl(e.ts)));
  function draw() {
    const types = [...new Set(events.map((e) => e.type))].sort();
    select.replaceChildren(h("option", { value: "", text: "All events" }), ...types.map((t) => h("option", { value: t, text: t.replace(/_/g, " "), selected: t === filter })));
    list.replaceChildren();
    const shown = events.filter((e) => !filter || e.type === filter).slice(0, 300);
    if (!shown.length) return void list.appendChild(h("li", {}, emptyState("No events yet", "Activity appears here as agents open sessions, run checks and land changes.", "pulse")));
    for (const e of shown) list.appendChild(row(e, false));
  }
  draw();

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    let fails = 0;
    while (live && !signal.aborted) {
      try {
        const r = await api("events", { query: { after, wait: 20 } });
        fails = 0;
        status.textContent = "Live";
        status.classList.remove("paused");
        after = r.last ?? after;
        if (r.events?.length && live) {
          events = [...r.events.slice().reverse(), ...events].slice(0, 500);
          const types = new Set(select.options.length ? [...select.options].map((o) => o.value) : []);
          if (r.events.some((e) => !types.has(e.type))) draw();
          else for (const e of r.events) if (!filter || e.type === filter) list.prepend(row(e, true));
          list.querySelector(".empty")?.closest("li")?.remove();
        }
      } catch (e) {
        if (e?.name === "AbortError") break;
        status.textContent = "Reconnecting…";
        status.classList.add("paused");
        if (++fails > 6) { status.textContent = "Disconnected"; break; }
        await new Promise((res) => setTimeout(res, Math.min(10000, 1000 * fails)));
      }
    }
    polling = false;
  }
  poll();
}
