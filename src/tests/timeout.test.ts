import assert from "node:assert/strict";
import { test } from "node:test";

// CONFIG reads the timeout when it is first imported, so set it before any
// project module loads (node --test runs each file in its own process).
process.env.MODELMINT_PREVIEW_TIMEOUT_MS = "1500";
const { hasOpenscad, tempDir } = await import("./helpers.js");
const { createPreview } = await import("../scad.js");

test("a render that runs too long is killed and reported as timeout", { skip: hasOpenscad() ? false : "OpenSCAD not installed" }, async () => {
  const started = Date.now();
  await assert.rejects(
    createPreview(tempDir(), "slow", "$fn=300; minkowski() { sphere(20); cube(30); rotate([10,20,30]) cube(20); }"),
    (err: { kind: string }) => err.kind === "timeout"
  );
  assert.ok(Date.now() - started < 10_000);
});
