// upload-pack (clone / fetch): protocol v2 plus v0/v1 fallback. Always sends whole object sets
// minus whatever is reachable from "have" lines we recognise.
import { concat } from "./bytes.ts";
import { GitView, MAIN_REF } from "./objects.ts";
import { buildPack } from "./pack.ts";
import { DELIM, FLUSH, pkt, pktText, readPkts, sideband } from "./pkt.ts";

const AGENT = "agent=weave";

export function advertiseUpload(view: GitView, v2: boolean): Uint8Array {
  if (v2) {
    return concat([
      pkt("version 2\n"), pkt(`${AGENT}\n`), pkt("ls-refs\n"), pkt("fetch\n"), pkt("server-option\n"), pkt("object-format=sha1\n"), FLUSH,
    ]);
  }
  const refs = view.refs();
  const main = view.mainSha();
  const list: { name: string; id: string }[] = main ? [{ name: "HEAD", id: main }, ...refs] : refs;
  const caps = `side-band side-band-64k thin-pack ofs-delta no-progress ${main ? `symref=HEAD:${MAIN_REF} ` : ""}object-format=sha1 ${AGENT}`;
  const parts: Uint8Array[] = [pkt("# service=git-upload-pack\n"), FLUSH];
  if (!list.length) parts.push(pkt(`${"0".repeat(40)} capabilities^{}\0${caps}\n`));
  list.forEach((r, i) => parts.push(pkt(`${r.id} ${r.name}${i === 0 ? `\0${caps}` : ""}\n`)));
  parts.push(FLUSH);
  return concat(parts);
}

const err = (msg: string) => concat([pkt(`ERR ${msg}\n`)]);

function packfileBody(view: GitView, wants: string[], haves: string[], band: boolean): Uint8Array {
  const exclude = view.closure(haves.filter((h) => view.get(h)));
  const pack = buildPack(view.collect(wants, exclude).map((x) => x.obj));
  return band ? concat([sideband(1, pack), FLUSH]) : pack;
}

export function handleUploadV2(view: GitView, body: Uint8Array): Uint8Array {
  view.ensureAll();
  view.refs(); // register session commits so they can be wanted
  const { pkts } = readPkts(body, 0, true);
  const lines = pkts.filter((p) => p.kind === "data").map(pktText);
  const command = lines.find((l) => l.startsWith("command="))?.slice(8);
  const delimAt = pkts.findIndex((p) => p.kind === "delim");
  const args = delimAt < 0 ? [] : pkts.slice(delimAt + 1).filter((p) => p.kind === "data").map(pktText);

  if (command === "ls-refs") {
    const symrefs = args.includes("symrefs");
    const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice(11));
    const main = view.mainSha();
    const all: { name: string; id: string; extra: string }[] = [];
    if (main) all.push({ name: "HEAD", id: main, extra: symrefs ? ` symref-target:${MAIN_REF}` : "" });
    for (const r of view.refs()) all.push({ ...r, extra: "" });
    const out = all
      .filter((r) => !prefixes.length || prefixes.some((p) => r.name.startsWith(p)))
      .map((r) => pkt(`${r.id} ${r.name}${r.extra}\n`));
    return concat([...out, FLUSH]);
  }

  if (command === "fetch") {
    const wants = args.filter((a) => a.startsWith("want ")).map((a) => a.slice(5));
    const haves = args.filter((a) => a.startsWith("have ")).map((a) => a.slice(5));
    const done = args.includes("done");
    for (const w of wants) if (!view.get(w)) return err(`upload-pack: not our ref ${w}`);
    const parts: Uint8Array[] = [];
    if (!done) {
      parts.push(pkt("acknowledgments\n"));
      const common = haves.filter((h) => view.get(h));
      if (!common.length) parts.push(pkt("NAK\n"));
      for (const h of common) parts.push(pkt(`ACK ${h}\n`));
      parts.push(pkt("ready\n"), DELIM);
    }
    parts.push(pkt("packfile\n"), packfileBody(view, wants, haves, true));
    return concat(parts);
  }
  return err(`unsupported command ${command ?? "(none)"}`);
}

/** v0/v1 stateless POST. Without multi_ack: first common have -> ACK + pack; on `done` -> ACK/NAK + pack. */
export function handleUploadV0(view: GitView, body: Uint8Array): Uint8Array {
  view.ensureAll();
  view.refs(); // register session commits so they can be wanted
  const { pkts } = readPkts(body);
  const wants: string[] = [], haves: string[] = [];
  let done = false, caps = "";
  for (const p of pkts) {
    if (p.kind !== "data") continue;
    const t = pktText(p);
    if (t.startsWith("want ")) {
      const [id, ...rest] = t.slice(5).split(/[ \0]/);
      wants.push(id);
      if (rest.length && !caps) caps = rest.join(" ");
    } else if (t.startsWith("have ")) haves.push(t.slice(5).trim());
    else if (t === "done") done = true;
  }
  for (const w of wants) if (!view.get(w)) return err(`upload-pack: not our ref ${w}`);
  const common = haves.filter((h) => view.get(h));
  if (!done && !common.length) return concat([pkt("NAK\n")]);
  const band = /side-band/.test(caps);
  const ack = common.length ? pkt(`ACK ${done ? common[common.length - 1] : common[0]}\n`) : pkt("NAK\n");
  return concat([ack, packfileBody(view, wants, haves, band)]);
}

