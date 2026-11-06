import type { AgAiStudioTools, AgAiTool, AgAiToolContext } from "ag-studio";
import type { Lang } from "../format";

// WebMCP: read-only tools of the page, offered to the AI the browser itself runs.
// `document.modelContext` is experimental and ships in Chrome 149+ behind a flag or an
// origin trial. Where it is absent nothing here does anything: the page works as it did.
// This module knows nothing about the ledger: callers pass the tools.

export interface WebMcpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface WebMcpAdvertisedTool {
  name: string;
  description: string;
  /** The schema as the browser reports it back (an object in Chrome 155, a JSON string in AG's typings). */
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
}

interface WebMcpDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
  execute(args: Record<string, unknown>): WebMcpToolResult | Promise<WebMcpToolResult>;
}

/** The part of `document.modelContext` this page uses. */
export interface WebMcpModelContext {
  registerTool(descriptor: WebMcpDescriptor, options?: { signal?: AbortSignal }): Promise<void> | void;
  getTools(options?: { fromOrigins?: string[] }): Promise<WebMcpAdvertisedTool[]>;
  /** Chrome 155 takes the arguments as an object and answers with the result as a JSON string; AG's typings show a JSON string in and a result out. */
  executeTool(tool: WebMcpAdvertisedTool, input: Record<string, unknown> | string, options?: { signal?: AbortSignal }): Promise<WebMcpToolResult | string>;
  addEventListener(type: "toolchange", listener: () => void): void;
  removeEventListener(type: "toolchange", listener: () => void): void;
}

declare global {
  interface Document {
    /** Optional by design: its absence is the feature test for WebMCP. */
    modelContext?: WebMcpModelContext;
  }
}

/** A tool the page offers. `readOnly: true` is required: a browser agent may skip its confirmation for a tool marked read-only. */
export interface WebMcpTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: unknown;
  readOnly: true;
  /** A string becomes one text part; an object is sent as its JSON. */
  execute(args: Record<string, unknown>): string | WebMcpToolResult | Promise<string | WebMcpToolResult>;
}

export interface WebMcpRegistration {
  supported: boolean;
  registered: string[];
  failed: { name: string; message: string }[];
}

