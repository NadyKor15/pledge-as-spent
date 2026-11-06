import { describe, expect, it, vi } from "vitest";
import { XLSX_MIME, saveBytes } from "./download";

function fakeDom() {
  const clicks: { href: string; download: string }[] = [];
  const anchor = { href: "", download: "", style: {} as Record<string, string>, click: vi.fn(() => clicks.push({ href: anchor.href, download: anchor.download })), remove: vi.fn() };
  const appended: unknown[] = [];
  const doc = { createElement: vi.fn(() => anchor), body: { append: (n: unknown) => appended.push(n) } };
  const urls = { createObjectURL: vi.fn((b: Blob) => `blob:fake/${b.size}`), revokeObjectURL: vi.fn() };
  return { doc, urls, anchor, clicks, appended };
}

describe("saveBytes", () => {
  it("hands the bytes to the browser as a named download, then lets go of the URL", async () => {
    const d = fakeDom();
    const later: (() => void)[] = [];
    saveBytes(new Uint8Array([1, 2, 3]), "statement-x.xlsx", XLSX_MIME, { document: d.doc as never, url: d.urls, defer: (f) => later.push(f) });
    expect(d.clicks).toEqual([{ href: "blob:fake/3", download: "statement-x.xlsx" }]);
    expect(d.appended).toEqual([d.anchor]);
    expect(d.urls.revokeObjectURL).not.toHaveBeenCalled(); // not before the browser has taken it
    later.forEach((f) => f());
    expect(d.urls.revokeObjectURL).toHaveBeenCalledWith("blob:fake/3");
    expect(d.anchor.remove).toHaveBeenCalled();
  });

  it("the blob carries the type", () => {
    const d = fakeDom();
    let seen: Blob | null = null;
    d.urls.createObjectURL.mockImplementation((b: Blob) => ((seen = b), "blob:x"));
    saveBytes(new Uint8Array(2), "a.xlsx", XLSX_MIME, { document: d.doc as never, url: d.urls, defer: () => {} });
    expect((seen as Blob | null)?.type).toBe(XLSX_MIME);
  });
});
