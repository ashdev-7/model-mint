import type Anthropic from "@anthropic-ai/sdk";
import type { ToolOutcome } from "./tools.js";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type CallModel = (messages: MessageParam[]) => Promise<Message>;
export type ExecuteTool = (name: string, input: unknown) => Promise<ToolOutcome>;

export interface TurnResult {
  text: string;
  previewOf?: string;
  stlOf?: string;
  steps: number;
  stopReason: string | null;
}

function toToolResult(id: string, outcome: ToolOutcome): ToolResult {
  const content: Exclude<ToolResult["content"], string | undefined> = [{ type: "text", text: outcome.text }];
  if (outcome.png) {
    // The model gets the render it produced, so it can look and refine.
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: outcome.png.toString("base64") },
    });
  }
  return { type: "tool_result", tool_use_id: id, content, is_error: outcome.isError };
}

// The agent loop: call the model, run every tool it asked for, send all the
// results back in one user message, and repeat until it stops asking or the
// step budget runs out. History is only ever appended to.
export async function runTurn(
  history: MessageParam[],
  callModel: CallModel,
  executeTool: ExecuteTool,
  maxSteps: number
): Promise<TurnResult> {
  const texts: string[] = [];
  let previewOf: string | undefined;
  let stlOf: string | undefined;
  let stopReason: string | null = null;

  for (let step = 1; step <= maxSteps; step++) {
    const msg = await callModel(history);
    stopReason = msg.stop_reason;
    history.push({ role: "assistant", content: msg.content });

    for (const block of msg.content) {
      if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
    }

    const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (msg.stop_reason === "refusal") {
      texts.push("The model declined this request.");
      return { text: texts.join("\n\n"), previewOf, stlOf, steps: step, stopReason };
    }

    if (toolUses.length === 0) {
      if (msg.stop_reason === "max_tokens") texts.push("(The reply was cut off at the token limit.)");
      return { text: texts.join("\n\n"), previewOf, stlOf, steps: step, stopReason };
    }

    // Every tool_use must get a tool_result, or the next API call is rejected.
    const results: ToolResult[] = [];
    for (const toolUse of toolUses) {
      if (msg.stop_reason === "max_tokens") {
        // The output stopped mid-call, so the input may be incomplete. Do not run it.
        results.push(toToolResult(toolUse.id, {
          text: "Error: your reply hit the token limit before this call was complete. Send shorter code.",
          isError: true,
        }));
        continue;
      }
      const outcome = await executeTool(toolUse.name, toolUse.input);
      if (outcome.previewOf) {
        previewOf = outcome.previewOf;
        // A new preview deletes that design's old STL.
        if (stlOf === previewOf) stlOf = undefined;
      }
      if (outcome.stlOf) stlOf = outcome.stlOf;
      results.push(toToolResult(toolUse.id, outcome));
    }
    history.push({ role: "user", content: results });
  }

  texts.push(`(Stopped after ${maxSteps} tool steps. Send a message to continue.)`);
  return { text: texts.join("\n\n"), previewOf, stlOf, steps: maxSteps, stopReason };
}
