import { readFile } from "node:fs/promises";
import path from "node:path";
import { connection } from "next/server";

/** A recorded agent run (eval/agent/recorded/Qn.json) for the debug page. Local runs only, like the page. */
export async function GET(req: Request) {
  await connection(); // read on each request, never prerendered
  if (process.env.NODE_ENV === "production" && process.env.DEBUG_PAGES !== "on") return new Response("Not found", { status: 404 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!/^Q\d{1,2}(-[a-z]+)?$/.test(q)) return Response.json({ error: "bad_question" }, { status: 400 });
  try {
    const text = await readFile(path.join(process.cwd(), "eval", "agent", "recorded", `${q}.json`), "utf8");
    return new Response(text, { headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "not_recorded", message: `No recording ${q}.` }, { status: 404 });
  }
}
