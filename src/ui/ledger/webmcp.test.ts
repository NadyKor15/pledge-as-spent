import { describe, expect, it, vi } from "vitest";
import { createWebMcpSync, registerWebMcpTools, studioReadOnlyTools, webMcpBadgeText, type WebMcpModelContext, type WebMcpTool, type WebMcpToolResult } from "./webmcp";

/** A stand-in for document.modelContext that behaves like the browser's: a registration lives until its signal aborts; a duplicate name throws. */
function fakeContext() {
  type Descriptor = Parameters<WebMcpModelContext["registerTool"]>[0];
  const live = new Map<string, Descriptor>();
  const calls: { descriptor: Descriptor; signal: AbortSignal | undefined }[] = [];
  const ctx: WebMcpModelContext = {
    registerTool: vi.fn(async (descriptor, options) => {
      if (live.has(descriptor.name)) throw new Error(`InvalidStateError: ${descriptor.name} is already registered`);
      calls.push({ descriptor, signal: options?.signal });
      live.set(descriptor.name, descriptor);
      options?.signal?.addEventListener("abort", () => live.delete(descriptor.name));
    }),
    getTools: vi.fn(async () => [...live.values()].map((d) => ({ name: d.name, description: d.description, inputSchema: JSON.stringify(d.inputSchema) }))),
    executeTool: vi.fn(async (tool, input) => live.get(tool.name)!.execute(JSON.parse(input))),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { ctx, live, calls };
}

const tool = (name: string, extra: Partial<WebMcpTool> = {}): WebMcpTool => ({
  name,
  description: `${name} does a read`,
  inputSchema: { type: "object", properties: { donor: { type: "string" } } },
  readOnly: true,
  execute: async () => `answer from ${name}`,
  ...extra,
});

const text = (r: WebMcpToolResult | string) => (typeof r === "string" ? r : r.content.map((c) => c.text).join(""));

describe("registerWebMcpTools", () => {
  it("registers every tool read-only, with its schema and description", async () => {
    const { ctx, calls } = fakeContext();
    const res = await registerWebMcpTools([tool("ledger_donor_money"), tool("ledger_line")], { modelContext: ctx });
    expect(res).toEqual({ supported: true, registered: ["ledger_donor_money", "ledger_line"], failed: [] });
    expect(calls.map((c) => c.descriptor.annotations)).toEqual([{ readOnlyHint: true }, { readOnlyHint: true }]);
    expect(calls[0].descriptor.description).toBe("ledger_donor_money does a read");
    expect(calls[0].descriptor.inputSchema).toEqual({ type: "object", properties: { donor: { type: "string" } } });
  });

  it("wraps a plain string result as one text part", async () => {
    const { ctx, live } = fakeContext();
    await registerWebMcpTools([tool("t")], { modelContext: ctx });
    expect(await live.get("t")!.execute({})).toEqual({ content: [{ type: "text", text: "answer from t" }] });
  });

  it("passes a ready result through and turns a bare object into JSON text", async () => {
    const { ctx, live } = fakeContext();
    const ready: WebMcpToolResult = { content: [{ type: "text", text: "as is" }] };
    await registerWebMcpTools([tool("a", { execute: () => ready }), tool("b", { execute: async () => ({ total: 12 }) as never })], { modelContext: ctx });
    expect(await live.get("a")!.execute({})).toBe(ready);
    expect(text(await live.get("b")!.execute({}))).toBe('{"total":12}');
  });

  it("a throwing tool answers with an error text, it does not reject into the browser", async () => {
    const { ctx, live } = fakeContext();
    await registerWebMcpTools([tool("boom", { execute: async () => Promise.reject(new Error("the book is closed")) })], { modelContext: ctx });
    const r = (await live.get("boom")!.execute({})) as WebMcpToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("boom failed: the book is closed");
  });

  it("hands the arguments to the tool as the browser decoded them", async () => {
    const { ctx, live } = fakeContext();
    const seen: unknown[] = [];
    await registerWebMcpTools([tool("t", { execute: async (a) => (seen.push(a), "ok") })], { modelContext: ctx });
    await live.get("t")!.execute({ donor: "Lena" });
    expect(seen).toEqual([{ donor: "Lena" }]);
  });

  it("removes every registration when the signal aborts", async () => {
    const { ctx, live, calls } = fakeContext();
    const c = new AbortController();
    await registerWebMcpTools([tool("a"), tool("b")], { modelContext: ctx, signal: c.signal });
    expect([...live.keys()]).toEqual(["a", "b"]);
    expect(calls.every((x) => x.signal === c.signal)).toBe(true);
    c.abort();
    expect([...live.keys()]).toEqual([]);
  });

  it("registers nothing when the signal is already aborted", async () => {
    const { ctx, live } = fakeContext();
    const c = new AbortController();
    c.abort();
    const res = await registerWebMcpTools([tool("a")], { modelContext: ctx, signal: c.signal });
    expect(live.size).toBe(0);
    expect(res.registered).toEqual([]);
  });

  it("stops registering once the signal aborts in the middle", async () => {
    const { ctx, live } = fakeContext();
    const c = new AbortController();
    const first = ctx.registerTool;
    ctx.registerTool = vi.fn(async (d, o) => {
      await first(d, o);
      c.abort();
    });
    const res = await registerWebMcpTools([tool("a"), tool("b"), tool("c")], { modelContext: ctx, signal: c.signal });
    expect(res.registered).toEqual(["a"]);
    expect(live.size).toBe(0);
  });

  it("refuses a tool that is not declared read-only, and says so", async () => {
    const { ctx, live } = fakeContext();
    const res = await registerWebMcpTools([tool("ok"), { ...tool("writes"), readOnly: false }, { ...tool("unsure"), readOnly: undefined as never }], { modelContext: ctx });
    expect([...live.keys()]).toEqual(["ok"]);
    expect(res.failed.map((f) => f.name)).toEqual(["writes", "unsure"]);
    expect(res.failed[0].message).toMatch(/read-only/);
  });

  it("a rejected registration is reported and does not stop the others", async () => {
    const { ctx, live } = fakeContext();
    const res = await registerWebMcpTools([tool("a"), tool("a"), tool("b")], { modelContext: ctx });
    expect(res.registered).toEqual(["a", "b"]);
    expect(res.failed).toEqual([{ name: "a", message: "InvalidStateError: a is already registered" }]);
    expect(live.size).toBe(2);
  });

  it("reports an unsupported browser instead of throwing", async () => {
    expect(await registerWebMcpTools([tool("a")], { modelContext: undefined })).toEqual({ supported: false, registered: [], failed: [] });
  });
});

describe("webMcpBadgeText", () => {
  it("says how many tools the browser's AI can see", () => {
    expect(webMcpBadgeText(true, 6)).toBe("WebMCP: 6 ledger tools exposed to your browser's AI");
    expect(webMcpBadgeText(true, 1)).toBe("WebMCP: 1 ledger tool exposed to your browser's AI");
  });
  it("says why there is nothing when the browser has no WebMCP", () => {
    expect(webMcpBadgeText(false, 0)).toBe("This browser doesn't expose WebMCP (Chrome 149+, flag)");
    expect(webMcpBadgeText(false, 6)).toBe("This browser doesn't expose WebMCP (Chrome 149+, flag)");
  });
});

describe("createWebMcpSync", () => {
  it("registers the current tools, re-registers a changed schema, drops a vanished tool", async () => {
    const { ctx, live, calls } = fakeContext();
    let tools = [tool("a"), tool("b")];
    const sync = createWebMcpSync(() => tools, { modelContext: ctx });
    expect(await sync.sync()).toMatchObject({ supported: true, registered: ["a", "b"] });
    await sync.sync(); // nothing changed: nothing registered again
    expect(calls).toHaveLength(2);
    tools = [tool("a", { inputSchema: { type: "object", properties: { page: { type: "string" } } } })];
    await sync.sync();
    expect([...live.keys()]).toEqual(["a"]);
    expect(calls).toHaveLength(3);
    expect(sync.advertised()).toEqual(["a"]);
    expect(live.get("a")!.inputSchema).toEqual({ type: "object", properties: { page: { type: "string" } } });
  });

  it("destroy removes everything and later syncs register nothing", async () => {
    const { ctx, live } = fakeContext();
    const sync = createWebMcpSync(() => [tool("a")], { modelContext: ctx });
    await sync.sync();
    sync.destroy();
    expect(live.size).toBe(0);
    await sync.sync();
    expect(live.size).toBe(0);
  });

  it("a failed registration is retried on the next sync", async () => {
    const { ctx, live } = fakeContext();
    const real = ctx.registerTool;
    let fail = true;
    ctx.registerTool = vi.fn(async (d, o) => {
      if (fail) throw new Error("transient");
      await real(d, o);
    });
    const sync = createWebMcpSync(() => [tool("a")], { modelContext: ctx });
    expect((await sync.sync()).failed).toHaveLength(1);
    fail = false;
    await sync.sync();
    expect([...live.keys()]).toEqual(["a"]);
  });

  it("without WebMCP it is quiet and reports unsupported", async () => {
    const sync = createWebMcpSync(() => [tool("a")], { modelContext: undefined });
    expect(await sync.sync()).toMatchObject({ supported: false, registered: [] });
    expect(sync.advertised()).toEqual([]);
  });
});

describe("studioReadOnlyTools", () => {
  const studioTool = (name: string, schema: unknown, execute?: (call: { args: Record<string, unknown> }) => Promise<unknown>) => ({
    name,
    description: `${name} (Studio)`,
    kind: "client" as const,
    schema: () => schema as never,
    execute: execute as never,
  });
  const ctxFactory = () => ({ success: (r: string) => ({ success: true, response: r }), error: (m: string) => ({ success: false, issues: [{ message: m }] }) }) as never;

  it("offers the four read-only tools by their Studio names, skipping one that is uncallable right now", async () => {
    const api = {
      viewSchema: () => studioTool("view_schema", { parameters: { type: "object", properties: {} } }, async () => ({ success: true, response: "fields: donor, amount" })),
      viewPage: () => studioTool("view_page", { parameters: { type: "object", properties: {} } }, async () => ({ success: true, response: "page 1" })),
      viewWidget: () => studioTool("view_widget", undefined), // no widgets on the page: uncallable
      executeQuery: () => studioTool("execute_query", { parameters: { type: "object", properties: { query: { type: "string" } } } }, async (c) => ({ success: true, response: `ran ${String(c.args.query)}` })),
      addWidget: () => {
        throw new Error("a mutating tool must never be asked for");
      },
    };
    const tools = studioReadOnlyTools({ getAiTools: () => api as never }, { createContext: ctxFactory });
    expect(tools.map((t) => t.name)).toEqual(["view_schema", "view_page", "execute_query"]);
    expect(tools.every((t) => t.readOnly === true)).toBe(true);
    expect(tools[2].inputSchema).toEqual({ type: "object", properties: { query: { type: "string" } } });
    expect(text(await tools[2].execute({ query: "SELECT 1" }))).toBe("ran SELECT 1");
  });

  it("a Studio error becomes an error result with its messages", async () => {
    const api = {
      viewSchema: () => studioTool("view_schema", { parameters: {} }, async () => ({ success: false, issues: [{ message: "no such field" }, { message: "try view_schema" }] })),
      viewPage: () => studioTool("view_page", undefined),
      viewWidget: () => studioTool("view_widget", undefined),
      executeQuery: () => studioTool("execute_query", undefined),
    };
    const [t] = studioReadOnlyTools({ getAiTools: () => api as never }, { createContext: ctxFactory });
    const r = (await t.execute({})) as WebMcpToolResult;
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toBe("no such field; try view_schema");
  });
});
