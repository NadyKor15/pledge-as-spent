import qrcode from "qrcode-generator";

// The poster's QR code, from qrcode-generator (pinned in package.json): its modules, and one SVG path of the dark ones.

/** The code's modules, row by row; true is dark. Error correction M: a printed poster can take a scuff. */
export function qrModules(text: string): boolean[][] {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

/** The dark modules as one path in module units (one unit = one module), for an SVG of viewBox 0 0 n n. */
export function qrPath(modules: boolean[][]): string {
  let d = "";
  modules.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < row.length && row[c]) c++;
      d += `M${start} ${r}h${c - start}v1h${start - c}z`;
    }
  });
  return d;
}
