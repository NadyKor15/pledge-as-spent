import { DemoStart } from "@/ui/DemoStart";
import "@/ui/landing.css";

// Links appear only when the deployment sets them: no empty placeholders.
const CODE_URL = process.env.NEXT_PUBLIC_CODE_URL?.trim();
const VIDEO_URL = process.env.NEXT_PUBLIC_VIDEO_URL?.trim();

export default function Home() {
  return (
    <main className="ld-page">
      <div className="ld-col">
        <div className="ld-brand">Pledge-as-Spent</div>
        <h1>A donor’s pledge stays a PayPal hold: money moves only for receipt lines that pass the checks, and the rest goes back.</h1>
        <DemoStart />
        <p className="ld-badge">Fictional drive · PayPal Sandbox · no real money moves</p>
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
        {(CODE_URL || VIDEO_URL) && (
          <p className="ld-links">
            {CODE_URL && <a href={CODE_URL}>Source code</a>}
            {VIDEO_URL && <a href={VIDEO_URL}>Demo video</a>}
          </p>
        )}
      </div>
    </main>
  );
}
