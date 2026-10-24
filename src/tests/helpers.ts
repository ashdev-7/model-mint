import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { CONFIG } from "../config.js";

export function hasOpenscad(): boolean {
  try {
    execFileSync(CONFIG.openscad.bin, ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modelmint-test-"));
}
