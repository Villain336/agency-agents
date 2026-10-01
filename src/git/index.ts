// Weave as a Git smart-HTTP remote. Runtime-safe (Workers): no Node APIs, no crypto.subtle.
import type { Actor, Repo } from "../repo.ts";
import { GitView } from "./objects.ts";
import { advertiseReceive, handleReceive } from "./receive.ts";
import { advertiseUpload, handleUploadV0, handleUploadV2 } from "./upload.ts";
import { gunzip } from "./zlib.ts";

export { mirrorPush } from "./mirror.ts";

export interface GitHost {
  repo: Repo;
  /** HTTP Basic: username = agent name, password = token. Return null to reject. */
  authenticate(req: Request): { agent: string; actor?: Actor } | null;
  persist(): Promise<void>;
}

const text = (status: number, msg: string, headers: Record<string, string> = {}) =>
  new Response(msg + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

export async function handleGitRequest(req: Request, host: GitHost, prefix = "/git"): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(prefix)) return text(404, "not found");
  const route = url.pathname.slice(prefix.length);
  const noCache = { "cache-control": "no-cache, max-age=0, must-revalidate", pragma: "no-cache", expires: "Fri, 01 Jan 1980 00:00:00 GMT" };

  const isInfo = route === "/info/refs";
  const isUpload = route === "/git-upload-pack";
  const isReceive = route === "/git-receive-pack";
  if (!isInfo && !isUpload && !isReceive) return text(404, "not found");
  if (req.method !== (isInfo ? "GET" : "POST")) return text(405, "method not allowed", { allow: isInfo ? "GET" : "POST" });

  const auth = host.authenticate(req);
  if (!auth) return text(401, "authentication required", { "www-authenticate": 'Basic realm="weave"' });

  if (isReceive && auth.actor && !auth.actor.open && !auth.actor.scopes.includes("write")) return text(403, `${auth.actor.name} may not push (needs the write scope)`);

  try {
    const view = new GitView(host.repo);
    const send = (body: Uint8Array, type: string) => new Response(body as BodyInit, { headers: { "content-type": type, ...noCache } });
    if (isInfo) {
      const service = url.searchParams.get("service");
      if (service === "git-upload-pack") {
        const v2 = /(^|:)version=2(:|$)/.test(req.headers.get("git-protocol") ?? "");
        return send(advertiseUpload(view, v2), "application/x-git-upload-pack-advertisement");
      }
      if (service === "git-receive-pack") return send(advertiseReceive(view), "application/x-git-receive-pack-advertisement");
      return text(403, "dumb http protocol is not supported; use smart HTTP");
    }
    let body: Uint8Array = new Uint8Array(await req.arrayBuffer());
    if (/gzip/i.test(req.headers.get("content-encoding") ?? "")) body = gunzip(body);
    if (isUpload) {
      const v2 = /(^|:)version=2(:|$)/.test(req.headers.get("git-protocol") ?? "");
      return send(v2 ? handleUploadV2(view, body) : handleUploadV0(view, body), "application/x-git-upload-pack-result");
    }
    const r = await handleReceive(view, body, auth.agent, auth.actor);
    if (r.mutated) await host.persist();
    return send(r.body, "application/x-git-receive-pack-result");
  } catch (e) {
    return text(500, `weave git error: ${(e as Error).message}`);
  }
}
