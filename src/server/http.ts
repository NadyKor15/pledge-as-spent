import { readFile } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { asServiceError, ServiceError } from "./errors";
import { getService } from "./runtime";
import type { PledgeService } from "./service";

// Shared plumbing of the route handlers: errors as JSON with a plain sentence,
// the client IP, request fields from JSON or forms, and the debug page's
// "back" redirect after a form post.

export function errorResponse(e: unknown): Response {
  const err = asServiceError(e);
  if (err instanceof ServiceError) return Response.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
  console.error("[pledge-as-spent] unhandled", e);
  return Response.json({ error: "internal", message: "Something went wrong on our side." }, { status: 500 });
}

/** Runs a handler with the service; any error becomes a JSON answer. */
export async function withService(fn: (svc: PledgeService) => Promise<Response>): Promise<Response> {
  try {
    return await fn(await getService());
  } catch (e) {
    return errorResponse(e);
  }
}

/** The caller's IP as the platform reports it (first X-Forwarded-For hop). Only its hash is stored. */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export type Fields = Record<string, unknown>;

/** JSON, urlencoded or multipart body -> plain fields (files stay File objects). */
export async function readFields(req: Request): Promise<Fields> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const v = await req.json();
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {};
    } catch {
      throw new ServiceError(400, "invalid_json", "The request body is not valid JSON.");
    }
  }
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const out: Fields = {};
    for (const [k, v] of form.entries()) out[k] = v;
    return out;
  }
  return {};
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** JSON answer, or a 303 back to a debug page when the form asked for it. */
export function respond(fields: Fields, data: unknown, status = 200): Response {
  const back = str(fields.back);
  // Same-origin debug pages only: no scheme, no "//host", no "..".
  if (back && /^\/debug(\/[\w.-]+)*$/.test(back) && !back.includes("..") && status < 400) return new Response(null, { status: 303, headers: { location: back } });
  return Response.json(data, { status });
}

/** Constant-time check of `Authorization: Bearer <secret>`. */
export function bearerMatches(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The cached sample receipt (its reading ships with the app: no model call). Static path, so file tracing ships it. */
export async function sampleBytes(name: string): Promise<Uint8Array> {
  if (name !== "hero") throw new ServiceError(400, "unknown_sample", `No sample receipt "${name}"; the sample is "hero".`);
  return new Uint8Array(await readFile(path.join(process.cwd(), "eval", "receipts", "hero", "hero-ja-01.png")));
}
