import { describe, expect, it } from "vitest";
import S from "../../eval/agent/studio-schemas-3.0.0.json";
import { flatSchema } from "./flatten";

// Real schemas of Studio 3.0.0 tools over the demo book, captured in the spike (06.11).
type Tool = { name: string; description: string; parameters: Record<string, unknown> };
const tool = (name: string) => [...(S.primary.tools as Tool[]), ...(S.data.tools as Tool[])].find((t) => t.name === name)!;

const walk = (v: unknown, visit: (o: Record<string, unknown>) => void) => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
  else if (v && typeof v === "object") {
    visit(v as Record<string, unknown>);
    Object.values(v).forEach((x) => walk(x, visit));
  }
};

describe("flatSchema", () => {
  it("keeps only type/properties/required at the root and no $ref/$defs anywhere", () => {
    for (const name of ["delegate_to", "execute_query", "view_schema", "complete_task"]) {
      const flat = flatSchema(tool(name).parameters);
      expect(Object.keys(flat).sort()).toEqual(["properties", "required", "type"]);
      walk(flat, (o) => {
        expect(o).not.toHaveProperty("$ref");
        expect(o).not.toHaveProperty("$defs");
      });
    }
  });

  it("delegate_to keeps its `type` choice as the spike sent it ({type:{id:'data'}})", () => {
    const flat = flatSchema(tool("delegate_to").parameters) as { properties: { type: { anyOf: { properties: { id: unknown } }[] } }; required: string[] };
    expect(flat.required.sort()).toEqual(["instructions", "type"]);
    expect(JSON.stringify(flat.properties.type)).toContain('"data"');
  });

  it("a recursive definition is opened once per path and the result is finite", () => {
    const params = { type: "object", properties: { f: { $ref: "#/$defs/A" } }, $defs: { A: { type: "object", properties: { next: { $ref: "#/$defs/A" } } } } };
    expect(flatSchema(params)).toEqual({ type: "object", properties: { f: { type: "object", properties: { next: { type: "object" } } } }, required: [] });
  });

  it("our own flat tools pass through unchanged", () => {
    const p = { type: "object", properties: { donor: { type: "string", description: "who" } }, required: ["donor"] };
    expect(flatSchema(p)).toEqual(p);
  });
});
