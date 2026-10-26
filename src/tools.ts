import { z } from "zod/v4";
import { SCAD_LIBRARY_DOC } from "./scad_lib.js";
import { createPreview, exportStl, listDesigns, readSource, ScadError } from "./scad.js";

// One definition of each tool, shared by the MCP server and the web app.
// The Zod schemas validate input and also generate the JSON Schema the model reads.

const filename = z
  .string()
  .min(1)
  .describe('Design name without extension, e.g. "phone_stand". Letters, digits, "_" and "-". Reusing a name replaces that design.');

export const TOOL_DEFS = {
  create_and_preview_model: {
    description: [
      "Save OpenSCAD source for a design and render a PNG preview of it. Returns the image so you can check the shape.",
      "Use it for every new design and for every change to one. Always send the COMPLETE code, not a diff.",
      "Units are millimetres. The preview is a single auto-fitted view: it does not show exact dimensions; call export_to_stl when you need measured sizes.",
      "Do not use include, use, import() or surface(); they are rejected.",
      SCAD_LIBRARY_DOC,
    ].join("\n"),
    shape: {
      filename,
      scad_code: z.string().min(1).describe("The complete OpenSCAD code for the design."),
    },
  },
  export_to_stl: {
    description:
      "Export a design that already has a preview to a 3D-printable .stl file. Slow (often 10-60 s). " +
      "Use it when the user is happy with the design or asks for the file or for measured dimensions. " +
      "Returns the bounding-box size in mm, the facet count and any mesh warnings.",
    shape: { filename },
  },
  read_model_source: {
    description:
      "Return the current OpenSCAD source of a saved design (without the standard library). " +
      "Use it before editing a design whose code is not in the conversation.",
    shape: { filename },
  },
  list_models: {
    description: "List the names of the saved designs.",
    shape: {},
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFS;

export interface ToolOutcome {
  text: string;
  isError: boolean;
  png?: Buffer;
  // Names of files written by this call, for the web UI.
  previewOf?: string;
  stlOf?: string;
}

export function jsonSchemaFor(name: ToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(TOOL_DEFS[name].shape)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function errorOutcome(err: unknown): ToolOutcome {
  if (err instanceof ScadError) return { text: `Error (${err.kind}): ${err.message}`, isError: true };
  return { text: `Error: ${(err as Error)?.message ?? String(err)}`, isError: true };
}

function warningText(warnings: string[]): string {
  return warnings.length ? `\nOpenSCAD messages:\n${warnings.join("\n")}` : "";
}

export async function runTool(dir: string, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!(name in TOOL_DEFS)) return { text: `Error: unknown tool "${name}".`, isError: true };
  const toolName = name as ToolName;
  const parsed = z.object(TOOL_DEFS[toolName].shape).safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { text: `Error (invalid_input): ${z.prettifyError(parsed.error)}`, isError: true };
  }
  const input = parsed.data as Record<string, string>;

  try {
    switch (toolName) {
      case "create_and_preview_model": {
        const r = await createPreview(dir, input.filename, input.scad_code);
        return {
          text: `Saved ${r.name}.scad and rendered ${r.name}.png in ${(r.ms / 1000).toFixed(1)}s.${warningText(r.warnings)}`,
          isError: false,
          png: r.png,
          previewOf: r.name,
        };
      }
      case "export_to_stl": {
        const r = await exportStl(dir, input.filename);
        const [x, y, z] = r.stats.size;
        return {
          text:
            `Exported ${r.name}.stl in ${(r.ms / 1000).toFixed(1)}s.\n` +
            `Bounding box: ${x} x ${y} x ${z} mm (X x Y x Z), min [${r.stats.min.join(", ")}], max [${r.stats.max.join(", ")}].\n` +
            `Facets: ${r.stats.facets}.${warningText(r.warnings)}`,
          isError: false,
          stlOf: r.name,
        };
      }
      case "read_model_source":
        return { text: await readSource(dir, input.filename), isError: false };
      case "list_models": {
        const names = await listDesigns(dir);
        return { text: names.length ? names.join("\n") : "No designs yet.", isError: false };
      }
    }
  } catch (err) {
    return errorOutcome(err);
  }
}
