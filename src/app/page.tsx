import Link from "next/link";
import { DemoStart } from "@/ui/DemoStart";
import { FLORIDA_SCENARIO, floridaDemoOn } from "@/ui/demo-flags";
import { readmeJudgeUrl, showcaseLinks } from "@/ui/showcase";
import "@/ui/landing.css";

// Links appear only when the deployment sets them: no empty placeholders.
const CODE_URL = process.env.NEXT_PUBLIC_CODE_URL?.trim();
const VIDEO_URL = process.env.NEXT_PUBLIC_VIDEO_URL?.trim();
// The second demo drive waits for its scenario on the server: off unless NEXT_PUBLIC_FLORIDA_DEMO=on.
const FLORIDA = floridaDemoOn(process.env.NEXT_PUBLIC_FLORIDA_DEMO);

export default function Home() {
  const finished = showcaseLinks();
  const readme = readmeJudgeUrl(CODE_URL);
  return (
    <main className="ld-page">
      <div className="ld-col">
        <div className="ld-brand">Pledge-as-Spent</div>
        <h1>A donor’s pledge stays a PayPal hold: money moves only for receipt lines that pass the checks, and the rest goes back.</h1>
        <p className="ld-for">For small relief drives and mutual-aid groups that already take PayPal, and for the donors who want to see what their money bought.</p>

        {/* Everything here only reads: a finished drive, a statement, the README. Nothing is held or charged. */}
        <section className="ld-judge" aria-labelledby="ld-judge-title">
          <h2 id="ld-judge-title">Judging Pledge-as-Spent? See the whole thing in 90 seconds.</h2>
          <ol>
            <li>
              <Link href={finished.ledger}>See a finished drive</Link>: the Ledger, where every pledge was spent on receipt lines or went back. Its “Ask PayPal yourself” reads every hold, capture and payout back from PayPal.
            </li>
            <li>
              <Link href={finished.statement}>Read a donor’s statement</Link>: what one donor’s hold bought, line by line.
            </li>
            <li>
              {readme ? <a href={readme}>Judge it in 90 seconds</a> : <b>Judge it in 90 seconds</b>} in the README: the PayPal ids behind each claim.
            </li>
            <li>
              <Link href="/cheat">Try to cheat the receipt</Link>: five forged receipts against the same checks, and what their forged lines would cost donors.
            </li>
          </ol>
          {(VIDEO_URL || CODE_URL) && (
            <p className="ld-links">
              {VIDEO_URL && <a href={VIDEO_URL}>Demo video</a>}
              {CODE_URL && <a href={CODE_URL}>Source code</a>}
            </p>
          )}
          <p className="ld-badge">Fictional drive · PayPal Sandbox · no real money moves</p>
        </section>

        <div className="ld-opens">
          <DemoStart />
          {FLORIDA && <DemoStart scenario={FLORIDA_SCENARIO} label="Open the Florida drive" busyLabel="Placing holds at PayPal for the Florida drive…" secondary />}
        </div>
        <p className="ld-hint">Places 4 new sandbox holds: three donors and the company match.</p>
        {FLORIDA && <p className="ld-hint">The Florida drive: hurricane relief in US dollars, through the same checks.</p>}
        <ol className="ld-steps">
          <li>
            <b>Send a receipt.</b> Press “Use the sample receipt”. AI reads every line, approves what the shelter needs and refuses the rest.
          </li>
          <li>
            <b>Follow the money.</b> Each approved line is split across donor holds and the company match. “Capture now” takes only those shares at PayPal.
          </li>
          <li>
            <b>Close the drive.</b> “Close drive” sends what is left of every hold back to its donor. Open a donor’s name to read what that pledge bought.
          </li>
          <li>
            <b>See where the money went.</b> The Ledger puts every pledge on one page: spent, returned, and the receipt lines behind each yen.
          </li>
        </ol>
      </div>
    </main>
  );
}
