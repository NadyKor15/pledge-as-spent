import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LineBox } from "../../src/receipts/types";
import { SHIPPED_ANSWERS } from "../../src/server/reading";
import { fakeSandbox } from "./support/fake-sandbox";
import { harness, heroBytes, ROOT } from "./support/harness";

// Where each line of a receipt is printed travels from the reader to the drive view, and the sample receipt
// carries boxes measured once with Tesseract (tools/receipts/line-boxes.ts), so the demo never calls a model for them.

const sidecar = JSON.parse(readFileSync(path.join(ROOT, "eval/live/shipped/hero-ja-01.lines.json"), "utf8")) as { imageSha256: string; lineBoxes: unknown[] };

describe("the sample receipt's line boxes", () => {
  it("come from the rows Meta's second reading named for each of its 11 lines, measured on the sample photo itself", () => {
    const saved = SHIPPED_ANSWERS[0];
    expect(sidecar.imageSha256).toBe(saved.imageSha256);
    const boxes = saved.lineBoxes!.map((b) => LineBox.parse(b));
    expect(boxes.map((b) => b.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Printed top to bottom, inside the paper (the desk is around it), each one to three rows high.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].box.y).toBeGreaterThan(boxes[i - 1].box.y);
    for (const { box } of boxes) {
      expect(box.x).toBeGreaterThan(0.1);
      expect(box.x + box.w).toBeLessThan(0.9);
      expect(box.h).toBeLessThan(0.07);
    }
    // Each box overlaps the row Tesseract once measured for the same line (eval/live/shipped/hero-ja-01.lines.json).
    const old = sidecar.lineBoxes.map((b) => LineBox.parse(b));
    for (const o of old) {
      const n = boxes.find((b) => b.lineNo === o.lineNo)!.box;
      const mid = o.box.y + o.box.h / 2;
      expect(mid).toBeGreaterThan(n.y);
      expect(mid).toBeLessThan(n.y + n.h);
    }
    expect(saved.purchaseLines!.map((p) => p.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("reach the drive view with the sample receipt, and a second copy of the photo keeps them", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch, savedAnswers: SHIPPED_ANSWERS });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-boxes" })).drive.id;
    const first = (await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt;
    expect(first.lines.map((l) => l.box)).toEqual(SHIPPED_ANSWERS[0].lineBoxes!.map((b) => b.box));
    const again = (await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt;
    expect(again.reader).toBe("copy");
    expect(again.lines.map((l) => l.box)).toEqual(first.lines.map((l) => l.box));
    const v = await h.svc.getDriveView(driveId);
    expect(v.receipts[0].lines.find((l) => l.lineNo === 4)?.box).toEqual(SHIPPED_ANSWERS[0].lineBoxes!.find((b) => b.lineNo === 4)?.box);
  });

  it("a reading without boxes (the truth files in tests) stores none, and the view says null", async () => {
    const h = await harness({ fetch: fakeSandbox().fetch, savedAnswers: [] });
    const driveId = (await h.svc.createDemoDrive({ driveId: "demo-noboxes" })).drive.id;
    const r = (await h.svc.submitReceipt({ driveId, bytes: heroBytes() })).receipt;
    expect(r.reader).toBe("recorded");
    expect(r.lines.every((l) => l.box === null)).toBe(true);
  });
});
