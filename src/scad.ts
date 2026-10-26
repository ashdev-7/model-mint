import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { CONFIG } from "./config.js";
import { LIBRARY_HEADER, LIBRARY_LINE_COUNT } from "./scad_lib.js";

export type ScadErrorKind =
  | "invalid_input"
  | "not_found"
  | "openscad_missing"
  | "timeout"
  | "openscad_error";

export class ScadError extends Error {
  constructor(public kind: ScadErrorKind, message: string) {
    super(message);
  }
}

export interface PreviewResult {
  name: string;
  scadPath: string;
  pngPath: string;
  png: Buffer;
  warnings: string[];
  ms: number;
}

export interface StlStats {
  facets: number;
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface ExportResult {
  name: string;
  stlPath: string;
  stats: StlStats;
  warnings: string[];
  ms: number;
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

export function sanitizeName(filename: string): string {
  const name = filename.replace(/\.(scad|png|stl)$/i, "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!name) {
    throw new ScadError("invalid_input", `Invalid filename "${filename}". Use letters, digits, "_" or "-".`);
  }
  if (name.length > CONFIG.limits.maxNameChars) {
    throw new ScadError("invalid_input", `Filename is longer than ${CONFIG.limits.maxNameChars} characters.`);
  }
  return name;
}

// include/use/import/surface make OpenSCAD read other files from disk. The
// library is already prepended, so model code never needs them. This is a
// denylist, not a sandbox: it stops file reads, not CPU or memory abuse.
const FILE_ACCESS = /\b(include|use)\s*<|\b(import|surface)\s*\(/;

export function checkCode(code: string): void {
  if (!code.trim()) {
    throw new ScadError("invalid_input", "scad_code is empty.");
  }
  if (code.length > CONFIG.limits.maxCodeChars) {
    throw new ScadError("invalid_input", `scad_code is longer than ${CONFIG.limits.maxCodeChars} characters.`);
  }
  if (FILE_ACCESS.test(code)) {
    throw new ScadError(
      "invalid_input",
      "include, use, import() and surface() are not allowed: the standard library is already included and files outside the workspace cannot be read."
    );
  }
}

// ---------------------------------------------------------------------------
// OpenSCAD process
// ---------------------------------------------------------------------------

function runOpenscad(args: string[], timeoutMs: number, displayName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      CONFIG.openscad.bin,
      args,
      { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) return resolve(cleanStderr(stderr, displayName));
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return reject(new ScadError(
            "openscad_missing",
            `OpenSCAD not found ("${CONFIG.openscad.bin}"). Install it and add it to PATH, or set OPENSCAD_BIN.`
          ));
        }
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new ScadError(
            "openscad_error",
            "OpenSCAD printed more than 5 MB of output and was stopped. Remove echo() calls inside loops."
          ));
        }
        if (err.killed) {
          return reject(new ScadError(
            "timeout",
            `OpenSCAD was stopped after ${timeoutMs / 1000}s. Simplify the model: lower $fn, avoid minkowski() and hull() on detailed shapes.`
          ));
        }
        reject(new ScadError("openscad_error", shorten(cleanStderr(stderr, displayName)) || err.message));
      }
    );
  });
}

// OpenSCAD reports line numbers in the full file; subtract the library so
// they match the code the model wrote.
function mapLineNumbers(text: string): string {
  return text.replace(/line (\d+)/g, (match, n) => {
    const line = Number(n) - LIBRARY_LINE_COUNT;
    return line > 0 ? `line ${line}` : `${match} (inside the standard library)`;
  });
}

// Progress and cache statistics OpenSCAD prints on every run.
const NOISE = [
  "Can't parse file", "Geometries in cache", "Geometry cache size", "CGAL ", "Total rendering time",
  "Compiling design", "Rendering Polygon Mesh", "Normalized CSG tree", "Simple:", "Vertices:", "Halfedges:",
  "Edges:", "Halffacets:", "Facets:", "Volumes:", "Top level object is", "Rendering finished", "Saved",
];

// Also shows the design's own file name instead of the temporary path.
function cleanStderr(stderr: string, displayName: string): string {
  return mapLineNumbers(
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !NOISE.some((prefix) => line.startsWith(prefix)))
      .map((line) => line.replace(/in file [^,]*\.scad,/g, `in file ${displayName},`))
      .join("\n")
  );
}

// Long output is mostly echo() lines; keep the errors and warnings, then cut.
export function shorten(text: string): string {
  const max = CONFIG.limits.maxErrorChars;
  if (text.length <= max) return text;
  const important = text.split("\n").filter((line) => /^(ERROR|WARNING)/.test(line)).join("\n");
  return `${(important || text).slice(0, max)}\n... (output cut, ${text.length} characters in total)`;
}

const MAX_WARNINGS = 20;