export interface WebMcpOptions {
  /** Registrations last until this aborts. */
  signal?: AbortSignal;
  /** Default: `document.modelContext`. Passed explicitly in tests. */
  modelContext?: WebMcpModelContext | undefined;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The page's WebMCP, if the browser has it. */
export function pageModelContext(): WebMcpModelContext | undefined {
  return typeof document === "undefined" ? undefined : document.modelContext;
}

function context(o: WebMcpOptions): WebMcpModelContext | undefined {
  return hasOwn(o, "modelContext") ? o.modelContext : pageModelContext();
}

const text = (t: string, isError?: boolean): WebMcpToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

function toResult(value: unknown): WebMcpToolResult {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object" && Array.isArray((value as WebMcpToolResult).content)) return value as WebMcpToolResult;
  return text(value === undefined ? "" : JSON.stringify(value));
}

/** What the browser calls. The browser needs a `content` array back; a bare string leaves it with nothing to show. */
function descriptor(tool: WebMcpTool): WebMcpDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      try {
        return toResult(await tool.execute(args ?? {}));
      } catch (e) {
        return text(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  };
}

async function registerOne(mc: WebMcpModelContext, tool: WebMcpTool, signal: AbortSignal | undefined): Promise<string | null> {
  if (tool.readOnly !== true) return `${tool.name} is not declared read-only: refused`;
  try {
    await mc.registerTool(descriptor(tool), { signal });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Publishes the tools to the browser's AI, read-only. A tool the browser rejects is reported and the rest still go in. */
export async function registerWebMcpTools(tools: readonly WebMcpTool[], options: WebMcpOptions = {}): Promise<WebMcpRegistration> {
  const mc = context(options);
  const out: WebMcpRegistration = { supported: mc !== undefined, registered: [], failed: [] };
  if (!mc) return out;
  for (const tool of tools) {
    if (options.signal?.aborted) break;
    const err = await registerOne(mc, tool, options.signal);
    if (err === null) out.registered.push(tool.name);
    else out.failed.push({ name: tool.name, message: err });
  }
  return out;
}

export interface WebMcpSync {
  /** Brings the browser's registrations in line with the tools right now; unchanged tools are left alone. */
  sync(): Promise<WebMcpRegistration>;
  /** Names currently registered. */
  advertised(): string[];
  /** Removes every registration; later syncs do nothing. */
  destroy(): void;
}

/** For tools whose schema moves with the page (Studio's): re-reads the list, re-registers what changed, drops what vanished. */
export function createWebMcpSync(getTools: () => readonly WebMcpTool[], options: Omit<WebMcpOptions, "signal"> = {}): WebMcpSync {
  const live = new Map<string, { signature: string; controller: AbortController }>();
  let queue: Promise<unknown> = Promise.resolve();
  let destroyed = false;

  async function pass(): Promise<WebMcpRegistration> {
    const mc = context(options);
    const out: WebMcpRegistration = { supported: mc !== undefined, registered: [], failed: [] };
    if (!mc || destroyed) return out;
    const tools = getTools();
    const names = new Set(tools.map((t) => t.name));
    for (const [name, entry] of live) {
      if (!names.has(name)) {
        entry.controller.abort();
        live.delete(name);
      }
    }
    for (const tool of tools) {
      if (destroyed) break;
      const signature = JSON.stringify([tool.description, tool.inputSchema]);
      if (live.get(tool.name)?.signature === signature) continue;
      live.get(tool.name)?.controller.abort();
      live.delete(tool.name);
      const controller = new AbortController();
      const err = await registerOne(mc, tool, controller.signal);
      if (err !== null) out.failed.push({ name: tool.name, message: err });
      else if (destroyed) controller.abort();
      else live.set(tool.name, { signature, controller });
    }
    out.registered = [...live.keys()];
    return out;
  }

  return {
    sync() {
      const run = queue.then(pass);
      queue = run.catch(() => undefined);
      return run;
    },
    advertised: () => [...live.keys()],
    destroy() {
      destroyed = true;
      for (const entry of live.values()) entry.controller.abort();
      live.clear();
    },
  };
}

/** The line the page shows about WebMCP, in the reader's language. Every tool it offers is read-only. */
export function webMcpBadgeText(supported: boolean, count: number, lang: Lang = "en"): string {
  if (!supported) {
    return { en: "This browser doesn't expose WebMCP (Chrome 149+, flag)", de: "Dieser Browser bietet kein WebMCP an (Chrome 149+, Flag)", ja: "このブラウザはWebMCPに対応していません（Chrome 149以降、フラグ）" }[lang];
  }
  const one = count === 1;
  return {
    en: `WebMCP: ${count} read-only ${one ? "tool" : "tools"} exposed to your browser's AI`,
    de: `WebMCP: ${count} ${one ? "schreibgeschütztes Werkzeug" : "schreibgeschützte Werkzeuge"} für die KI Ihres Browsers freigegeben`,
    ja: `WebMCP: 読み取り専用ツール${count}個をブラウザのAIに公開中`,
  }[lang];
}

type CreateContext = (options?: { signal?: AbortSignal; run?: { threadId: string; runId: string } }) => AgAiToolContext;

let calls = 0;

function fromStudio(tool: AgAiTool, createContext: CreateContext | undefined): WebMcpTool | null {
  const schema = tool.schema();
  if (!schema || typeof tool.execute !== "function") return null;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema.parameters,
    readOnly: true,
    execute: async (args) => {
      const make = createContext ?? ((await import("ag-studio")).createAiToolContext as unknown as CreateContext);
      const id = ++calls;
      const result = await tool.execute!({ toolCallId: `webmcp-${id}`, name: tool.name, args }, make({ signal: new AbortController().signal, run: { threadId: "webmcp", runId: `webmcp-run-${id}` } }));
      return result.success ? text(result.response) : text(result.issues.map((i) => i.message).join("; "), true);
    },
  };
}

/**
 * Studio's own four read-only tools as WebMCP tools (the pattern in AG's WebMCP guide). A tool that is
 * uncallable right now (no widgets on the page, say) is left out: call again, or use `createWebMcpSync`, after the state changes.
 * No tool that changes the dashboard is ever asked for.
 */
export function studioReadOnlyTools(studio: { getAiTools(): AgAiStudioTools }, options: { createContext?: CreateContext } = {}): WebMcpTool[] {
  const t = studio.getAiTools();
  return [t.viewSchema(), t.viewPage(), t.viewWidget(), t.executeQuery()].flatMap((tool) => {
    const w = fromStudio(tool, options.createContext);
    return w ? [w] : [];
  });
}
