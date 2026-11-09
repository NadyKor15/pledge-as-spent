import { afterAll, describe, expect, it } from "vitest";
import { GET as countGET } from "../../src/app/api/showcase/count/route";
import { setServiceForTests } from "../../src/server/runtime";
import { DEFAULT_SHOWCASE_DRIVE_ID } from "../../src/ui/showcase";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes } from "./support/harness";

// The landing page's count of the finished drive, added up on the server by the Ledger's own derive. A deployment
// without that drive answers 200 with no line, so the landing page never shows a failed request.

afterAll(() => setServiceForTests(undefined));

describe("GET /api/showcase/count", () => {
  it("no such drive here: 200, no line", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch });
    setServiceForTests(h.svc);
    const res = await countGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ driveId: DEFAULT_SHOWCASE_DRIVE_ID, line: null });
  });

  it("the finished drive: pledged, paid for checked lines, never charged", async () => {
    const sb = fakeSandbox();
    const h = await harness({ fetch: sb.fetch, limits: { lookupGraceMinutes: 0 } });
    setServiceForTests(h.svc);
    await h.svc.createDemoDrive({ driveId: DEFAULT_SHOWCASE_DRIVE_ID });
    await h.svc.submitReceipt({ driveId: DEFAULT_SHOWCASE_DRIVE_ID, bytes: heroBytes() });
    await h.svc.captureNow(DEFAULT_SHOWCASE_DRIVE_ID);
    // Open, it says nothing: "never charged" is not true yet.
    expect((await (await countGET()).json()).line).toBeNull();
    await h.svc.closeDrive(DEFAULT_SHOWCASE_DRIVE_ID);
    await h.svc.reconcile(DEFAULT_SHOWCASE_DRIVE_ID, { graceMinutes: 0 });
    const body = await (await countGET()).json();
    // A closed drive's book no longer changes: the line is kept a minute, so landing visits do not replay the book.
    const reads = { n: 0 };
    const read = h.svc.getDriveView.bind(h.svc);
    h.svc.getDriveView = (async (id: string) => {
      reads.n += 1;
      return read(id);
    }) as typeof h.svc.getDriveView;
    expect((await (await countGET()).json()).line).toBe(body.line);
    expect(reads.n).toBe(0);
    expect(body.line).toMatch(/^On the finished drive, donors pledged ¥[\d,]+: ¥5,224 paid for checked receipt lines, and ¥[\d,]+ was never charged\.$/);
  });
});
