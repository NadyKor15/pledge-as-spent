// Studio's tool schemas, made acceptable and affordable for Amazon Nova.
//
// Nova's Converse accepts only `type`, `properties` and `required` at the root of a tool's input
// schema, and Studio's schemas use `$defs`/`$ref`/`anyOf`. `forNova` inlines every `$ref` (a
// recursive definition is opened once per path) and keeps three keys at the root; Lite and Pro took
// the result in the spike (0 ValidationException in 4 calls). Inlined, `execute_query` grows to
// 57 200 characters, about 20 600 input tokens a turn, so `compactForNova` first drops what a
// question about the book does not need: descriptions, examples, expression and window branches.

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Inline every $ref from the root's $defs; only type/properties/required stay at the root. */
export function forNova(params: Json): Json {
  const defs = (params.$defs ?? {}) as Record<string, unknown>;
  const walk = (v: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, path));
    if (!isObj(v)) return v;
    if (typeof v.$ref === "string") {
      const name = v.$ref.replace("#/$defs/", "");
      if (path.includes(name) || !(name in defs)) return { type: "object" };
      return walk(defs[name], [...path, name]);
    }
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "$defs")
        .map(([k, x]) => [k, walk(x, path)]),
    );
  };
  const flat = walk(params, []) as Json;
  return { type: "object", properties: flat.properties ?? {}, required: flat.required ?? [] };
}

/** Keys that only explain a schema; Nova reads the tool's own description. */
const PROSE = new Set(["description", "examples", "example", "title", "$comment", "default", "markdownDescription", "deprecated"]);

/**
 * Properties a question about one book never needs. Dropping an optional property is safe; an
 * `anyOf` branch that requires one of them goes with it.
 */
export const EXECUTE_QUERY_DROP = new Set(["expression", "windows", "window", "joins", "join", "bucketThreshold", "showEmpty", "fillPolicy", "calendar", "having", "offset", "topN", "orderBy", "sort", "emptyValues", "exclude", "filterAggregated"]);

/** Definitions an aggregation or projection over the book never reaches once the drops above are made. */
const DROP_DEFS = new Set(["AgApiExpression", "AgApiFilterGroup"]);

export function compactSchema(params: Json, drop: ReadonlySet<string> = EXECUTE_QUERY_DROP): Json {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    if (typeof v.$ref === "string" && DROP_DEFS.has(v.$ref.replace("#/$defs/", ""))) return { type: "object" };
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      if (PROSE.has(k) && typeof x !== "object") continue;
      if (k === "additionalProperties" && x === false) continue;
      if (k === "properties" && isObj(x)) {
        out[k] = Object.fromEntries(Object.entries(x).filter(([p]) => !drop.has(p)).map(([p, s]) => [p, walk(s)]));
        continue;
      }
      if (k === "required" && Array.isArray(x)) {
        out[k] = x.filter((p) => !drop.has(String(p)));
        continue;
      }
      if (k === "anyOf" && Array.isArray(x)) {
        const kept = x.filter((b) => !(isObj(b) && Array.isArray(b.required) && b.required.some((p) => drop.has(String(p)))));
        out[k] = kept.map(walk);
        continue;
      }
      if (k === "$defs" && isObj(x)) {
        out[k] = Object.fromEntries(Object.entries(x).filter(([d]) => !DROP_DEFS.has(d)).map(([d, s]) => [d, walk(s)]));
        continue;
      }
      out[k] = walk(x);
    }
    // An anyOf left with one branch is that branch.
    if (Array.isArray(out.anyOf) && out.anyOf.length === 1 && Object.keys(out).length === 1) return out.anyOf[0];
    return out;
  };
  return walk(params) as Json;
}

/**
 * After inlining: long enums of field ids become plain strings (the data agent reads the ids from
 * view_schema first, and Studio validates the arguments before running the query, so a wrong id
 * comes back to the model as an issue), and anyOf branches that became identical are merged.
 */
export function shrinkInlined(schema: Json, maxEnum = 6): Json {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "enum") out[k] = x;
      else if (k === "properties" && isObj(x)) {
        // Field ids: a long enum per position, repeated in every field reference.
        out[k] = Object.fromEntries(Object.entries(x).map(([p, s]) => [p, p === "id" && isFieldIdEnum(s, maxEnum) ? { type: "string" } : walk(s)]));
      } else out[k] = walk(x);
    }
    if (Array.isArray(out.anyOf)) {
      // The book has no dates: date filters are dead weight.
      let anyOf: unknown[] = out.anyOf.filter((b) => !/"format":"date-time"|"inRelativeRange"/.test(JSON.stringify(b)));
      const refs = mergeFieldRefs(anyOf);
      if (refs) anyOf = [refs];
      const seen = new Map<string, unknown>();
      for (const b of anyOf) seen.set(JSON.stringify(b), b);
      const branches = [...seen.values()];
      if (branches.length === 1) {
        const { anyOf: _drop, ...rest } = out;
        void _drop;
        return isObj(branches[0]) ? { ...rest, ...branches[0] } : branches[0];
      }
      out.anyOf = branches;
    }
    return out;
  };
  return walk(schema) as Json;
}

/** `{enum:[…]}` or `{anyOf:[{enum}, {enum}]}` of more than `max` field ids. */
function isFieldIdEnum(s: unknown, max: number): boolean {
  if (!isObj(s)) return false;
  if (Array.isArray(s.enum)) return s.enum.length > max;
  if (Array.isArray(s.anyOf)) return s.anyOf.every((b) => isObj(b) && Array.isArray(b.enum)) && s.anyOf.reduce((n, b) => n + ((b as Json).enum as unknown[]).length, 0) > max;
  return false;
}

/** Field references (`{id}`, `{id, aggregation}` per field type) as one object: id required, aggregation optional. */
function mergeFieldRefs(branches: unknown[]): Json | null {
  const objs = branches.filter(isObj);
  if (objs.length < 2 || objs.length !== branches.length) return null;
  const keysOk = objs.every((b) => isObj(b.properties) && Object.keys(b.properties).every((k) => k === "id" || k === "aggregation") && "id" in (b.properties as Json));
  if (!keysOk) return null;
  const aggs = new Set<string>();
  for (const b of objs) {
    const a = (b.properties as Json).aggregation;
    if (isObj(a) && Array.isArray(a.enum)) for (const x of a.enum) aggs.add(String(x));
  }
  const properties: Json = { id: { type: "string" } };
  if (aggs.size) properties.aggregation = { type: "string", enum: [...aggs] };
  return { type: "object", properties, required: ["id"] };
}

/** A tool as Nova's Converse wants it, from a Studio tool schema. Heavy Studio tools are compacted first. */
export function novaToolSpec(tool: { name: string; description: string; parameters: unknown }): { toolSpec: { name: string; description: string; inputSchema: { json: Json } } } {
  const params = isObj(tool.parameters) ? tool.parameters : { type: "object", properties: {} };
  const heavy = tool.name === "execute_query";
  const schema = heavy ? shrinkInlined(forNova(compactSchema(params))) : forNova(params);
  const description = heavy ? shortDescription(tool.description) : tool.description;
  return { toolSpec: { name: tool.name, description: description || tool.name, inputSchema: { json: schema } } };
}

/** The first paragraph of a long description: what the tool does, without the rules for features dropped above. */
function shortDescription(d: string): string {
  const first = d.split(/\n\s*\n/)[0] ?? d;
  return first.length > 600 ? first.slice(0, 600) : first;
}
