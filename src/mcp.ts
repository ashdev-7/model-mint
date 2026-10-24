#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "./config.js";
import { runTool, TOOL_DEFS, ToolName, ToolOutcome } from "./tools.js";

// stdout carries the JSON-RPC stream. Anything printed there corrupts the
// protocol, so every log in this process goes to stderr.
console.log = console.error;

function toMcpResult(outcome: ToolOutcome) {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: outcome.text },
  ];
  if (outcome.png) {
    content.push({ type: "image", data: outcome.png.toString("base64"), mimeType: "image/png" });
  }
  // isError: the call reached the tool and failed. The model sees the message
  // and can fix its code; it is not a protocol error.
  return { content, isError: outcome.isError };
}

const server = new McpServer({ name: "modelmint", version: "3.0.0" });

const annotations: Record<ToolName, { readOnlyHint: boolean; destructiveHint?: boolean }> = {
  create_and_preview_model: { readOnlyHint: false, destructiveHint: true },
  export_to_stl: { readOnlyHint: false, destructiveHint: false },
  read_model_source: { readOnlyHint: true },
  list_models: { readOnlyHint: true },
};

for (const name of Object.keys(TOOL_DEFS) as ToolName[]) {
  const def = TOOL_DEFS[name];
  server.registerTool(
    name,
    { description: def.description, inputSchema: def.shape, annotations: annotations[name] },
    async (args: unknown) => toMcpResult(await runTool(CONFIG.workspace, name, args))
  );
}

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`ModelMint MCP server on stdio. Workspace: ${CONFIG.workspace}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
