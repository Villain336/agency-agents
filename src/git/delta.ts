// Delta application (OFS_DELTA / REF_DELTA pack entries).
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  const varint = (): number => {
    let v = 0, shift = 0, b: number;
    do {
      if (p >= delta.length) throw new Error("delta: truncated header");
      b = delta[p++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const srcSize = varint();
  const dstSize = varint();
  if (srcSize !== base.length) throw new Error("delta: base size mismatch");
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (p < delta.length) {
    const cmd = delta[p++];
    if (cmd & 0x80) {
      let off = 0, size = 0;
      for (let i = 0; i < 4; i++) if (cmd & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i++) if (cmd & (0x10 << i)) size |= delta[p++] << (8 * i);
      off >>>= 0;
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new Error("delta: copy out of range");
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (cmd) {
      if (p + cmd > delta.length || o + cmd > dstSize) throw new Error("delta: insert out of range");
      out.set(delta.subarray(p, p + cmd), o);
      p += cmd;
      o += cmd;
    } else throw new Error("delta: reserved opcode 0");
  }
  if (o !== dstSize) throw new Error("delta: result size mismatch");
  return out;
}
