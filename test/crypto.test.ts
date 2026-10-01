import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { sha256, hmacSha256, canonical } from "../src/crypto.ts";

test("sha256 matches node:crypto, including multi-block and unicode", () => {
  for (const s of ["", "abc", "héllo wörld ✓", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000), randomBytes(333).toString("latin1")])
    assert.equal(sha256(s), createHash("sha256").update(s).digest("hex"));
});

test("hmac matches node:crypto, including long keys", () => {
  for (const k of ["k", "secret key", "z".repeat(100)])
    assert.equal(hmacSha256(k, "payload ✓"), createHmac("sha256", k).update("payload ✓").digest("hex"));
});

test("canonical json is order independent", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), canonical({ a: [2, { d: 1 }], b: 1 }));
});
