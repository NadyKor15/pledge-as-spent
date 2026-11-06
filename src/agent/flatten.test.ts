import { describe, expect, it } from "vitest";
import S from "../../eval/agent/studio-schemas-3.0.0.json";
import { compactSchema, forNova, novaToolSpec } from "./flatten";

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

describe("forNova", () => {
  it("keeps only type/properties/required at the root and no $ref/$defs anywhere", () => {
    for (const name of ["delegate_to", "execute_query", "view_schema", "complete_task"]) {
      const flat = forNova(tool(name).parameters);
      expect(Object.keys(flat).sort()).toEqual(["properties", "required", "type"]);
      walk(flat, (o) => {
        expect(o).not.toHaveProperty("$ref");
        expect(o).not.toHaveProperty("$defs");
      });
    }
  });

  it("delegate_to keeps its `type` choice as the spike sent it ({type:{id:'data'}})", () => {
    const flat = forNova(tool("delegate_to").parameters) as { properties: { type: { anyOf: { properties: { id: unknown } }[] } }; required: string[] };
    expect(flat.required.sort()).toEqual(["instructions", "type"]);
    expect(JSON.stringify(flat.properties.type)).toContain('"data"');
  });

  it("a recursive definition is opened once per path and the result is finite", () => {
    const params = { type: "object", properties: { f: { $ref: "#/$defs/A" } }, $defs: { A: { type: "object", properties: { next: { $ref: "#/$defs/A" } } } } };
    expect(forNova(params)).toEqual({ type: "object", properties: { f: { type: "object", properties: { next: { type: "object" } } } }, required: [] });
  });
});

describe("execute_query for Nova", () => {
  const eq = tool("execute_query");
  it("shrinks from about 57 000 characters inlined to under 8 000 (target: under 8K tokens a delegate turn)", () => {
    const inlined = JSON.stringify(forNova(eq.parameters)).length;
    const spec = JSON.stringify(novaToolSpec(eq)).length;
    expect(inlined).toBeGreaterThan(50_000);
    expect(spec).toBeLessThan(8_000);
  });

  it("still lets the data agent ask what the book needs: aggregation and projection, sum, a filter on a field", () => {
    const json = JSON.stringify(novaToolSpec(eq).toolSpec.inputSchema.json);
    for (const s of ['"aggregation"', '"projection"', '"sum"', '"equals"', '"measures"', '"dimensions"', '"filter"']) expect(json).toContain(s);
    walk(novaToolSpec(eq).toolSpec.inputSchema.json, (o) => {
      expect(o).not.toHaveProperty("$ref");
      expect(o).not.toHaveProperty("description");
    });
  });

  it("drops an anyOf branch that requires a dropped property, keeps optional ones out", () => {
    const params = { type: "object", properties: { q: { anyOf: [{ type: "object", properties: { expression: {} }, required: ["expression"] }, { type: "object", properties: { field: {}, windows: {} }, required: ["field"] }] } } };
    expect(compactSchema(params)).toEqual({ type: "object", properties: { q: { type: "object", properties: { field: {} }, required: ["field"] } } });
  });

  it("our own flat tools pass through unchanged", () => {
    const p = { type: "object", properties: { donor: { type: "string", description: "who" } }, required: ["donor"] };
    expect(novaToolSpec({ name: "ledger_donor_money", description: "d", parameters: p }).toolSpec.inputSchema.json).toEqual(p);
  });
});
