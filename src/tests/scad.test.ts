import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { test } from "node:test";
import { checkCode, createPreview, exportStl, parseStl, readSource, sanitizeName, ScadError } from "../scad.js";
import { hasOpenscad, tempDir } from "./helpers.js";

const skip = hasOpenscad() ? false : "OpenSCAD not installed";

test("sanitizeName strips unsafe characters and extensions", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeName("mug.scad"), "mug");
  assert.equal(sanitizeName("my box!"), "mybox");
  assert.throws(() => sanitizeName("!!!"), ScadError);
  assert.throws(() => sanitizeName("a".repeat(65)), ScadError);
});

test("checkCode rejects file access and empty code", () => {
  assert.throws(() => checkCode("include </etc/passwd>"), /not allowed/);
  assert.throws(() => checkCode("use <lib.scad>\ncube(1);"), /not allowed/);
  assert.throws(() => checkCode('import("C:/secret.stl");'), /not allowed/);
  assert.throws(() => checkCode("   "), /empty/);
  assert.doesNotThrow(() => checkCode("cube(10); // imported idea"));
});

test("parseStl reads ASCII and binary STL", () => {
  const ascii = Buffer.from(
    "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 20 5\nendloop\nendfacet\nendsolid t\n"
  );
  assert.deepEqual(parseStl(ascii), { facets: 1, min: [0, 0, 0], max: [10, 20, 5], size: [10, 20, 5] });

  const bin = Buffer.alloc(84 + 50);
  bin.writeUInt32LE(1, 80);
  [[0, 0, 0], [4, 0, 0], [0, 6, 2]].forEach((v, i) => v.forEach((n, j) => bin.writeFloatLE(n, 84 + 12 + i * 12 + j * 4)));
  assert.deepEqual(parseStl(bin).size, [4, 6, 2]);
  assert.equal(parseStl(Buffer.from("solid empty\nendsolid empty\n")).facets, 0);
});

test("preview then export a cube: files, image and exact size", { skip }, async () => {
  const dir = tempDir();
  const preview = await createPreview(dir, "box", "cube([20, 30, 10]);");
  assert.ok(preview.png.subarray(1, 4).equals(Buffer.from("PNG")));
  assert.equal(await readSource(dir, "box"), "cube([20, 30, 10]);");

  const exported = await exportStl(dir, "box");
  assert.deepEqual(exported.stats.size, [20, 30, 10]);
  assert.ok(fs.existsSync(path.join(dir, "box.stl")));
  // No temporary files left behind.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["box.png", "box.scad", "box.stl"]);
});

test("a failed edit keeps the last good design", { skip }, async () => {
  const dir = tempDir();
  await createPreview(dir, "part", "cube(5);");
  await assert.rejects(createPreview(dir, "part", "cube(5)\nsphere(;"), (err: ScadError) => {
    assert.equal(err.kind, "openscad_error");
    // Line number refers to the model's code and the name is the design's, not the temp file's.
    assert.match(err.message, /in file part\.scad, line 2/);
    return true;
  });
  assert.equal(await readSource(dir, "part"), "cube(5);");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["part.png", "part.scad"]);
});

test("a new preview removes the stale STL", { skip }, async () => {
  const dir = tempDir();
  await createPreview(dir, "p", "cube(5);");
  await exportStl(dir, "p");
  await createPreview(dir, "p", "cube(6);");
  assert.ok(!fs.existsSync(path.join(dir, "p.stl")));
});

test("empty geometry previews as a blank image but fails on export", { skip }, async () => {
  const dir = tempDir();
  await createPreview(dir, "empty", "difference() { cube(10); cube(10); }");
  await assert.rejects(exportStl(dir, "empty"), (err: ScadError) => {
    assert.equal(err.message, "Current top level object is empty.");
    return true;
  });
});

test("export of an unknown design is not_found", async () => {
  await assert.rejects(exportStl(tempDir(), "ghost"), (err: ScadError) => err.kind === "not_found");
});
