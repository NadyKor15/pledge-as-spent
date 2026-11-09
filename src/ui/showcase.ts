// The finished drive the landing page shows without writing anything: its Ledger and one donor's statement. A
// deployment can point at a newer closed drive with NEXT_PUBLIC_SHOWCASE_DRIVE_ID; no code changes for that.

/** The closed demo drive of the README's table (evidence/control-drive-20261109-810b24be50.json). */
export const DEFAULT_SHOWCASE_DRIVE_ID = "demo-810b24be50";

export const SHOWCASE_DRIVE_ID = process.env.NEXT_PUBLIC_SHOWCASE_DRIVE_ID?.trim() || DEFAULT_SHOWCASE_DRIVE_ID;

/** Read-only pages of a finished drive: its Ledger, and Mark's statement (a demo pledge id is `<drive>.<key>`). */
export function showcaseLinks(driveId: string = SHOWCASE_DRIVE_ID): { ledger: string; statement: string } {
  return {
    ledger: `/drive/${encodeURIComponent(driveId)}?as=ledger`,
    statement: `/pledge/${encodeURIComponent(`${driveId}.diapers`)}`,
  };
}

/** The README's "Judge it in 90 seconds" on the code's page, when the deployment names it. */
export function readmeJudgeUrl(codeUrl: string | null | undefined): string | null {
  const base = codeUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}#judge-it-in-90-seconds` : null;
}
