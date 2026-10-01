// pkt-line framing.
import { concat, dec, enc } from "./bytes.ts";

export const FLUSH = enc.encode("0000");
export const DELIM = enc.encode("0001");

export function pkt(data: string | Uint8Array): Uint8Array {
  const b = typeof data === "string" ? enc.encode(data) : data;
  if (b.length > 65516) throw new Error("pkt-line too long");
  return concat([enc.encode((b.length + 4).toString(16).padStart(4, "0")), b]);
}

export type Pkt = { kind: "data"; data: Uint8Array } | { kind: "flush" } | { kind: "delim" } | { kind: "end" };

/** Read one packet at `off`; returns null at end of input. */
export function readPkt(buf: Uint8Array, off: number): { pkt: Pkt; next: number } | null {
  if (off >= buf.length) return null;
  if (off + 4 > buf.length) throw new Error("pkt-line: truncated length");
  const len = parseInt(dec.decode(buf.subarray(off, off + 4)), 16);
  if (Number.isNaN(len)) throw new Error("pkt-line: bad length");
  if (len === 0) return { pkt: { kind: "flush" }, next: off + 4 };
  if (len === 1) return { pkt: { kind: "delim" }, next: off + 4 };
  if (len === 2) return { pkt: { kind: "end" }, next: off + 4 };
  if (len < 4 || off + len > buf.length) throw new Error("pkt-line: bad length");
  return { pkt: { kind: "data", data: buf.subarray(off + 4, off + len) }, next: off + len };
}

/** Parse packets until a flush (inclusive) when `stopAtFlush`, else to end of input. */
export function readPkts(buf: Uint8Array, off = 0, stopAtFlush = false): { pkts: Pkt[]; next: number } {
  const pkts: Pkt[] = [];
  for (;;) {
    const r = readPkt(buf, off);
    if (!r) break;
    pkts.push(r.pkt);
    off = r.next;
    if (stopAtFlush && r.pkt.kind === "flush") break;
  }
  return { pkts, next: off };
}

/** Text of a data pkt without the trailing newline. */
export function pktText(p: Pkt): string {
  if (p.kind !== "data") return "";
  const s = dec.decode(p.data);
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/** Wrap bytes as side-band packets on `band` (chunked). */
export function sideband(band: number, data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += 65000) {
    const chunk = data.subarray(off, off + 65000);
    const b = new Uint8Array(chunk.length + 1);
    b[0] = band;
    b.set(chunk, 1);
    parts.push(pkt(b));
  }
  return concat(parts);
}
