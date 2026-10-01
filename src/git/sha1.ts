// Synchronous pure-JS SHA-1 (Workers' crypto.subtle is async-only; object ids are needed synchronously).
import { concat, enc, toHex } from "./bytes.ts";

const w = new Int32Array(80);

export function sha1(data: Uint8Array): Uint8Array {
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  const block = (a8: Uint8Array, off: number) => {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (a8[j] << 24) | (a8[j + 1] << 16) | (a8[j + 2] << 8) | a8[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  };
  const len = data.length;
  const full = len - (len % 64);
  for (let off = 0; off < full; off += 64) block(data, off);
  const rest = len - full;
  const tailLen = rest + 9 <= 64 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(data.subarray(full), 0);
  tail[rest] = 0x80;
  const bits = len * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tailLen - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(tailLen - 4, bits >>> 0);
  for (let off = 0; off < tailLen; off += 64) block(tail, off);
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, h0); ov.setInt32(4, h1); ov.setInt32(8, h2); ov.setInt32(12, h3); ov.setInt32(16, h4);
  return out;
}

export const sha1Hex = (data: Uint8Array): string => toHex(sha1(data));

/** Object id: sha1("<type> <len>\0" + data). */
export function hashObject(type: string, data: Uint8Array): string {
  return sha1Hex(concat([enc.encode(`${type} ${data.length}\0`), data]));
}
