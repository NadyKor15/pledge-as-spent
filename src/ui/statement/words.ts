import type { Statement } from "../types";

/** A share's state in the donor's words; the same wording in the workbook and on the printed page. */
export const STATUS_WORDS: Record<Statement["rows"][number]["status"], string> = {
  captured: "Captured",
  partly_reversed: "Captured, partly taken back",
  reversed: "Taken back by PayPal",
  uncollected: "Not collected",
  capture_pending: "Capture pending",
  accrued: "Waiting for capture",
  nothing_to_capture: "Nothing to capture",
};
