"use client";

import Link from "next/link";
import { useState } from "react";
import type { DriveView, StatementView } from "../types";
import { classes } from "../cls";
import { saveBytes, XLSX_MIME } from "./download";
import { buildStatementXlsx, statementFileName } from "./xlsx";
import "./actions.css";

const s = classes("sx");

/** Two ways to keep the statement: a workbook built in the browser from the statement the page already holds, and the printable page. */
export function StatementActions({ data, view }: { data: StatementView; view: DriveView }) {
  const [failed, setFailed] = useState(false);
  const download = () => {
    try {
      saveBytes(buildStatementXlsx(data, { driveTitle: view.drive.displayTitle }), statementFileName(data), XLSX_MIME);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return (
    <section className={s.actions} aria-label="Keep your statement">
      <button type="button" className={s.btn} onClick={download} data-testid="statement-xlsx">
        Download my statement (.xlsx)
      </button>
      <Link className={s.btn} href={`/pledge/${encodeURIComponent(data.statement.pledgeId)}/print`} target="_blank" rel="noopener" data-testid="statement-pdf">
        Print or save as PDF
      </Link>
      {failed && (
        <p className={s.err} role="alert">
          The workbook could not be made in this browser. Use the PDF page instead.
        </p>
      )}
    </section>
  );
}
