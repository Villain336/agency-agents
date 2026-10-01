// Packfile build / parse.
import { concat, toHex } from "./bytes.ts";
import { applyDelta } from "./delta.ts";
import { hashObject, sha1 } from "./sha1.ts";
import { inflateZlib, zlibEncode } from "./zlib.ts";

export type ObjType = 1 | 2 | 3 | 4;
export interface GitObj { type: ObjType; data: Uint8Array }
export const TYPE_NAME: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export const objectId = (o: GitObj): string => hashObject(TYPE_NAME[o.type], o.data);

function entryHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let b = (type << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(b);
  return new Uint8Array(out);
}

export function buildPack(objs: GitObj[]): Uint8Array {
  const head = new Uint8Array(12);
  const dv = new DataView(head.buffer);
  head.set([0x50, 0x41, 0x43, 0x4b]);
  dv.setUint32(4, 2);
  dv.setUint32(8, objs.length);
  const parts: Uint8Array[] = [head];
  for (const o of objs) parts.push(entryHeader(o.type, o.data.length), zlibEncode(o.data));
  const body = concat(parts);
  return concat([body, sha1(body)]);
}

/**
 * Parse a pack, resolve deltas (thin-pack bases come from `external`), return objects by id.
 * Verifies the trailing checksum and every inflated size.
 */
export function parsePack(buf: Uint8Array, external: (id: string) => GitObj | undefined = () => undefined): Map<string, GitObj> {
  if (buf.length < 32 || buf[0] !== 0x50 || buf[1] !== 0x41 || buf[2] !== 0x43 || buf[3] !== 0x4b) throw new Error("not a packfile");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = dv.getUint32(8);
  type Entry = { offset: number; type: number; data: Uint8Array; baseOff?: number; baseId?: string; resolved?: GitObj };
  const entries: Entry[] = [];
  let p = 12;
  for (let i = 0; i < count; i++) {
    const offset = p;
    let c = buf[p++];
    const type = (c >> 4) & 7;
    let size = c & 15;
    let mul = 16;
    while (c & 0x80) {
      if (p >= buf.length) throw new Error("pack: truncated entry header");
      c = buf[p++];
      size += (c & 0x7f) * mul;
      mul *= 128;
    }
    const e: Entry = { offset, type, data: new Uint8Array(0) };
    if (type === 6) {
      c = buf[p++];
      let off = c & 0x7f;
      while (c & 0x80) {
        c = buf[p++];
        off = (off + 1) * 128 + (c & 0x7f);
      }
      e.baseOff = offset - off;
    } else if (type === 7) {
      e.baseId = toHex(buf.subarray(p, p + 20));
      p += 20;
    } else if (type < 1 || type > 4) throw new Error(`pack: bad object type ${type}`);
    const r = inflateZlib(buf, p, size);
    if (r.data.length !== size) throw new Error("pack: inflated size mismatch");
    e.data = r.data;
    p = r.end;
    entries.push(e);
  }
  if (p + 20 !== buf.length) throw new Error("pack: bad length / trailing garbage");
  if (toHex(sha1(buf.subarray(0, p))) !== toHex(buf.subarray(p))) throw new Error("pack: checksum mismatch");

  const byOffset = new Map<number, Entry>();
  const byId = new Map<string, GitObj>();
  for (const e of entries) byOffset.set(e.offset, e);
  const done = (e: Entry, o: GitObj) => {
    e.resolved = o;
    byId.set(objectId(o), o);
  };
  for (const e of entries) if (e.type >= 1 && e.type <= 4) done(e, { type: e.type as ObjType, data: e.data });
  let pending = entries.filter((e) => !e.resolved);
  while (pending.length) {
    const next: Entry[] = [];
    for (const e of pending) {
      const base = e.baseOff !== undefined ? byOffset.get(e.baseOff)?.resolved : (byId.get(e.baseId!) ?? external(e.baseId!));
      if (!base) next.push(e);
      else done(e, { type: base.type, data: applyDelta(base.data, e.data) });
    }
    if (next.length === pending.length) throw new Error("pack: unresolved delta base");
    pending = next;
  }
  return byId;
}
