import { describe, expect, it } from "vitest";
import { demoPledgeId } from "../../src/server/demo";
import { DEFAULT_SHOWCASE_DRIVE_ID, readmeJudgeUrl, showcaseLinks } from "../../src/ui/showcase";

describe("the landing page's finished drive", () => {
  it("opens the closed demo drive's Ledger and Mark's statement, nothing that writes", () => {
    expect(DEFAULT_SHOWCASE_DRIVE_ID).toBe("demo-f372326129");
    expect(showcaseLinks(DEFAULT_SHOWCASE_DRIVE_ID)).toEqual({ ledger: "/drive/demo-f372326129?as=ledger", statement: "/pledge/demo-f372326129.diapers" });
  });

  it("follows another drive id without a code change", () => {
    const id = "demo-0123456789";
    expect(showcaseLinks(id)).toEqual({ ledger: `/drive/${id}?as=ledger`, statement: `/pledge/${demoPledgeId(id, "diapers")}` });
  });

  it("points at the README's 90-second path only when the code's address is set", () => {
    expect(readmeJudgeUrl("https://github.com/someone/pledge-as-spent/")).toBe("https://github.com/someone/pledge-as-spent#judge-it-in-90-seconds");
    expect(readmeJudgeUrl("")).toBeNull();
    expect(readmeJudgeUrl(undefined)).toBeNull();
  });
});
