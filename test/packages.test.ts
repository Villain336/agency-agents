import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo } from "../src/repo.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("publish, list, fetch and immutability", () => {
  const r = new Repo();
  const p = r.publishPackage({ name: "left-pad", version: "1.0.0", description: "pads", files: [{ name: "left-pad-1.0.0.tgz", contentBase64: b64("tarball") }] }, "ci");
  assert.equal(p.version, "1.0.0");
  assert.equal(p.files[0].size, 7);
  assert.equal(p.files[0].sha256.length, 64);
  assert.equal(p.files[0].contentBase64, undefined, "metadata does not carry the bytes");
  r.publishPackage({ name: "left-pad", version: "1.1.0", files: [{ name: "a.txt", contentBase64: b64("x") }] }, "ci");
  assert.throws(() => r.publishPackage({ name: "left-pad", version: "1.0.0", files: [{ name: "a", contentBase64: b64("y") }] }, "ci"), /already exists/);
  const list = r.listPackages();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { name: "left-pad", latest: "1.1.0", versions: ["1.1.0", "1.0.0"], description: "pads", updatedAt: list[0].updatedAt });
  assert.equal(Buffer.from(r.packageFile("left-pad", "1.0.0", "left-pad-1.0.0.tgz").contentBase64, "base64").toString(), "tarball");
  assert.throws(() => r.getPackageVersion("left-pad", "9.9.9"), /no such version/);
  assert.throws(() => r.packageFile("left-pad", "1.0.0", "nope"), /no such file/);
});

test("validation: names, semver, file names, sizes, base64", () => {
  const r = new Repo();
  const f = [{ name: "a.txt", contentBase64: b64("x") }];
  assert.throws(() => r.publishPackage({ name: "Bad Name", version: "1.0.0", files: f }, "a"), /package name/);
  assert.throws(() => r.publishPackage({ name: "ok", version: "latest", files: f }, "a"), /version/);
  assert.throws(() => r.publishPackage({ name: "ok", version: "1.0.0", files: [] }, "a"), /at least one file/);
  assert.throws(() => r.publishPackage({ name: "ok", version: "1.0.0", files: [{ name: "../x", contentBase64: b64("x") }] }, "a"), /file name/);
  assert.throws(() => r.publishPackage({ name: "ok", version: "1.0.0", files: [{ name: "a", contentBase64: "!!!" }] }, "a"), /base64/);
  assert.throws(() => r.publishPackage({ name: "ok", version: "1.0.0", files: [{ name: "a", contentBase64: Buffer.alloc(1_200_000).toString("base64") }] }, "a"), /too large/);
});

test("latest follows semver order, not publish order; prerelease never becomes latest; yank hides a version", () => {
  const r = new Repo();
  const f = [{ name: "a", contentBase64: b64("x") }];
  for (const v of ["1.10.0", "1.2.0", "2.0.0-beta.1"]) r.publishPackage({ name: "p", version: v, files: f }, "a");
  assert.equal(r.listPackages()[0].latest, "1.10.0");
  r.yankPackageVersion("p", "1.10.0", "a", "broken");
  assert.equal(r.listPackages()[0].latest, "1.2.0");
  assert.equal(r.getPackageVersion("p", "1.10.0").yanked, "broken", "still fetchable by exact version");
});

test("sha256 is of the real bytes", () => {
  const r = new Repo();
  const p = r.publishPackage({ name: "x", version: "1.0.0", files: [{ name: "a", contentBase64: b64("abc") }] }, "a");
  assert.equal(p.files[0].sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