// Expects stderr that has already been through cleanStderr. Includes ERROR
// lines: some runtime errors, such as a failed assert(), still exit with 0.
export function extractWarnings(stderr: string): string[] {
  const lines = stderr
    .split("\n")
    .filter((line) => /^(ERROR|WARNING|DEPRECATED)/.test(line) || line.includes("top level object is empty"));
  if (lines.length <= MAX_WARNINGS) return lines;
  return [...lines.slice(0, MAX_WARNINGS), `... and ${lines.length - MAX_WARNINGS} more`];
}

// ---------------------------------------------------------------------------
// Per-design lock: two requests for the same file run one after the other
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Preview and export
// ---------------------------------------------------------------------------

// Render into temporary files and only replace the design when the render
// succeeds, so a failed attempt never destroys the last good version.
export async function createPreview(dir: string, filename: string, code: string): Promise<PreviewResult> {
  const name = sanitizeName(filename);
  checkCode(code);
  await fs.mkdir(dir, { recursive: true });

  return withLock(path.join(dir, name), async () => {
    const started = Date.now();
    const tmp = path.join(dir, `.${name}.${randomUUID()}`);
    const tmpScad = `${tmp}.scad`;
    const tmpPng = `${tmp}.png`;
    const scadPath = path.join(dir, `${name}.scad`);
    const pngPath = path.join(dir, `${name}.png`);

    try {
      await fs.writeFile(tmpScad, LIBRARY_HEADER + code);
      const stderr = await runOpenscad(
        [
          "-o", tmpPng,
          "--viewall", "--autocenter",
          `--imgsize=${CONFIG.openscad.imageSize}`,
          `--colorscheme=${CONFIG.openscad.colorScheme}`,
          tmpScad,
        ],
        CONFIG.openscad.previewTimeoutMs,
        `${name}.scad`
      );
      const png = await fs.readFile(tmpPng);
      await fs.rename(tmpScad, scadPath);
      await fs.rename(tmpPng, pngPath);
      // An old STL no longer matches the new source.
      await fs.rm(path.join(dir, `${name}.stl`), { force: true });
      return { name, scadPath, pngPath, png, warnings: extractWarnings(stderr), ms: Date.now() - started };
    } finally {
      await fs.rm(tmpScad, { force: true });
      await fs.rm(tmpPng, { force: true });
    }
  });
}

export async function exportStl(dir: string, filename: string): Promise<ExportResult> {
  const name = sanitizeName(filename);
  const scadPath = path.join(dir, `${name}.scad`);
  const stlPath = path.join(dir, `${name}.stl`);

  return withLock(path.join(dir, name), async () => {
    try {
      await fs.access(scadPath);
    } catch {
      throw new ScadError("not_found", `No design named "${name}". Call create_and_preview_model first.`);
    }
    const started = Date.now();
    const tmpStl = path.join(dir, `.${name}.${randomUUID()}.stl`);
    try {
      const stderr = await runOpenscad(["-o", tmpStl, scadPath], CONFIG.openscad.exportTimeoutMs, `${name}.scad`);
      const stats = parseStl(await fs.readFile(tmpStl));
      if (stats.facets === 0) {
        throw new ScadError("openscad_error", "The exported mesh is empty: the model has no solid geometry.");
      }
      await fs.rename(tmpStl, stlPath);
      return { name, stlPath, stats, warnings: extractWarnings(stderr), ms: Date.now() - started };
    } finally {
      await fs.rm(tmpStl, { force: true });
    }
  });
}

export async function readSource(dir: string, filename: string): Promise<string> {
  const name = sanitizeName(filename);
  try {
    const text = await fs.readFile(path.join(dir, `${name}.scad`), "utf-8");
    return text.startsWith(LIBRARY_HEADER) ? text.slice(LIBRARY_HEADER.length) : text;
  } catch {
    throw new ScadError("not_found", `No design named "${name}".`);
  }
}

export async function listDesigns(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".scad") && !f.startsWith("."))
      .map((f) => f.slice(0, -".scad".length))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// STL parsing (ASCII and binary) for facet count and bounding box
// ---------------------------------------------------------------------------

export function parseStl(data: Buffer): StlStats {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let facets = 0;

  const visit = (x: number, y: number, z: number) => {
    const p = [x, y, z];
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  };

  const binaryCount = data.length >= 84 ? data.readUInt32LE(80) : -1;
  const isBinary = binaryCount >= 0 && data.length === 84 + binaryCount * 50;

  if (isBinary) {
    facets = binaryCount;
    for (let f = 0; f < facets; f++) {
      const base = 84 + f * 50 + 12;
      for (let v = 0; v < 3; v++) {
        const o = base + v * 12;
        visit(data.readFloatLE(o), data.readFloatLE(o + 4), data.readFloatLE(o + 8));
      }
    }
  } else {
    const text = data.toString("utf-8");
    facets = (text.match(/\bfacet\s+normal\b/g) || []).length;
    const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = vertex.exec(text))) visit(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  if (facets === 0) {
    return { facets: 0, min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    facets,
    min: min.map(round) as [number, number, number],
    max: max.map(round) as [number, number, number],
    size: [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])],
  };
}
