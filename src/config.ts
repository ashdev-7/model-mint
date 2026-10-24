import path from "path";
import { fileURLToPath } from "url";

// Resolve paths from this file, not process.cwd(): Claude Desktop launches
// MCP servers from its own working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");

function intFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const CONFIG = {
  workspace: process.env.MODELMINT_WORKSPACE || path.join(PROJECT_ROOT, "workspace"),
  publicDir: path.join(PROJECT_ROOT, "public"),
  openscad: {
    // On Windows, plain "openscad" resolves to openscad.com, a wrapper that
    // swallows stderr and leaves openscad.exe running when killed.
    bin: process.env.OPENSCAD_BIN || (process.platform === "win32" ? "openscad.exe" : "openscad"),
    imageSize: process.env.MODELMINT_IMAGE_SIZE || "800,800",
    colorScheme: "Cornfield",
    previewTimeoutMs: intFromEnv("MODELMINT_PREVIEW_TIMEOUT_MS", 60_000),
    exportTimeoutMs: intFromEnv("MODELMINT_EXPORT_TIMEOUT_MS", 180_000),
  },
  limits: {
    maxCodeChars: 100_000,
    maxNameChars: 64,
  },
  web: {
    host: process.env.HOST || "127.0.0.1",
    port: intFromEnv("PORT", 3000),
    model: process.env.MODELMINT_MODEL || "claude-opus-5-5",
    useFallbacks: process.env.MODELMINT_FALLBACKS !== "off",
    maxToolSteps: intFromEnv("MODELMINT_MAX_TOOL_STEPS", 6),
    sessionTtlMs: intFromEnv("MODELMINT_SESSION_TTL_MS", 60 * 60 * 1000),
    maxSessions: intFromEnv("MODELMINT_MAX_SESSIONS", 100),
  },
} as const;
