// Studio's tool schemas, flattened for a provider that refuses them as Studio writes them.
//
// Studio's schemas use `$defs`/`$ref`/`anyOf` at the root of a tool's input. Meta's Responses API takes them as
// they are; should it refuse one, `flatSchema` inlines every `$ref` (a recursive definition is opened once per
// path) and keeps only `type`, `properties` and `required` at the root (src/agent/meta-wire.ts).

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Inline every $ref from the root's $defs; only type/properties/required stay at the root. */
export function flatSchema(params: Json): Json {
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
