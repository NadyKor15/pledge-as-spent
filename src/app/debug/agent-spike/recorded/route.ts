import { readFile } from "node:fs/promises";
import path from "node:path";
import { connection } from "next/server";

/**
 * Where recorded runs are: the measure's own, then the runs of 06.11 on an earlier model, kept as evidence.
 * Each path starts with literal folders, so the build traces only these two trees into this route.
 */
const READERS = [
  (set: string, q: string) => readFile(path.join(process.cwd(), "eval", "agent", "recorded", set, `${q}.json`), "utf8"),
  (set: string, q: string) => readFile(path.join(process.cwd(), "eval", "baseline-legacy", "agent", "recorded", set, `${q}.json`), "utf8"),
];

/** A recorded agent run (<folder>/<set>/Qn.json) for the debug page. Local runs only, like the page. */
export async function GET(req: Request) {
  await connection(); // read on each request, never prerendered
  if (process.env.NODE_ENV === "production" && process.env.DEBUG_PAGES !== "on") return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const set = url.searchParams.get("set") ?? "r1-lite";
  if (!/^Q\d{1,2}$/.test(q) || !/^[A-Za-z0-9-]{1,32}$/.test(set)) return Response.json({ error: "bad_question" }, { status: 400 });
  for (const read of READERS) {
    try {
      const text = await read(set, q);
      return new Response(text, { headers: { "content-type": "application/json" } });
    } catch {
      // not in this folder
    }
  }
  return Response.json({ error: "not_recorded", message: `No recording ${q}.` }, { status: 404 });
}
