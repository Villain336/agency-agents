// zlib: a stored-block encoder (no compression, always valid) and a real inflate decoder.
import { concat } from "./bytes.ts";

export function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Raw deflate using only stored blocks. */
export function deflateStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let off = 0;
  do {
    const n = Math.min(65535, data.length - off);
    const final = off + n >= data.length;
    const hdr = new Uint8Array(5);
    hdr[0] = final ? 1 : 0;
    hdr[1] = n & 255; hdr[2] = n >> 8; hdr[3] = ~n & 255; hdr[4] = (~n >> 8) & 255;
    parts.push(hdr, data.subarray(off, off + n));
    off += n;
  } while (off < data.length);
  return concat(parts);
}

export function zlibEncode(data: Uint8Array): Uint8Array {
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, adler32(data));
  return concat([new Uint8Array([0x78, 0x01]), deflateStored(data), trailer]);
}

interface Huff { count: Uint16Array; symbol: Uint16Array }
function build(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  const offs = new Uint16Array(16);
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  for (let s = 0; s < n; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLit: Huff | undefined;
let fixedDist: Huff | undefined;
function fixed(): [Huff, Huff] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedLit = build(l, 288);
    fixedDist = build(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

/** Inflate a raw deflate stream starting at `start`. `end` is the index just past the last consumed byte. */
export function inflateRaw(src: Uint8Array, start = 0, sizeHint = 0): { data: Uint8Array; end: number } {
  let pos = start, bitbuf = 0, bitcnt = 0;
  let out = new Uint8Array(Math.max(sizeHint, 64));
  let o = 0;
  const bits = (n: number): number => {
    while (bitcnt < n) {
      if (pos >= src.length) throw new Error("inflate: unexpected end of input");
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("inflate: invalid huffman code");
  };
  const grow = (extra: number) => {
    if (o + extra <= out.length) return;
    const n = new Uint8Array(Math.max(out.length * 2, o + extra));
    n.set(out.subarray(0, o));
    out = n;
  };
  for (let final = 0; !final; ) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0; // byte-align (we never hold a whole unused byte)
      if (pos + 4 > src.length) throw new Error("inflate: unexpected end of input");
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error("inflate: bad stored block length");
      pos += 4;
      if (pos + len > src.length) throw new Error("inflate: unexpected end of input");
      grow(len);
      out.set(src.subarray(pos, pos + len), o);
      o += len;
      pos += len;
    } else if (type === 1 || type === 2) {
      let lit: Huff, dist: Huff;
      if (type === 1) [lit, dist] = fixed();
      else {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        if (nlen > 286 || ndist > 30) throw new Error("inflate: bad counts");
        const cl = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) cl[CL_ORDER[i]] = bits(3);
        const clh = build(cl, 19);
        const lengths = new Uint8Array(nlen + ndist);
        for (let i = 0; i < nlen + ndist; ) {
          const sym = decode(clh);
          if (sym < 16) lengths[i++] = sym;
          else {
            let prev = 0, rep: number;
            if (sym === 16) {
              if (i === 0) throw new Error("inflate: bad repeat");
              prev = lengths[i - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > nlen + ndist) throw new Error("inflate: bad repeat length");
            while (rep--) lengths[i++] = prev;
          }
        }
        lit = build(lengths.subarray(0, nlen), nlen);
        dist = build(lengths.subarray(nlen), ndist);
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          grow(1);
          out[o++] = sym;
        } else if (sym === 256) break;
        else {
          const s = sym - 257;
          if (s >= 29) throw new Error("inflate: bad length symbol");
          const len = LBASE[s] + bits(LEXT[s]);
          const ds = decode(dist);
          if (ds >= 30) throw new Error("inflate: bad distance symbol");
          const d = DBASE[ds] + bits(DEXT[ds]);
          if (d > o) throw new Error("inflate: distance too far back");
          grow(len);
          for (let i = 0; i < len; i++, o++) out[o] = out[o - d];
        }
      }
    } else throw new Error("inflate: invalid block type");
  }
  return { data: out.subarray(0, o), end: pos };
}

/** Inflate a zlib stream (2-byte header, deflate, adler32). `end` is past the adler32 trailer. */
export function inflateZlib(src: Uint8Array, start = 0, sizeHint = 0): { data: Uint8Array; end: number } {
  if (start + 2 > src.length) throw new Error("zlib: unexpected end of input");
  const cmf = src[start], flg = src[start + 1];
  if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) throw new Error("zlib: bad header");
  const r = inflateRaw(src, start + 2, sizeHint);
  if (r.end + 4 > src.length) throw new Error("zlib: missing adler32");
  const want = new DataView(src.buffer, src.byteOffset + r.end, 4).getUint32(0);
  if (adler32(r.data) !== want) throw new Error("zlib: adler32 mismatch");
  return { data: r.data, end: r.end + 4 };
}

/** gzip (Content-Encoding on request bodies). */
export function gunzip(src: Uint8Array): Uint8Array {
  if (src[0] !== 0x1f || src[1] !== 0x8b || src[2] !== 8) throw new Error("gzip: bad header");
  const flg = src[3];
  let p = 10;
  if (flg & 4) p += 2 + (src[p] | (src[p + 1] << 8));
  if (flg & 8) while (src[p++] !== 0);
  if (flg & 16) while (src[p++] !== 0);
  if (flg & 2) p += 2;
  return inflateRaw(src, p).data;
}
