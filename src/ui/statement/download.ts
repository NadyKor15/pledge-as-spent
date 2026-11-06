export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface Env {
  document: { createElement(tag: "a"): HTMLAnchorElement; body: { append(n: Node): void } };
  url: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
  defer: (f: () => void) => void;
}

/** Offers bytes to the user as a file download. The URL is released a little later, once the browser has taken it. */
export function saveBytes(bytes: Uint8Array<ArrayBuffer> | Uint8Array, name: string, mime: string, env: Env = { document, url: URL, defer: (f) => void setTimeout(f, 4000) }): void {
  const url = env.url.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = env.document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  env.document.body.append(a);
  a.click();
  env.defer(() => {
    a.remove();
    env.url.revokeObjectURL(url);
  });
}
