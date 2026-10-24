import assert from "node:assert/strict";
import path from "path";
import { test } from "node:test";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hasOpenscad, tempDir } from "./helpers.js";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");

type Content = Array<{ type: string; text?: string; mimeType?: string }>;

// Starts build/mcp.js as a child process and talks to it over stdio, the way
// Claude Desktop does.
async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, MODELMINT_WORKSPACE: tempDir() } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

test("MCP server lists its four tools with schemas", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["create_and_preview_model", "export_to_stl", "list_models", "read_model_source"]
    );
    const create = tools.find((t) => t.name === "create_and_preview_model")!;
    assert.deepEqual(create.inputSchema.required, ["filename", "scad_code"]);
  } finally {
    await client.close();
  }
});

test("MCP: preview returns an image, export returns dimensions, errors use isError", { skip: hasOpenscad() ? false : "OpenSCAD not installed" }, async () => {
  const client = await connect();
  try {
    const preview = await client.callTool({
      name: "create_and_preview_model",
      arguments: { filename: "cup", scad_code: "Tube(40, 20, 2);" },
    });
    const content = preview.content as Content;
    assert.equal(preview.isError, false);
    assert.deepEqual(content.map((c) => c.type), ["text", "image"]);
    assert.equal(content[1].mimeType, "image/png");

    const exported = await client.callTool({ name: "export_to_stl", arguments: { filename: "cup" } });
    assert.match((exported.content as Content)[0].text!, /Bounding box: 40 x 40 x 40 mm/);

    const bad = await client.callTool({ name: "create_and_preview_model", arguments: { filename: "bad", scad_code: "cube(" } });
    assert.equal(bad.isError, true);
    assert.match((bad.content as Content)[0].text!, /Parser error/);

    const listed = await client.callTool({ name: "list_models", arguments: {} });
    assert.equal((listed.content as Content)[0].text, "cup");
  } finally {
    await client.close();
  }
});
