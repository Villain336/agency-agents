// #/change/<sessionId>: the review page. Goal, risk, warnings, diff with inline threads, evidence,
// approvals, actions and the session's event timeline.
import { api as rawApi, isAbort, optional as opt, post, session as auth } from "../api.js";
import { agentChip, diffFile, emptyState, errorBox, link, md, riskBadge, setAllDiffs, statusPill, timeEl } from "../components.js";
import { add, clear, field, h, icon, openDialog, toast } from "../dom.js";
import { buildHash } from "../router.js";
import { plural } from "../time.js";
import { evidenceList } from "./commit.js";

const LIVE = ["active", "conflicted", "needs_verify", "verifying", "in_review"];
const me = () => auth.name || undefined;

export async function render(ctx) {
  const { root, route, signal } = ctx;
  const id = route.params.id;
  const enc = id.split("/").map(encodeURIComponent).join("/");
  const api = (p, o) => rawApi(p, { signal, ...o });
  ctx.setTitle("Change");
  let S = null; // loaded state
  let who = null;
  const collapsed = new Map();

  async function load() {
    const [session, pack, comments, evs, queue, w] = await Promise.all([
      api(`sessions/${enc}`),
      opt(api(`sessions/${enc}/review-pack`)).catch((e) => (isAbort(e) ? Promise.reject(e) : { __error: e })),
      opt(api(`sessions/${enc}/comments`)).catch(() => null),
      opt(api("events", { query: { after: 0 } })).catch(() => null),
      opt(api("review/queue")).catch(() => null),
      opt(api("whoami")).catch(() => null),
    ]);
    who = w;
    const pk = pack && !pack.__error ? pack : null;
    S = { s: session, pack: pk, packError: pack?.__error, comments: comments ?? pk?.comments ?? [], events: (evs?.events ?? []).filter((e) => e.session === session.id), last: evs?.last ?? 0, claim: [...(queue?.next ?? []), ...(queue?.deferred ?? []), ...(queue?.notForYou ?? [])].find((q) => q.id === session.id) };
  }
  const can = (scope) => !who?.scopes || who.scopes.includes(scope) || who.scopes.includes("admin");

  async function act(label, fn) {
    try {
      const r = await fn();
      toast(label, "ok");
      await reload();
      return r;
    } catch (e) {
      if (!isAbort(e)) toast(e.message ?? String(e), "error");
      return false;
    }
  }
  async function reload() {
    const y = window.scrollY;
    await load();
    draw();
    window.scrollTo(0, y);
  }

  // ---- comment threads ---------------------------------------------------------------------------
  function commentNode(c) {
    return h("div", { class: "comment", id: "c-" + c.id },
      h("div", { class: "comment-head" }, agentChip(c.author), timeEl(c.ts), c.blocking && !c.resolved ? h("span", { class: "badge risk-high", text: "blocking" }) : null, c.resolved ? h("span", { class: "badge ok", text: "resolved" }) : null, c.endLine && c.endLine !== c.line ? h("span", { class: "dim small", text: `lines ${c.line}–${c.endLine}` }) : null),
      c.body ? md(c.body) : null,
      c.suggestion !== undefined && c.suggestion !== null ? h("div", { class: "suggest" }, h("div", { class: "suggest-head", text: "Suggested change" }), h("pre", { class: "suggest-body" }, String(c.suggestion).split("\n").map((l) => h("div", { class: "sg-line" }, h("span", { class: "sign", text: "+" }), l || "​")))) : null);
  }
  function threadNode(c, replies, live) {
    const t = h("div", { class: "thread" + (c.resolved ? " resolved" : ""), role: "group", aria: { label: `Comment thread by ${c.author}` } });
    const inner = h("div", { class: "thread-inner" }, commentNode(c), replies.map(commentNode));
    const actions = h("div", { class: "thread-actions" });
    if (live) {
      actions.appendChild(h("button", { class: "btn btn-sm", type: "button", text: "Reply", on: { click: () => openComposer(c.path, c.line, "", actions, { parent: c.id, noSuggest: true }) } }));
      if (!c.resolved) actions.appendChild(h("button", { class: "btn btn-sm", type: "button", text: "Resolve", on: { click: () => act("Thread resolved", () => post(`sessions/${enc}/comments/${encodeURIComponent(c.id)}/resolve`, { author: me() }, { signal })) } }));
      if (!c.resolved && c.suggestion !== undefined && c.suggestion !== null) actions.appendChild(h("button", { class: "btn btn-sm btn-primary", type: "button", text: "Apply suggestion", title: "Writes the suggestion into the session and resolves the thread", on: { click: () => act("Suggestion applied", () => post(`sessions/${enc}/comments/${encodeURIComponent(c.id)}/apply`, {}, { signal })) } }));
    }
    t.append(inner, actions);
    if (c.resolved) {
      const d = h("details", { class: "resolved-wrap" }, h("summary", {}, icon("check", 12), ` Resolved thread on line ${c.line} by ${c.author}`), t);
      return d;
    }
    return t;
  }

  function openComposer(path, line, lineText, anchor, { parent, noSuggest } = {}) {
    const host = anchor.nextElementSibling?.classList.contains("composer") ? anchor.nextElementSibling : null;
    if (host) return void host.querySelector("textarea").focus();
    const body = h("textarea", { rows: 3, id: "cmt-" + Math.random().toString(36).slice(2, 8), required: true, placeholder: "Leave a comment (Markdown)" });
    const sug = h("textarea", { rows: 2, class: "mono", id: "sug-" + Math.random().toString(36).slice(2, 8), value: lineText, hidden: true, spellcheck: false });
    const wantSug = h("input", { type: "checkbox", id: "ws-" + Math.random().toString(36).slice(2, 8), on: { change: () => ((sug.hidden = !wantSug.checked), wantSug.checked && sug.focus()) } });
    const blocking = h("input", { type: "checkbox", id: "bl-" + Math.random().toString(36).slice(2, 8) });
    const submit = h("button", { class: "btn btn-primary", type: "submit", text: parent ? "Reply" : "Comment" });
    const form = h("form", { class: "composer", on: { submit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await post(`sessions/${enc}/comments`, { path, line, body: body.value, suggestion: wantSug.checked ? sug.value : undefined, blocking: blocking.checked, parent, author: me() }, { signal });
        toast("Comment added", "ok");
        await reload();
      } catch (er) {
        submit.disabled = false;
        if (!isAbort(er)) toast(er.message, "error");
      }
    } } },
      h("label", { class: "sr-only", htmlFor: body.id, text: `Comment on ${path} line ${line}` }), body,
      noSuggest ? null : h("div", { class: "check-row" }, wantSug, h("label", { htmlFor: wantSug.id, text: "Suggest a replacement for this line" })), noSuggest ? null : sug,
      h("div", { class: "check-row" }, blocking, h("label", { htmlFor: blocking.id, text: "Blocking: must be resolved before this can land" })),
      h("div", { class: "composer-actions" }, h("button", { class: "btn", type: "button", text: "Cancel", on: { click: () => form.remove() } }), submit));
    if (anchor.tagName === "TR") {
      const tr = h("tr", { class: "thread-row composer-row" }, h("td", { colSpan: 3 }, form));
      anchor.after(tr);
      tr.classList.add("composer");
      tr.querySelector("textarea").focus();
      form.remove = () => tr.remove();
    } else {
      anchor.after(form);
      form.classList.add("composer");
    }
    body.focus();
  }

  // ---- dialogs for the action bar ----------------------------------------------------------------
  const noteBox = (ph) => h("textarea", { rows: 4, id: "note-" + Math.random().toString(36).slice(2, 7), placeholder: ph });
  function approveDialog() {
    const note = noteBox("Optional note for the author");
    openDialog({ title: "Approve this change", build: () => field("Note", note), actions: [{ label: "Cancel" }, { label: "Approve", kind: "primary", submit: true, onClick: async () => { await act("Approved", () => post(`sessions/${enc}/review`, { approve: true, note: note.value || undefined, reviewer: me() }, { signal })); } }] });
  }
  function rejectDialog() {
    const note = noteBox("Why is this being rejected? The author sees this.");
    note.required = true;
    openDialog({ title: "Reject this change", build: () => h("div", { class: "stack" }, h("p", { class: "muted", text: "Rejecting sends the change back with your note. It does not land." }), field("Reason", note)), actions: [{ label: "Cancel" }, { label: "Reject", kind: "danger", submit: true, onClick: async () => { await act("Rejected", () => post(`sessions/${enc}/review`, { approve: false, note: note.value, reviewer: me() }, { signal })); } }] });
  }
  function requestChangesDialog() {
    const files = S.pack?.files ?? [];
    if (!files.length) return toast("There are no files in this change to attach a blocking comment to.", "error");
    const sel = h("select", { id: "rc-file" }, files.map((f) => h("option", { value: f.path, text: f.path })));
    const line = h("input", { type: "number", min: 1, value: 1, id: "rc-line", required: true });
    const note = noteBox("What needs to change before this can land?");
    note.required = true;
    openDialog({ title: "Request changes", build: () => h("div", { class: "stack" }, h("p", { class: "muted", text: "Posts a blocking comment. The change cannot land until the thread is resolved." }), field("File", sel), field("Line", line), field("What needs to change", note)), actions: [{ label: "Cancel" }, { label: "Request changes", kind: "primary", submit: true, onClick: async () => { await act("Blocking comment posted", () => post(`sessions/${enc}/comments`, { path: sel.value, line: Number(line.value), body: note.value, blocking: true, author: me() }, { signal })); } }] });
  }
  function verifyDialog() {
    const pass = h("input", { type: "radio", name: "vr", id: "vr-pass", checked: true });
    const fail = h("input", { type: "radio", name: "vr", id: "vr-fail" });
    const note = noteBox("What did you check?");
    openDialog({ title: "Verify the merged result", build: () => h("div", { class: "stack" }, h("p", { class: "muted", text: "Verification confirms the merged result still behaves. A different identity than the author must do it." }), h("div", { class: "check-row" }, pass, h("label", { htmlFor: "vr-pass", text: "Verified: it works" })), h("div", { class: "check-row" }, fail, h("label", { htmlFor: "vr-fail", text: "Failed: it does not work" })), field("Note", note)), actions: [{ label: "Cancel" }, { label: "Submit", kind: "primary", submit: true, onClick: async () => { await act("Verification recorded", () => post(`sessions/${enc}/verify`, { passed: pass.checked, note: note.value || undefined, verifier: me() }, { signal })); } }] });
  }

  // ---- page --------------------------------------------------------------------------------------
  function draw() {
    const { s, pack, comments } = S;
    const live = LIVE.includes(s.status);
    for (const sec of root.querySelectorAll(".diff-file")) collapsed.set(sec.dataset.path, sec.classList.contains("collapsed"));
    clear(root);
    ctx.setTitle(s.goal || "Change");
    const risk = pack?.risk ?? s.risk;
    const files = pack?.files ?? [];

    // header
    const claimed = S.claim?.claimedBy;
    const head = h("header", { class: "change-head card" },
      h("nav", { class: "crumbs", aria: { label: "Breadcrumb" } }, link("Changes", buildHash("changes"), { class: "crumb" }), h("span", { class: "sep", text: "/" }), h("span", { class: "crumb current mono", text: s.id })),
      h("div", { class: "change-title" }, h("h1", { text: s.goal || "(no goal given)" }), statusPill(s.status)),
      h("div", { class: "change-meta" }, agentChip(s.agent), s.model ? h("span", { class: "mono badge", text: s.model }) : null, h("span", { class: "dim" }, "opened ", timeEl(s.createdAt)), pack ? h("span", { class: "dim" }, `based on r${pack.baseRev}`, pack.behindBy ? `, trunk is ${pack.behindBy} ahead` : "") : h("span", { class: "dim", text: `based on r${s.baseRev}` }), s.landedRev ? link("landed as r" + s.landedRev, buildHash("commit", { rev: s.landedRev }), { class: "badge ok" }) : null, claimed ? h("span", { class: "badge", title: "Review claim: only the claimant can approve or reject" }, icon("user", 12), ` claimed by ${claimed}`) : null),
      h("div", { class: "change-risk" }, riskBadge(risk), risk?.need && risk.need !== "none" ? h("span", { class: "badge", text: risk.need === "human" ? "needs a human approval" : "needs a reviewer" }) : null, risk ? h("details", { class: "reasons-wrap" }, h("summary", { text: "Why this score" }), h("ul", { class: "reasons" }, (risk.reasons ?? []).map((r) => h("li", { text: r })))) : h("span", { class: "dim small", text: "No risk score: the change does not merge cleanly with trunk right now." })),
      actionBar(s, live));
    root.appendChild(head);

    // warnings (the thing a reviewer must read first)
    const warns = pack?.warnings ?? [];
    const feedback = s.feedback ?? [];
    if (S.packError) root.appendChild(h("div", { class: "alert alert-warn" }, icon("warn"), h("div", {}, h("strong", { text: "Could not build the review pack." }), h("p", { text: S.packError.message }))));
    if (warns.length) root.appendChild(h("section", { class: "alert alert-warn warnings", aria: { label: "Warnings" } }, icon("warn", 20), h("div", { class: "grow" }, h("h2", { text: plural(warns.length, "warning") + " before you review" }), h("ul", {}, warns.map((w) => h("li", { text: w }))))));
    if (feedback.length) root.appendChild(h("section", { class: "alert alert-info feedback", aria: { label: "Feedback to the author" } }, icon("comment", 20), h("div", { class: "grow" }, h("h2", { text: "Feedback given to the author" }), h("ul", {}, feedback.map((f) => h("li", {}, h("strong", { text: f.type.replace("_", " ") }), ` by ${f.by}: `, f.note, " ", timeEl(f.ts)))))));
    if (!warns.length && pack && live) root.appendChild(h("div", { class: "alert alert-ok" }, icon("check"), h("span", { text: "No warnings: up to date with trunk, mergeable, and evidence is current." })));

    const main = h("div", { class: "col-main" });
    const side = h("aside", { class: "col-side", aria: { label: "Change details" } });
    root.appendChild(h("div", { class: "cols change-cols" }, main, side));

    // files
    const byPath = new Map();
    const top = comments.filter((c) => !c.parent);
    const replies = new Map();
    for (const c of comments) if (c.parent) (replies.get(c.parent) ?? replies.set(c.parent, []).get(c.parent)).push(c);
    for (const c of top) (byPath.get(c.path) ?? byPath.set(c.path, []).get(c.path)).push(c);
    const unplaced = new Map(top.map((c) => [c.id, c]));
    main.appendChild(h("div", { class: "toolbar" }, h("strong", { text: pack ? `${plural(files.length, "file")} changed` : "Files" }), pack ? h("span", { class: "diff-counts" }, h("b", { class: "add", text: "+" + pack.stats.added }), " ", h("b", { class: "del", text: "−" + pack.stats.removed })) : null, h("span", { class: "grow" }), files.length ? [h("button", { class: "btn btn-sm", type: "button", text: "Collapse all", on: { click: () => setAllDiffs(main, false) } }), h("button", { class: "btn btn-sm", type: "button", text: "Expand all", on: { click: () => setAllDiffs(main, true) } })] : null));
    if (!pack) main.appendChild(emptyState("No diff available", S.packError ? "The review pack could not be built for this change." : "This server did not return a review pack.", "file"));
    else if (!files.length) main.appendChild(emptyState("No file changes", "This change has not edited any files yet.", "file"));
    for (const f of files) {
      const mine = byPath.get(f.path) ?? [];
      const byLine = new Map();
      const visible = new Set();
      for (const hk of parseVisible(f.patch)) visible.add(hk);
      const orphans = [];
      for (const c of mine) {
        const node = threadNode(c, replies.get(c.id) ?? [], live);
        if (visible.has(c.line)) (byLine.get(c.line) ?? byLine.set(c.line, []).get(c.line)).push(node);
        else orphans.push(node);
        unplaced.delete(c.id);
      }
      const sec = diffFile(f, { id: "f-" + f.path, commentsByLine: byLine, collapsed: collapsed.has(f.path) ? collapsed.get(f.path) : undefined, onLineComment: live && can("write") ? (line, text, tr) => openComposer(f.path, line, text, tr) : null });
      if (orphans.length) sec.appendChild(h("div", { class: "orphans" }, h("p", { class: "dim small", text: "Comments on lines outside the visible diff" }), orphans));
      main.appendChild(sec);
    }
    const stray = [...unplaced.values()];
    if (stray.length) main.appendChild(h("section", { class: "card", aria: { label: "Other comments" } }, h("h2", { class: "card-title", text: "Comments on files outside this diff" }), stray.map((c) => h("div", {}, h("p", { class: "mono small dim", text: `${c.path}:${c.line}` }), threadNode(c, replies.get(c.id) ?? [], live)))));
    if (pack?.conflicts?.length) main.appendChild(h("section", { class: "card", aria: { label: "Conflicts" } }, h("h2", { class: "card-title" }, icon("warn", 16), " Conflicted files (not in the diff)"), h("ul", { class: "plain" }, pack.conflicts.map((c) => h("li", {}, h("span", { class: "mono", text: c.path }), " ", h("span", { class: "badge risk-high", text: c.kind }))))));

    // sidebar
    const evidence = pack?.evidence ?? s.evidence ?? [];
    side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Checks" }), evidenceList(evidence)));
    if ((pack?.previews ?? s.previews)?.length) side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Previews" }), h("ul", { class: "plain" }, (pack?.previews ?? s.previews).map((u) => h("li", {}, h("a", { href: u, target: "_blank", rel: "noopener noreferrer nofollow", class: "ext" }, u))))));
    const appr = pack?.approvals ?? s.approvals ?? [];
    side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Approvals" }), appr.length ? h("ul", { class: "plain" }, appr.map((a) => h("li", {}, agentChip(a.by), h("span", { class: "badge", text: a.kind }), a.ts ? timeEl(a.ts) : null))) : h("p", { class: "muted", text: risk?.need === "none" ? "Not required: low risk lands on evidence." : "No approvals yet." }), s.verified ? h("p", { class: "small" }, "Verified by ", agentChip(s.verified.by)) : null));
    if (pack?.semantic?.length) side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Interactions with concurrent work" }), h("ul", { class: "plain small" }, pack.semantic.map((k) => h("li", { text: k.detail ?? JSON.stringify(k) })))));
    if (s.intent?.length) side.appendChild(h("section", { class: "card" }, h("h2", { class: "card-title", text: "Declared intent" }), h("ul", { class: "plain mono small" }, s.intent.map((p) => h("li", { text: p })))));
    side.appendChild(h("section", { class: "card", aria: { label: "Timeline" } }, h("h2", { class: "card-title", text: "Timeline" }), S.events.length ? h("ol", { class: "timeline" }, S.events.map((e) => h("li", { class: "tl-" + e.type }, h("span", { class: "dot", aria: { hidden: "true" } }), h("div", {}, h("div", { class: "tl-msg", text: e.message }), h("div", { class: "dim small" }, h("span", { text: e.type }), " · ", timeEl(e.ts), e.by ? ` · ${e.by}` : ""))))) : h("p", { class: "muted", text: "No events recorded for this change." })));
  }

  function actionBar(s, live) {
    const b = (label, ic, onClick, kind = "", scope, title) => {
      const allowed = !scope || can(scope);
      return h("button", { class: "btn " + kind, type: "button", disabled: !live || !allowed, title: !live ? `This change is ${s.status}` : !allowed ? `Needs the ${scope} scope` : title, on: { click: onClick } }, icon(ic, 14), label);
    };
    return h("div", { class: "actionbar", role: "toolbar", aria: { label: "Review actions" } },
      b("Approve", "check", approveDialog, "btn-primary", "review"),
      b("Request changes", "comment", requestChangesDialog, "", "write"),
      b("Reject", "x", rejectDialog, "btn-danger", "review"),
      b("Claim review", "user", () => act("Review claimed", () => post(`sessions/${enc}/claim-review`, {}, { signal })), "", "review", "Reserve the review so others do not duplicate it"),
      b("Verify", "shield", verifyDialog, "", "verify"),
      b("Re-run checks", "pulse", () => act("Checks re-queued", () => post(`sessions/${enc}/rerun`, {}, { signal })), "btn-ghost", "write"),
      !live ? h("span", { class: "dim small", text: `Actions are closed: this change is ${s.status}.` }) : who ? null : h("span", { class: "dim small", text: "Buttons are always shown; the server decides what you may do." }));
  }

  try {
    await load();
  } catch (e) {
    if (e.status === 404) return void add(root, [h("p", {}, link("← All changes", buildHash("changes"))), emptyState("Change not found", `There is no change with id ${id}.`, "change")]);
    throw e;
  }
  draw();

  // live updates: while the session is live, long-poll the event stream and refresh when it moves
  if (LIVE.includes(S.s.status)) {
    (async () => {
      let after = S.last;
      let fails = 0;
      while (!signal.aborted && fails < 3) {
        try {
          const r = await api("events", { query: { after, wait: 20 } });
          fails = 0;
          after = r.last ?? after;
          const mine = (r.events ?? []).some((e) => e.session === S.s.id);
          if (mine && !root.querySelector(".composer textarea:not(:placeholder-shown)") && !document.querySelector("dialog[open]")) await reload();
        } catch (e) {
          if (isAbort(e)) return;
          fails++;
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    })();
  }
}

/** New-side line numbers that appear in a patch (comment threads can only attach to these). */
function parseVisible(patch) {
  const out = [];
  let n = 0;
  for (const raw of String(patch ?? "").split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (m) {
      n = +m[1];
      continue;
    }
    if (!n) continue;
    const c = raw[0];
    if (c === "+" || c === " ") out.push(n++);
  }
  return out;
}
