import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { CallModel, runTurn } from "./agent.js";
import { CONFIG } from "./config.js";
import { jsonSchemaFor, runTool, TOOL_DEFS, ToolName } from "./tools.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;

const SYSTEM_PROMPT = `You are ModelMint, a CAD assistant that designs 3D-printable parts in OpenSCAD.

How to work:
- Build every design with create_and_preview_model. Always send the complete code.
- After each preview, look at the returned image. If it does not match the request, fix the code and preview again before replying. Stop after a few attempts and tell the user what is still wrong.
- Use the standard library modules where they fit; plain OpenSCAD is fine for everything else.
- Combine parts with union(), cut with difference(). Units are millimetres.
- A single preview cannot show exact sizes. When the user wants the file or measured dimensions, call export_to_stl and report the bounding box it returns.
- Keep replies short: say what you built or changed.`;

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface Session {
  history: MessageParam[];
  busy: boolean;
  lastUsed: number;
}

export function createModelCaller(): CallModel {
  const client = new Anthropic({ timeout: 180_000 });
  const tools = (Object.keys(TOOL_DEFS) as ToolName[]).map((name) => ({
    name,
    description: TOOL_DEFS[name].description,
    input_schema: jsonSchemaFor(name) as Anthropic.Beta.BetaTool.InputSchema,
  }));

  return (messages) =>
    client.beta.messages.create({
      model: CONFIG.web.model,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
      output_config: { effort: "medium" },
      // On a safety decline, the API re-runs the request on a fallback model.
      ...(CONFIG.web.useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
}

export function createApp(callModel: CallModel) {
  const sessions = new Map<string, Session>();
  const sessionsDir = path.join(CONFIG.workspace, "sessions");

  function evictIdle(now: number) {
    for (const [id, s] of sessions) {
      if (!s.busy && now - s.lastUsed > CONFIG.web.sessionTtlMs) sessions.delete(id);
    }
    // Still over the cap: drop the least recently used idle sessions.
    const idle = [...sessions].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (sessions.size > CONFIG.web.maxSessions && idle.length) sessions.delete(idle.shift()![0]);
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(CONFIG.publicDir));
  // Only .png and .stl, only inside a session folder. Session ids are random UUIDs.
  app.get("/files/:sessionId/:file", (req, res) => {
    const { sessionId, file } = req.params;
    if (!SESSION_ID.test(sessionId) || !/^[A-Za-z0-9_-]+\.(png|stl)$/.test(file)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(sessionsDir, sessionId, file), { headers: { "Cache-Control": "no-store" } }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.post("/chat", async (req, res) => {
    const { message, image, sessionId } = req.body ?? {};
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
      res.status(400).json({ text: "Missing or invalid sessionId." });
      return;
    }
    if (typeof message !== "string" && !image) {
      res.status(400).json({ text: "Send a message or an image." });
      return;
    }

    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (image) {
      const match = typeof image === "string" ? image.match(IMAGE_DATA_URL) : null;
      if (!match) {
        res.status(400).json({ text: "Image must be PNG, JPEG, WebP or GIF." });
        return;
      }
      if (Buffer.byteLength(match[2], "base64") > MAX_IMAGE_BYTES) {
        res.status(400).json({ text: "Image is larger than 5 MB." });
        return;
      }
      const mediaType = match[1] as "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: match[2] } });
    }
    if (typeof message === "string" && message.trim()) content.push({ type: "text", text: message });

    const now = Date.now();
    evictIdle(now);
    let session = sessions.get(sessionId);
    if (!session) {
      session = { history: [], busy: false, lastUsed: now };
      sessions.set(sessionId, session);
    }
    // One request at a time per session: two loops writing one history corrupt it.
    if (session.busy) {
      res.status(409).json({ text: "Still working on your previous message." });
      return;
    }
    session.busy = true;
    session.lastUsed = now;

    const history = session.history;
    const checkpoint = history.length;
    const dir = path.join(sessionsDir, sessionId);

    try {
      history.push({ role: "user", content });
      const turn = await runTurn(history, callModel, (name, input) => runTool(dir, name, input), CONFIG.web.maxToolSteps);
      const version = Date.now();
      res.json({
        text: turn.text || "Done.",
        // ?v= makes the browser fetch the new render instead of a cached one.
        image: turn.previewOf ? `/files/${sessionId}/${turn.previewOf}.png?v=${version}` : null,
        model: turn.stlOf ? `/files/${sessionId}/${turn.stlOf}.stl?v=${version}` : null,
      });
    } catch (error) {
      // Undo this turn so the history stays valid for the next message.
      history.length = checkpoint;
      console.error(error);
      const status = error instanceof Anthropic.APIError && error.status ? error.status : 500;
      res.status(status >= 400 && status < 600 ? status : 500).json({
        text: `Model call failed: ${(error as Error).message}`,
      });
    } finally {
      session.busy = false;
      session.lastUsed = Date.now();
    }
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createApp(createModelCaller()).listen(CONFIG.web.port, CONFIG.web.host, () => {
    console.log(`ModelMint web app on http://${CONFIG.web.host}:${CONFIG.web.port} (model ${CONFIG.web.model})`);
  });
}
