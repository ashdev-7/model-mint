import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "../agent.js";
import type { ToolOutcome } from "../tools.js";

type Msg = Anthropic.Beta.BetaMessage;
type Param = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

// A fake model that returns scripted replies, so the loop is tested without an API key.
function reply(stop_reason: string, content: unknown[]): Msg {
  return { id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason, stop_sequence: null, usage: {} } as unknown as Msg;
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

function scripted(replies: Msg[]) {
  return async (_messages: Param[]) => {
    const next = replies.shift();
    if (!next) throw new Error("model called too many times");
    return next;
  };
}

const okTool = async (name: string): Promise<ToolOutcome> =>
  name === "create_and_preview_model"
    ? { text: "Saved a.scad", isError: false, png: Buffer.from("png"), previewOf: "a" }
    : { text: "Exported a.stl", isError: false, stlOf: "a" };

test("two parallel tool calls both get results in one user message, then the loop continues", async () => {
  const model = scripted([
    reply("tool_use", [text("Making two parts."), toolUse("t1", "create_and_preview_model", {}), toolUse("t2", "create_and_preview_model", {})]),
    reply("end_turn", [text("Both done.")]),
  ]);
  const history: Param[] = [{ role: "user", content: "two cubes" }];
  const turn = await runTurn(history, model, okTool, 6);

  assert.equal(turn.steps, 2);
  assert.equal(turn.text, "Making two parts.\n\nBoth done.");
  assert.equal(history[2].role, "user");
  const results = history[2].content as ToolResult[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ["t1", "t2"]);
  // The render goes back to the model as an image.
  const blocks = results[0].content as Array<{ type: string }>;
  assert.deepEqual(blocks.map((b) => b.type), ["text", "image"]);
  assert.equal(turn.previewOf, "a");
});

test("a tool error goes back to the model with is_error and the model can retry", async () => {
  const model = scripted([
    reply("tool_use", [toolUse("t1", "create_and_preview_model", {})]),
    reply("tool_use", [toolUse("t2", "create_and_preview_model", {})]),
    reply("end_turn", [text("Fixed.")]),
  ]);
  let calls = 0;
  const flaky = async (): Promise<ToolOutcome> =>
    ++calls === 1 ? { text: "Error: Parser error line 2", isError: true } : { text: "ok", isError: false, previewOf: "a" };
  const history: Param[] = [{ role: "user", content: "cube" }];
  const turn = await runTurn(history, model, flaky, 6);
  assert.equal((history[2].content as ToolResult[])[0].is_error, true);
  assert.equal(turn.text, "Fixed.");
  assert.equal(turn.steps, 3);
});

test("a tool call cut off by max_tokens is answered with an error and not executed", async () => {
  const model = scripted([
    reply("max_tokens", [toolUse("t1", "create_and_preview_model", { filename: "a" })]),
    reply("end_turn", [text("Shorter version sent.")]),
  ]);
  let executed = 0;
  const history: Param[] = [{ role: "user", content: "huge" }];
  await runTurn(history, model, async () => { executed++; return { text: "", isError: false }; }, 6);
  assert.equal(executed, 0);
  assert.equal((history[2].content as ToolResult[])[0].is_error, true);
});

test("the loop stops at the step budget", async () => {
  const model = scripted(Array.from({ length: 3 }, (_, i) => reply("tool_use", [toolUse(`t${i}`, "create_and_preview_model", {})])));
  const turn = await runTurn([{ role: "user", content: "loop" }], model, okTool, 3);
  assert.equal(turn.steps, 3);
  assert.match(turn.text, /Stopped after 3 tool steps/);
});

test("a refusal ends the turn with a message", async () => {
  const turn = await runTurn([{ role: "user", content: "x" }], scripted([reply("refusal", [])]), okTool, 6);
  assert.equal(turn.text, "The model declined this request.");
});

test("an export followed by a new preview of the same design drops the stale STL link", async () => {
  const model = scripted([
    reply("tool_use", [toolUse("t1", "export_to_stl", {})]),
    reply("tool_use", [toolUse("t2", "create_and_preview_model", {})]),
    reply("end_turn", [text("ok")]),
  ]);
  const turn = await runTurn([{ role: "user", content: "x" }], model, okTool, 6);
  assert.equal(turn.stlOf, undefined);
  assert.equal(turn.previewOf, "a");
});
