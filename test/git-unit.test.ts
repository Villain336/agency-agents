import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { concat, enc, toHex } from "../src/git/bytes.ts";
import { sha1Hex, hashObject } from "../src/git/sha1.ts";
import { adler32, gunzip, inflateRaw, inflateZlib, zlibEncode } from "../src/git/zlib.ts";
import { applyDelta } from "../src/git/delta.ts";
import { DELIM, FLUSH, pkt, pktText, readPkt, readPkts, sideband } from "../src/git/pkt.ts";
import { buildPack, objectId, parsePack, type GitObj } from "../src/git/pack.ts";

test("sha1 known vectors", () => {
  assert.equal(sha1Hex(enc.encode("")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(sha1Hex(enc.encode("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(
    sha1Hex(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
  );
  assert.equal(sha1Hex(new Uint8Array(1_000_000).fill(0x61)), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  // git's well-known ids
  assert.equal(hashObject("blob", new Uint8Array(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(hashObject("tree", new Uint8Array(0)), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.equal(hashObject("blob", enc.encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("sha1 matches node:crypto across lengths (padding boundaries)", () => {
  for (let n = 0; n < 260; n++) {
    const b = randomBytes(n);
    assert.equal(sha1Hex(b), createHash("sha1").update(b).digest("hex"), `len ${n}`);
  }
});

const sample = (n: number) => enc.encode(Array.from({ length: n }, (_, i) => `line ${i} of some repetitive text ${i % 7}\n`).join(""));

test("inflate round-trips real zlib output at every level/strategy", () => {
  const inputs = [new Uint8Array(0), enc.encode("a"), sample(10), sample(5000), randomBytes(70000), new Uint8Array(100000).fill(7)];
  for (const input of inputs) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE]) {
        const z = zlib.deflateSync(input, { level, strategy });
        const r = inflateZlib(z);
        assert.deepEqual(Buffer.from(r.data), Buffer.from(input));
        assert.equal(r.end, z.length);
      }
    }
  }
});

test("inflate reports consumed length when followed by other data", () => {
  const a = zlib.deflateSync(sample(300));
  const b = zlib.deflateSync(enc.encode("second"));
  const buf = concat([enc.encode("xx"), a, b]);
  const r1 = inflateZlib(buf, 2);
  assert.equal(r1.end, 2 + a.length);
  const r2 = inflateZlib(buf, r1.end);
  assert.equal(Buffer.from(r2.data).toString(), "second");
  assert.equal(r2.end, buf.length);
});

test("zlibEncode (stored blocks) is valid zlib and round-trips", () => {
  for (const n of [0, 1, 65535, 65536, 200000]) {
    const input = randomBytes(n);
    const z = zlibEncode(input);
    assert.deepEqual(zlib.inflateSync(z), input);
    assert.deepEqual(Buffer.from(inflateZlib(z).data), input);
  }
  assert.equal(adler32(enc.encode("Wikipedia")), 0x11e60398);
});

test("inflate rejects corrupt input", () => {
  const z = zlib.deflateSync(sample(100));
  z[z.length - 1] ^= 1; // adler
  assert.throws(() => inflateZlib(z));
  assert.throws(() => inflateZlib(z.subarray(0, 10)));
});

test("gunzip", () => {
  const input = sample(500);
  assert.deepEqual(Buffer.from(gunzip(zlib.gzipSync(input))), Buffer.from(input));
  assert.deepEqual(Buffer.from(inflateRaw(zlib.deflateRawSync(input)).data), Buffer.from(input));
});

test("delta application", () => {
  const base = enc.encode("hello world, hello weave");
  // src size 24, dst size 22: copy(0,6) + insert("there") + copy(13,11)
  const delta = new Uint8Array([24, 22, 0x90, 6, 5, ...enc.encode("there"), 0x91, 13, 11]);
  assert.equal(Buffer.from(applyDelta(base, delta)).toString(), "hello therehello weave");
  assert.throws(() => applyDelta(base, new Uint8Array([23, 1, 1, 0x41])), /base size/);
  assert.throws(() => applyDelta(base, new Uint8Array([24, 1, 0x91, 30, 5])), /out of range/);
});

test("pkt-line framing", () => {
  assert.equal(Buffer.from(pkt("hello\n")).toString(), "000ahello\n");
  assert.equal(Buffer.from(FLUSH).toString(), "0000");
  assert.equal(Buffer.from(DELIM).toString(), "0001");
  const buf = concat([pkt("a\n"), DELIM, pkt("b"), FLUSH, enc.encode("PACKrest")]);
  const { pkts, next } = readPkts(buf, 0, true);
  assert.deepEqual(pkts.map((p) => p.kind), ["data", "delim", "data", "flush"]);
  assert.equal(pktText(pkts[0]), "a");
  assert.equal(Buffer.from(buf.subarray(next)).toString(), "PACKrest");
  assert.equal(readPkt(new Uint8Array(0), 0), null);
  assert.throws(() => readPkt(enc.encode("zzzz"), 0));
  assert.throws(() => readPkt(enc.encode("0010ab"), 0));
  // sideband chunking
  const sb = sideband(1, new Uint8Array(150000));
  let off = 0, total = 0;
  for (let r = readPkt(sb, off); r; r = readPkt(sb, off)) {
    off = r.next;
    if (r.pkt.kind === "data") {
      assert.equal(r.pkt.data[0], 1);
      total += r.pkt.data.length - 1;
    }
  }
  assert.equal(total, 150000);
});

function sizeHdr(type: number, size: number): number[] {
  const out: number[] = [];
  let b = (type << 4) | (size & 15);
  size >>= 4;
  while (size) { out.push(b | 0x80); b = size & 0x7f; size >>= 7; }
  out.push(b);
  return out;
}

test("pack round-trip, plus ofs-delta and thin ref-delta", () => {
  const objs: GitObj[] = [
    { type: 3, data: sample(2000) },
    { type: 3, data: enc.encode("x") },
    { type: 2, data: new Uint8Array(0) },
    { type: 1, data: enc.encode("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nmsg") },
  ];
  const parsed = parsePack(buildPack(objs));
  assert.equal(parsed.size, 4);
  for (const o of objs) assert.deepEqual(Buffer.from(parsed.get(objectId(o))!.data), Buffer.from(o.data));

  // hand-built pack: base blob, ofs-delta on it, and a ref-delta against an object NOT in the pack (thin)
  const base = enc.encode("hello world, hello weave");
  const delta = new Uint8Array([24, 22, 0x90, 6, 5, ...enc.encode("there"), 0x91, 13, 11]);
  const external: GitObj = { type: 3, data: enc.encode("0123456789") };
  const delta2 = new Uint8Array([10, 4, 0x90, 4]); // copy first 4 bytes
  const e1 = concat([new Uint8Array(sizeHdr(3, base.length)), zlibEncode(base)]);
  const e2 = concat([new Uint8Array([...sizeHdr(6, delta.length), e1.length]), zlibEncode(delta)]);
  const e3 = concat([new Uint8Array(sizeHdr(7, delta2.length)), Uint8Array.from(Buffer.from(objectId(external), "hex")), zlibEncode(delta2)]);
  const head = new Uint8Array(12);
  head.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 3]);
  const body = concat([head, e1, e2, e3]);
  const pack = concat([body, Uint8Array.from(createHash("sha1").update(body).digest())]);
  assert.throws(() => parsePack(pack), /unresolved delta base/);
  const out = parsePack(pack, (id) => (id === objectId(external) ? external : undefined));
  const texts = [...out.values()].map((o) => Buffer.from(o.data).toString()).sort();
  assert.deepEqual(texts, ["0123", "hello therehello weave", "hello world, hello weave"].sort());
  // corrupt checksum
  const bad = pack.slice();
  bad[bad.length - 1] ^= 1;
  assert.throws(() => parsePack(bad, () => external), /checksum/);
  assert.equal(toHex(Buffer.from("ab")), "6162");
});
