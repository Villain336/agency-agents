// Push Weave trunk history to a plain Git remote (e.g. GitHub) over smart-HTTP receive-pack.
// Object ids are deterministic, so the remote history is identical to what clients clone from Weave.
import type { Repo } from "../repo.ts";
import { concat, dec, ZERO_SHA } from "./bytes.ts";
import { GitView, MAIN_REF } from "./objects.ts";
import { buildPack } from "./pack.ts";
import { FLUSH, pkt, pktText, readPkts } from "./pkt.ts";

export async function mirrorPush(
  repo: Repo,
  remoteUrl: string,
  token: string,
  fromRev: number,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ pushedRev: number }> {
  const head = repo.s.rev;
  if (head <= fromRev) return { pushedRev: fromRev };
  const view = new GitView(repo);
  const newId = view.commitSha(head) as string;
  const oldId = view.commitSha(fromRev);
  const base = remoteUrl.replace(/\/+$/, "");
  const auth = { authorization: `Basic ${btoa(`x-access-token:${token}`)}` };

  const adv = await fetchImpl(`${base}/info/refs?service=git-receive-pack`, { headers: { ...auth, "user-agent": "weave" } });
  if (!adv.ok) throw new Error(`mirror: info/refs failed with HTTP ${adv.status}`);
  let remoteMain: string | null = null;
  for (const p of readPkts(new Uint8Array(await adv.arrayBuffer())).pkts) {
    if (p.kind !== "data") continue;
    const line = pktText(p).split("\0")[0];
    if (line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    if (line.slice(sp + 1) === MAIN_REF) remoteMain = line.slice(0, sp);
  }
  if (remoteMain !== oldId) throw new Error(`mirror: remote ${MAIN_REF} is ${remoteMain ?? "empty"}, expected ${oldId ?? "empty"} (r${fromRev}); not pushing`);

  const exclude = oldId ? view.closure([oldId]) : new Set<string>();
  const pack = buildPack(view.collect([newId], exclude).map((x) => x.obj));
  const body = concat([pkt(`${oldId ?? ZERO_SHA} ${newId} ${MAIN_REF}\0report-status agent=weave\n`), FLUSH, pack]);
  const res = await fetchImpl(`${base}/git-receive-pack`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result", "user-agent": "weave" },
    body,
  });
  if (!res.ok) throw new Error(`mirror: receive-pack failed with HTTP ${res.status}`);
  const lines = readPkts(new Uint8Array(await res.arrayBuffer())).pkts.filter((p) => p.kind === "data").map(pktText);
  if (!lines.includes("unpack ok")) throw new Error(`mirror: remote unpack failed: ${lines.join(" | ") || dec.decode(new Uint8Array(0))}`);
  const bad = lines.find((l) => l.startsWith("ng "));
  if (bad) throw new Error(`mirror: remote rejected push: ${bad}`);
  if (!lines.includes(`ok ${MAIN_REF}`)) throw new Error(`mirror: no confirmation for ${MAIN_REF}`);
  return { pushedRev: head };
}
