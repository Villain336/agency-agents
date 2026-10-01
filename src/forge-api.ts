// Routes for the forge features: tasks, notifications, tags, releases, review claims.
import type { Ctx } from "./api.ts";
import { WeaveError } from "./repo.ts";

const me = (c: Ctx) => (c.actor.open ? String(c.body?.agent ?? c.url.searchParams.get("as") ?? "anonymous") : c.actor.name);
const num = (s: string | undefined) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new WeaveError(`bad task number: ${s}`);
  return n;
};
const lease = (c: Ctx) => (c.body?.leaseSec !== undefined ? Number(c.body.leaseSec) : undefined);

/** Returns undefined when the route is not a forge route. */
export function forgeRoute(c: Ctx): unknown {
  const { repo, method, parts, url, body } = c;
  const [a, id, sub, sid] = parts;
  const q = (k: string) => url.searchParams.get(k) ?? undefined;

  if (a === "tasks") {
    if (method === "GET") {
      if (id === "next") return { task: repo.nextTask({ labels: q("labels")?.split(",").filter(Boolean) }) };
      if (!id) return repo.listTasks({ status: q("status") as any, label: q("label"), q: q("q"), assignee: q("assignee") });
      return repo.getTask(num(id));
    }
    if (!id) return repo.createTask(me(c), body);
    const n = num(id);
    const by = me(c);
    switch (sub) {
      case "claim": return repo.claimTask(n, by, lease(c));
      case "release": return repo.releaseTask(n, by);
      case "heartbeat": return repo.heartbeatTask(n, by, lease(c));
      case "close": return repo.closeTask(n, by);
      case "reopen": return repo.reopenTask(n, by);
      case "comment": return repo.commentTask(n, by, String(body.body ?? ""));
      case "assign": return repo.assignTask(n, String(body.assignee ?? ""), by);
      case "update": return repo.updateTask(n, body);
    }
  }
  if (a === "notifications") {
    if (method === "GET") return repo.notificationsFor(me(c), { unread: url.searchParams.get("unread") === "1" });
    if (id === "read") return repo.markRead(me(c), { ids: body.ids, all: !!body.all });
  }
  if (a === "teams") {
    if (method === "GET") return id ? repo.getTeam(id) : repo.listTeams();
    if (!id) return repo.createTeam(String(body.name ?? ""), body.members ?? [], me(c), body.description);
    if (sub === "delete") return (repo.deleteTeam(id), { ok: true });
    return repo.updateTeam(id, body);
  }
  if (a === "tags") {
    if (method === "GET") return repo.listTags();
    return repo.createTag(String(body.name ?? ""), { rev: body.rev, message: body.message, tagger: me(c) });
  }
  if (a === "releases") {
    if (method === "GET") return id ? repo.getRelease(decodeURIComponent(id)) : repo.listReleases();
    return repo.createRelease({ tag: String(body.tag ?? ""), title: body.title, notes: body.notes, draft: body.draft, prerelease: body.prerelease }, me(c));
  }
  if (a === "sessions" && id && sub === "claim-review" && method === "POST") {
    const s = repo.claimReview(id, me(c), lease(c));
    return { id, reviewClaim: s.reviewClaim };
  }
  return undefined;
}
