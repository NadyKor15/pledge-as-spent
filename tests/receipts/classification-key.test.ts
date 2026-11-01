import { describe, expect, it } from "vitest";
import { classificationKey } from "../../src/receipts/recorded";
import { SHIPPED_ANSWERS } from "../../src/server/reading";
import { demoDrive } from "../../src/server/demo";

const { drive, needs } = demoDrive("any", "2026-11-01T00:00:00Z");
const saved = SHIPPED_ANSWERS[0];

describe("classification key", () => {
  it("the shipped answer matches the demo drive, so the sample receipt needs no model call", () => {
    expect(classificationKey(saved.reading, needs, drive.rules)).toBe(saved.classifiedFor);
  });

  it("does not move when a personal-data box differs in its last digit", () => {
    const nudged = structuredClone(saved.reading);
    const box = nudged.pii.find((p) => p.bbox)!.bbox!;
    box.x = box.x * (1 + Number.EPSILON);
    expect(box.x).not.toBe(saved.reading.pii.find((p) => p.bbox)!.bbox!.x);
    expect(classificationKey(nudged, needs, drive.rules)).toBe(saved.classifiedFor);
  });

  it("moves when a line, a need or a rule changes", () => {
    const other = structuredClone(saved.reading);
    other.lines[0].amountMinor += 1;
    expect(classificationKey(other, needs, drive.rules)).not.toBe(saved.classifiedFor);
    expect(classificationKey(saved.reading, needs.slice(1), drive.rules)).not.toBe(saved.classifiedFor);
    expect(classificationKey(saved.reading, needs, `${drive.rules} More.`)).not.toBe(saved.classifiedFor);
  });
});
