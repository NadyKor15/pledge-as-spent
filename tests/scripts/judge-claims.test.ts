import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMS } from "../../scripts/judge-claims";

// `npm run judge` prints the README's claims as the README words them: the list in scripts/judge-claims.ts and the
// "Judge it in 90 seconds" table may not drift apart, and every test a claim leans on must exist.

const ROOT = path.resolve(__dirname, "../..");

function tableClaims(readme: string): string[] {
  const start = readme.indexOf("## Judge it in 90 seconds");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  return section
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Claim ") && !l.startsWith("|---"))
    .map((l) => l.split("|")[1].trim());
}

describe("npm run judge", () => {
  it("names the README table's claims word for word, in its order", () => {
    const table = tableClaims(readFileSync(path.join(ROOT, "README.md"), "utf8"));
    expect(table.length).toBeGreaterThan(0);
    expect(CLAIMS.map((c) => c.claim)).toEqual(table);
  });

  it("must differ: a claim reworded in the README is noticed", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8").replace("| Ask PayPal yourself |", "| Ask PayPal |");
    expect(CLAIMS.map((c) => c.claim)).not.toEqual(tableClaims(readme));
  });

  it("leans only on tests that exist", () => {
    for (const c of CLAIMS) {
      expect(c.tests.length, c.claim).toBeGreaterThan(0);
      for (const t of c.tests) {
        const file = path.join(ROOT, t.file);
        expect(existsSync(file), t.file).toBe(true);
        const text = readFileSync(file, "utf8");
        for (const title of t.titles ?? []) expect(text.includes(`it("${title}`), `${t.file}: ${title}`).toBe(true);
      }
    }
  });
});
