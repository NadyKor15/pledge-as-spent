import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExchanges, recordingFetch, replayFetch, sanitize, type FetchLike } from "./recording";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "pp-rec-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const API = "https://api-m.sandbox.paypal.com";

describe("sanitize", () => {
  it("drops token and password fields and redacts auth schemes and listed secrets", () => {
    const out = sanitize(
      { access_token: "A", nested: { password: "p", note: "Bearer abc.def and Basic Zm9v", id: "client-123-x" }, list: ["client-123"] },
      ["client-123"],
    );
    expect(out).toEqual({ nested: { note: "<redacted> and <redacted>", id: "<redacted>-x" }, list: ["<redacted>"] });
  });
});

describe("recordingFetch", () => {
  it("records sanitized exchanges, never the OAuth exchange, and passes responses through", async () => {
    const dir = tmp();
    const inner: FetchLike = async (url) =>
      url.endsWith("/v1/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "SECRET-TOKEN", expires_in: 100 }), { status: 200 })
        : new Response(JSON.stringify({ id: "X1", echo: "secret-id-1" }), { status: 201, headers: { "paypal-debug-id": "dbg1", "set-cookie": "c=1" } });
    const rec = recordingFetch(inner, dir, { secrets: ["secret-id-1"], label: () => "step-a" });

    await rec(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: "Basic Zm9vOmJhcg==" }, body: "grant_type=client_credentials" });
    const res = await rec(`${API}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: "Bearer SECRET-TOKEN", "PayPal-Request-Id": "rid-1", "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await res.json()).toEqual({ id: "X1", echo: "secret-id-1" }); // caller still sees the real response

    const files = readdirSync(dir);
    expect(files).toEqual(["001-step-a.json"]);
    const raw = readFileSync(path.join(dir, files[0]), "utf8");
    for (const needle of ["Bearer ", "Basic ", "access_token", "SECRET-TOKEN", "secret-id-1", "set-cookie"]) expect(raw).not.toContain(needle);
    const [e] = loadExchanges(dir);
    expect(e.request.headers).toEqual({ "paypal-request-id": "rid-1", "content-type": "application/json" });
    expect(e.response).toMatchObject({ status: 201, headers: { "paypal-debug-id": "dbg1" }, body: { id: "X1", echo: "<redacted>" } });
  });
});

describe("replayFetch", () => {
  const rec = (seq: number, method: string, p: string, reqBody: unknown, status: number, body: unknown) => ({
    seq,
    recordedAt: "",
    request: { method, url: API + p, headers: {}, body: reqBody },
    response: { status, headers: {}, body },
  });

  it("serves exchanges in order per method and path and answers OAuth itself", async () => {
    const replay = replayFetch([rec(1, "POST", "/x", { a: 1 }, 500, { name: "E" }), rec(2, "POST", "/x", { a: 1 }, 201, { id: "1" })]);
    expect((await replay(`${API}/v1/oauth2/token`, { method: "POST", headers: {} })).status).toBe(200);
    expect((await replay(`${API}/x`, { method: "POST", headers: {}, body: '{"a":1}' })).status).toBe(500);
    expect((await replay(`${API}/x`, { method: "POST", headers: {}, body: '{"a":1}' })).status).toBe(201);
    await expect(replay(`${API}/x`, { method: "POST", headers: {}, body: '{"a":1}' })).rejects.toThrow(/No recorded exchange/);
  });

  it("fails when the request body differs from the recording", async () => {
    const replay = replayFetch([rec(1, "POST", "/x", { a: 1 }, 201, {})]);
    await expect(replay(`${API}/x`, { method: "POST", headers: {}, body: '{"a":2}' })).rejects.toThrow(/differs/);
  });

  it("returns an empty body for 204", async () => {
    const res = await replayFetch([rec(1, "POST", "/v", null, 204, null)])(`${API}/v`, { method: "POST", headers: {} });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
