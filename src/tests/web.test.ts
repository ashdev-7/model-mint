import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Point the app at a temp workspace before it loads CONFIG.
process.env.MODELMINT_WORKSPACE = (await import("./helpers.js")).tempDir();
const { createApp } = await import("../web.js");

type Msg = Anthropic.Beta.BetaMessage;
type CallModel = (m: Anthropic.Beta.BetaMessageParam[]) => Promise<Msg>;

async function start(callModel: CallModel) {
  const server = createApp(callModel).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const endTurn = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) as unknown as Msg;

const post = (url: string, body: unknown) =>
  fetch(`${url}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("/chat validates the session id and image type", async () => {
  const { server, url } = await start(async () => endTurn("hi"));
  try {
    assert.equal((await post(url, { message: "hi" })).status, 400);
    assert.equal((await post(url, { sessionId: "../../etc", message: "hi" })).status, 400);
    assert.equal((await post(url, { sessionId: "abcdefgh12", image: "data:text/html;base64,PGI+" })).status, 400);
    const ok = await post(url, { sessionId: "abcdefgh12", message: "hi" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).text, "hi");
  } finally {
    server.close();
  }
});

test("a second message while the first is running gets 409", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { server, url } = await start(async () => { await gate; return endTurn("done"); });
  try {
    const first = post(url, { sessionId: "session-busy", message: "one" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await post(url, { sessionId: "session-busy", message: "two" })).status, 409);
    release();
    assert.equal((await first).status, 200);
  } finally {
    server.close();
  }
});

test("a failed model call rolls the history back", async () => {
  let fail = true;
  const seen: number[] = [];
  const { server, url } = await start(async (messages) => {
    seen.push(messages.length);
    if (fail) { fail = false; throw new Error("boom"); }
    return endTurn("ok");
  });
  try {
    assert.equal((await post(url, { sessionId: "session-roll", message: "one" })).status, 500);
    assert.equal((await post(url, { sessionId: "session-roll", message: "two" })).status, 200);
    // The second call saw only its own user message, not the failed first one.
    assert.deepEqual(seen, [1, 1]);
  } finally {
    server.close();
  }
});

test("/files only serves png and stl inside a session folder", async () => {
  const { server, url } = await start(async () => endTurn("x"));
  try {
    assert.equal((await fetch(`${url}/files/abcdefgh12/a.scad`)).status, 404);
    assert.equal((await fetch(`${url}/files/abcdefgh12/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${url}/files/abcdefgh12/missing.png`)).status, 404);
  } finally {
    server.close();
  }
});
