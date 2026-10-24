# ModelMint

Conversational 3D CAD. Describe an object in plain language; Claude writes OpenSCAD code, looks at a rendered preview, refines it, and exports a 3D-printable `.stl`.

The same tools are available two ways:

| Entry point | Who runs the agent loop | Use it for |
|---|---|---|
| `build/mcp.js`: MCP server over stdio | Claude Desktop (or any MCP host) | Designing inside Claude Desktop |
| `build/web.js`: Express web app | This server, calling the Claude API | A browser UI with sketch upload and a 3D viewer |

```
Claude Desktop ──stdio JSON-RPC──► mcp.js ─┐
                                           ├─► tools.ts ─► scad.ts ─► openscad (PNG / STL)
Browser ──POST /chat──► web.js ─► agent.ts ┘                    │
                          └── Claude API (tool loop)            workspace/
```

## Tools

| Tool | What it does |
|---|---|
| `create_and_preview_model` | Saves the full `.scad` source (with the standard library prepended) and renders a PNG. Returns the image to the model so it can check its work. A failed render keeps the last good version. |
| `export_to_stl` | Exports the saved design to `.stl` and returns the bounding box in mm, facet count and mesh warnings. |
| `read_model_source` | Returns the current source of a design. |
| `list_models` | Lists saved designs. |

The standard library (`src/scad_lib.ts`) provides `Tube`, `SoftBox` and `ArcHandle`.

## Requirements

- Node.js 20 or later
- OpenSCAD on `PATH` (or set `OPENSCAD_BIN` to its full path). On Windows the server calls `openscad.exe`, because `openscad.com` swallows error output.

## Setup

```bash
npm install
npm run build
npm test
```

The tests need OpenSCAD; the ones that render are skipped without it. They use a fake model, so no API key is needed.

### Claude Desktop

Add this to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), with the absolute path to `build/mcp.js`:

```json
{
  "mcpServers": {
    "modelmint": {
      "command": "node",
      "args": ["C:\\path\\to\\ModelMint\\build\\mcp.js"]
    }
  }
}
```

Fully quit Claude Desktop (from the system tray or Task Manager) and start it again. Files are written to `workspace/` in the project folder.

To test the server without Claude Desktop:

```bash
npx @modelcontextprotocol/inspector node build/mcp.js
```

### Web app

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm run web
```

Open http://127.0.0.1:3000. Each browser session gets its own folder under `workspace/sessions/`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPENSCAD_BIN` | `openscad.exe` on Windows, else `openscad` | OpenSCAD executable |
| `MODELMINT_WORKSPACE` | `<project>/workspace` | Output folder |
| `MODELMINT_PREVIEW_TIMEOUT_MS` | `60000` | Kill a PNG render after this long |
| `MODELMINT_EXPORT_TIMEOUT_MS` | `180000` | Kill an STL export after this long |
| `MODELMINT_IMAGE_SIZE` | `800,800` | Preview size in pixels |
| `MODELMINT_MODEL` | `claude-opus-5-5` | Model for the web app |
| `MODELMINT_FALLBACKS` | on | `off` disables the API's server-side refusal fallback |
| `MODELMINT_MAX_TOOL_STEPS` | `6` | Tool rounds per user message in the web app |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Web app address |

## Limits

- OpenSCAD runs model-written code on your machine. `include`, `use`, `import()` and `surface()` are rejected so the code cannot read other files, and every run has a timeout, but there is no CPU or memory sandbox. Do not expose the web app to the internet as it is.
- Web sessions live in memory and are lost on restart.
- The preview is one auto-fitted view; exact sizes come from `export_to_stl`.
- `frontend/` is an unconnected React prototype; the web app serves `public/index.html`.
