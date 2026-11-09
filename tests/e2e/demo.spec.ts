import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import type { DriveView } from "../../src/ui/types";
import { noNeedReceiptBytes } from "./support/no-need-receipt";

// SPEC-ui §3: open /, create the demo, take the sample receipt as coordinator,
// see 9 approved / 2 rejected and ¥10,448, close the drive, see "released" on
// every hold. The other screens are checked on the same drive.

async function openDemo(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo drive" }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** The lookup that confirms captures runs on the capture button: press until PayPal's word is on screen. */
async function captureUntilCompleted(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: /^(Capture now|Check PayPal)$/ }).click();
    await expect(page.locator(".co-capDone")).toContainText("PayPal captured", { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
}

/** Close, through its confirmation. */
async function closeDrive(page: Page) {
  await page.getByRole("button", { name: "Close drive" }).click();
  await page.getByRole("button", { name: "Yes, close the drive" }).click();
  await expect(page.getByRole("link", { name: "See where the money went" })).toBeVisible({ timeout: 45_000 });
}

/** A PNG over the upload limit: random noise does not compress. */
function hugePng(width = 1400, height = 1400): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = Math.floor(Math.random() * 256);
    png.data[i + 1] = Math.floor(Math.random() * 256);
    png.data[i + 2] = Math.floor(Math.random() * 256);
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png, { deflateLevel: 1 });
}

test("the way in: who it is for, a judge's read-only path, one action that writes, and no empty links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("For small relief drives and mutual-aid groups that already take PayPal, and for the donors who want to see what their money bought.")).toBeVisible();
  await expect(page.locator(".ld-promise")).toHaveText("Your €20 for water can only buy water.");
  const judge = page.locator(".ld-judge");
  await expect(judge.getByRole("heading")).toHaveText("Judging Pledge-as-Spent? See the whole thing in 90 seconds.");
  await expect(judge.getByRole("link", { name: "See a finished drive" })).toHaveAttribute("href", "/drive/demo-810b24be50?as=ledger");
  await expect(judge.getByRole("link", { name: "Read a donor’s statement" })).toHaveAttribute("href", "/pledge/demo-810b24be50.diapers");
  await expect(judge).toContainText("Judge it in 90 seconds in the README");
  // What if we vanish: the hold's end date is PayPal's, on the statement, next to Withdraw.
  await expect(judge.locator("li")).toHaveCount(5);
  await expect(judge.locator("li").last()).toContainText("What if we vanish? A pledge is a PayPal hold with an end date PayPal sets.");
  await expect(judge.getByRole("link", { name: "A donor’s statement", exact: true })).toHaveAttribute("href", "/pledge/demo-810b24be50.diapers");
  // The count of the finished drive comes from that drive; the test server has none, so there is no line, and no failed request.
  await expect(page.getByTestId("landing-count")).toHaveCount(0);
  await expect(judge).toContainText("Fictional drive · PayPal Sandbox · no real money moves");
  await expect(page.getByRole("button", { name: "Open the demo drive" })).toBeVisible();
  await expect(page.getByText("Places 4 new sandbox holds")).toBeVisible();
  await expect(page.locator(".ld-steps li")).toHaveCount(4);
  await expect(page.locator(".ld-steps li").last()).toContainText("See where the money went");
  // The test server sets no video or code address: no empty links for them.
  await expect(page.getByRole("link", { name: /source code|demo video|^Judge it in 90 seconds$/i })).toHaveCount(0);
  await expect(page.getByText("To get started")).toHaveCount(0);
});

test("the judges' path: sample receipt, captures, close, statement", async ({ page }) => {
  const driveId = await openDemo(page);

  await expect(page.getByText("Kitasora Community Shelter").first()).toBeVisible();
  await expect(page.getByText("flood relief")).toHaveCount(0);

  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await expect(page.locator(".co-rej")).toHaveCount(2);
  await expect(page.getByText(/¥10,448/).first()).toBeVisible();
  // As the README says: the sample's reading is a saved one, and the refused lines add up to one number.
  await expect(page.getByTestId("read-mark")).toHaveText("Saved AI reading");
  await expect(page.getByTestId("refused-sum")).toHaveText("Refused: ¥4,198 of ¥14,646 never reaches a donor");

  await captureUntilCompleted(page);
  await expect(page.locator(".co-card", { hasText: "Mark" })).toContainText("$21.45");
  await expect(page.locator(".co-card", { hasText: "Mark" })).toContainText("$8.55");

  // Volunteer: the result from the API, with the name from the API.
  await page.goto(`/drive/${driveId}?as=volunteer`);
  await expect(page.getByText("9 lines approved")).toBeVisible();
  await expect(page.getByText("2 refused")).toBeVisible();
  await expect(page.getByText("¥10,448 sent to your PayPal")).toBeVisible();
  await expect(page.getByText("Volunteer Haruto reimbursed")).toBeVisible();

  // Statement before the close: spent, held, the receipt and the honest hold line.
  await page.goto(`/pledge/${driveId}.water`);
  await expect(page.getByText("Your pledge to")).toBeVisible();
  await expect(page.locator(".st-sSpent")).toContainText("€4.58");
  await expect(page.locator(".st-sHeld")).toContainText("€15.42");
  await expect(page.getByText("€9.16 of help.")).toBeVisible();
  await expect(page.getByText("12 bottles of water 2 L").first()).toBeVisible();
  await expect(page.locator(".st-hold")).toContainText("expires");
  await expect(page.locator("body")).not.toContainText(/renew|extended/i);
  const photo = page.locator(".st-win img").first();
  await expect(photo).toHaveJSProperty("complete", true);
  expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // Donor view: no hidden renewal promise, the pledge form says what PayPal will say.
  await page.goto(`/drive/${driveId}?as=donor`);
  await expect(page.getByText("PayPal will say “Pay”").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/renew|extended/i);

  await page.goto(`/drive/${driveId}?as=coordinator`);
  await closeDrive(page);
  const holds = page.locator(".co-card");
  await expect(holds).toHaveCount(4);
  for (const hold of await holds.all()) await expect(hold).toContainText("never charged");
  // Four voids came after the payout: it still stands in PayPal's list.
  await expect(page.locator(".co-act", { hasText: "Payout to Haruto" })).toContainText("¥10,448");

  await page.goto(`/pledge/${driveId}.water`);
  await expect(page.locator(".st-sRel")).toContainText("€15.42");
  await expect(page.getByRole("button", { name: "Withdraw pledge" })).toHaveCount(0);
});

test("volunteer: a photo over the limit is shrunk in the browser before it is sent", async ({ page }) => {
  const driveId = await openDemo(page);
  // multipart bodies are not visible to Playwright: measure the file where the page hands it over.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const image = init?.body instanceof FormData ? init.body.get("image") : null;
      if (image instanceof Blob) sessionStorage.setItem("uploaded", JSON.stringify({ size: image.size, type: image.type }));
      return real(input, init);
    };
  });
  await page.goto(`/drive/${driveId}?as=volunteer`);
  const big = hugePng();
  expect(big.length).toBeGreaterThan(3.5 * 1024 * 1024);
  await page.getByLabel("Receipt photo").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: big });
  await expect(page.locator(".vo-cErr")).toBeVisible();
  const uploaded = JSON.parse((await page.evaluate(() => sessionStorage.getItem("uploaded"))) ?? "null") as { size: number; type: string };
  expect(uploaded.type).toBe("image/jpeg");
  expect(uploaded.size).toBeGreaterThan(0);
  expect(uploaded.size).toBeLessThanOrEqual(3.5 * 1024 * 1024);
});

// The service in tests/e2e/server.ts is loaded outside the Next bundle, so its
// ServiceError fails the route's instanceof and comes back as a 500. These
// answers are therefore given to the page as the real API words them.
const LIMITS = [
  { status: 503, error: "live_reading_off", message: "Live receipt reading is not switched on for this server. Use the sample receipt." },
  { status: 429, error: "live_limit", message: "This network has used its 30 live receipt readings for today. Try again tomorrow, or use the sample receipt." },
  { status: 429, error: "spend_cap", message: "The demo's budget for live receipt reading is used up. Use the sample receipt." },
];

test("volunteer: a limit refusal is said in plain words and points to the sample, which then works", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.goto(`/drive/${driveId}?as=volunteer`);
  const small = new PNG({ width: 8, height: 8 });
  const file = { name: "receipt.png", mimeType: "image/png", buffer: PNG.sync.write(small) };
  for (const limit of LIMITS) {
    await page.route("**/receipts", (r) => r.fulfill({ status: limit.status, json: { error: limit.error, message: limit.message } }));
    await page.getByLabel("Receipt photo").setInputFiles(file);
    const box = page.locator(".vo-cErr");
    await expect(box).toContainText(limit.message);
    await expect(box).toContainText("The sample receipt needs no live reading");
    await page.unroute("**/receipts");
  }
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  // No webhook comes here, so the payout stays on its way until the next lookup.
  await expect(page.getByText("¥10,448 on its way to your PayPal")).toBeVisible();

  // The same photo again: flagged, no money moves, and the screen says so.
  await page.getByRole("button", { name: "Upload another receipt" }).click();
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.getByText("Waiting for the coordinator")).toBeVisible();
  await expect(page.getByText("With the coordinator")).toBeVisible();
});

test("a file that is not a photo gets a plain refusal, nothing is sent", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.goto(`/drive/${driveId}?as=volunteer`);
  let posted = false;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/receipts")) posted = true;
  });
  await page.getByLabel("Receipt photo").setInputFiles({ name: "receipt.webp", mimeType: "image/webp", buffer: Buffer.from("not a photo") });
  await expect(page.locator(".vo-cErr")).toContainText("could not be opened as a photo");
  expect(posted).toBe(false);
});

test("a line that names no need of the drive: approval waits for the need the coordinator picks, then the line is paid", async ({ page }) => {
  const driveId = await openDemo(page);
  const up = await page.request.post(`/api/drives/${driveId}/receipts`, { multipart: { image: { name: "receipt.png", mimeType: "image/png", buffer: noNeedReceiptBytes() } } });
  expect(up.status()).toBe(201);
  await page.reload();

  const decide = page.locator(".co-decide");
  await expect(decide).toBeVisible();
  await decide.getByLabel(/Also approve line 1/).check();
  await decide.getByLabel(/Also approve line 3/).check();
  await decide.getByLabel("Reason").fill("Two boxes and one bottle of water, checked against the photo");
  const approve = decide.getByRole("button", { name: "Approve" });
  await expect(approve).toBeDisabled();
  await expect(decide.getByText("pick the need this line bought")).toBeVisible();
  // Only the drive's open needs are offered.
  await expect(decide.getByLabel("Need line 1 bought").locator("option")).toHaveText(["pick a need…", "Water 2 L", "Diapers size M", "AA batteries"]);
  await decide.getByLabel("Need line 1 bought").selectOption("water");
  await expect(approve).toBeDisabled();
  await decide.getByLabel("Need line 3 bought").selectOption("water");
  await expect(decide.getByText("pick the need this line bought")).toHaveCount(0);
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(page.locator(".co-decide")).toHaveCount(0);
  const kept = page.locator(".co-pill");
  await expect(kept).toHaveCount(2);
  await expect(page.locator(".co-pillWait")).toHaveCount(0);
  for (const pill of await kept.all()) await expect(pill).toContainText("Water 2 L");
  await expect(page.locator(".co-rej")).toHaveCount(1);
  await expect(page.locator(".co-rej")).toContainText("Gift card");
  await expect(page.locator("body")).not.toContainText("a need this drive does not have");
  // The money goes: the two water lines are split across the water holds, and Haruto is paid for them. (The recorded
  // sandbox answers only the sample receipt's capture requests, so this receipt's captures are not followed here.)
  await expect(page.locator(".co-wrow", { hasText: "Water 2 L" })).toContainText("¥1,854 = Lena ¥927");
  await expect(page.locator(".co-act", { hasText: "Payout to Haruto" })).toContainText("¥1,854");
});

test("receipt lines read in English first, the printed text stays small beside them", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await expect(page.locator(".co-pill b").first()).toContainText("Water 2 L");
  const refused = page.locator(".co-rej");
  await expect(refused.nth(0)).toContainText("Alcohol");
  await expect(refused.nth(1)).toContainText("Gift card");
  await expect(page.getByText("Canned peel")).toHaveCount(0);
  await expect(refused.nth(0).locator("small")).toContainText("350");
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/coordinator-1280.png`, fullPage: true });
    for (const role of ["donor", "volunteer"]) {
      await page.goto(`/drive/${driveId}?as=${role}`);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${process.env.SHOTS}/${role}-1280.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const role of ["coordinator", "donor", "volunteer"]) {
      await page.goto(`/drive/${driveId}?as=${role}`);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${process.env.SHOTS}/${role}-390.png`, fullPage: true });
    }
  }
});

test("at 390 px neither the coordinator nor the donor screen is wider than the window", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const role of ["coordinator", "donor", "shelter", "volunteer"]) {
    await page.goto(`/drive/${driveId}?as=${role}`);
    await expect(page.locator("header")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, role).toBeLessThanOrEqual(0);
  }
  // The phone's role menu moves between screens and closes behind itself.
  await page.locator("header summary").click();
  await page.getByRole("link", { name: "Donor" }).click();
  await expect(page).toHaveURL(/as=donor$/);
  await expect(page.locator("header details")).not.toHaveAttribute("open");
});

test("a desktop window turned into a phone (device mode) lays the coordinator and the Ledger out in one column, with no update loop", async ({ page }) => {
  // The desktop stage on a phone made the phone zoom out to fit it: innerWidth read 1137 at scale 0.343, the stage
  // stayed wide for that width, and narrowing it moved the zoom again ("Maximum update depth exceeded", React #185).
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const driveId = await openDemo(page);
  const cdp = await page.context().newCDPSession(page);
  const device = async (phone: boolean) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", phone ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 5 : 1 });
  };
  for (const [role, stacked] of [
    ["coordinator", ".sc-stack"],
    ["ledger", '.lg-screen[data-stacked="true"]'],
  ] as const) {
    await page.goto(`/drive/${driveId}?as=${role}`);
    await expect(page.locator("header.hd-top")).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await device(true);
      await expect(page.locator(stacked).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), role).toBeLessThanOrEqual(0);
      await device(false);
      await expect(page.locator(stacked)).toHaveCount(0);
    }
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  expect(errors.filter((m) => /#185|Maximum update depth/.test(m))).toEqual([]);
});

test("an unknown pledge and an unknown drive say so and lead back", async ({ page }) => {
  await page.route("**/api/pledges/nope/statement", (r) => r.fulfill({ status: 404, json: { error: "unknown_pledge", message: "No pledge nope." } }));
  await page.route("**/api/drives/nope", (r) => r.fulfill({ status: 404, json: { error: "unknown_drive", message: "No drive nope." } }));
  await page.goto("/pledge/nope");
  await expect(page.getByRole("heading", { name: "No such pledge" })).toBeVisible();
  await page.goto("/drive/nope?as=coordinator");
  await expect(page.getByRole("heading", { name: "No such drive" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open a new demo drive" })).toBeVisible();
});

// The Ledger tab, on the two real snapshots of GET /api/drives and on a drive taken through the app.

type Snapshot = "closed" | "open";

const snapshot = (name: Snapshot) => readFileSync(path.join(__dirname, `../fixtures/drives/${name}.json`), "utf8");

async function openLedger(page: Page, name: Snapshot, body = snapshot(name)) {
  const id = (JSON.parse(body) as { drive: { id: string } }).drive.id;
  await page.route(`**/api/drives/${id}`, (r) => r.fulfill({ contentType: "application/json", body }));
  await page.goto(`/drive/${id}?as=ledger`);
  await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
  return id;
}

const totals = (page: Page) => page.locator(".ag-studio-value-widget-content");
const bookRows = (page: Page) => page.locator(".ag-row");
const book = (page: Page) => page.locator(".ag-root-wrapper");

/**
 * Book cells whose text does not fit. An ellipsis hides from scrollWidth and from ranges, so each text
 * is measured on its own in its own font. A cell of several lines (the receipt strip over the name, the
 * label over a PayPal number) is measured line by line; a line that is meant to wrap (a refusal's reason)
 * is left out. `.ag-cell[data-control]` is the synthetic proof it can fail.
 */
const cutShort = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    document.body.append(probe);
    const out: string[] = [];
    for (const cell of document.querySelectorAll<HTMLElement>(".ag-cell")) {
      const style = getComputedStyle(cell);
      const room = cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const leaves = [...cell.querySelectorAll<HTMLElement>("*")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() !== "" && !e.closest(".lg-band"));
      for (const leaf of leaves.length ? leaves : [cell]) {
        const own = getComputedStyle(leaf);
        if (leaf !== cell && own.whiteSpace !== "nowrap") continue;
        probe.style.font = own.font;
        probe.style.letterSpacing = own.letterSpacing;
        probe.textContent = leaf.textContent;
        if (probe.getBoundingClientRect().width > room) out.push(leaf.textContent ?? "");
      }
    }
    probe.remove();
    return out;
  });

async function expectTotals(page: Page, third: string) {
  await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: third })).toHaveCount(1);
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"], { timeout: 10_000 });
  // One equation under the donors' figure, not a second "spent": the match and what the two bought.
  await expect(page.locator("body")).toContainText("+ company match ¥5,224 = ¥10,448 bought");
  await expect(page.locator(".lg-kicker")).toHaveText("Bought for the shelter");
}

/** Every pair of labels whose boxes touch; empty when nothing is laid over anything. */
const crowded = (page: Page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll("[data-label]")].map((e) => ({ text: e.textContent, r: e.getBoundingClientRect() }));
    const out: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i].r, boxes[j].r];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`${boxes[i].text} × ${boxes[j].text}`);
      }
    }
    const marks = [...document.querySelectorAll(".lg-ring, .lg-head")].map((e) => e.getBoundingClientRect());
    for (const { text, r } of boxes) {
      for (const m of marks) if (r.left < m.right && m.left < r.right && r.top < m.bottom && m.top < r.bottom) out.push(`${text} × a dot or arrowhead`);
    }
    return { count: boxes.length, marks: marks.length, out };
  });

const wider = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const runningAnimations = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`ledger at ${width} px: closed drive, the money went back`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openLedger(page, "closed");
    await expectTotals(page, "Never charged");
    expect(await wider(page)).toBeLessThanOrEqual(0);
    const labels = await crowded(page);
    expect(labels.count).toBeGreaterThan(8);
    // S1 (TG 6710): only what PayPal took travels; what was never charged has no arc back, and no arrowhead.
    expect(labels.marks).toBe(3);
    expect(labels.out).toEqual([]);
    await expect(page.locator(".lg-back .lg-line")).toHaveCount(0);
    await expect(page.locator(".lg-head")).toHaveCount(0);
    // Every label carries its hold's bar: beside the name on a desktop, a short one beside the city on a phone (T1).
    await expect(page.locator(".lg-label .pas-meter")).toHaveCount(3);
    const body = page.locator("body");
    // Mark's $8.55 never charged: the phone's donors card says it; on the desktop map it is in his label's bar.
    if (width < 600) await expect(body).toContainText("$8.55");
    else await expect(page.locator(".lg-label[data-donor=Mark] .pas-meter")).toHaveAttribute("aria-label", "$21.45 spent, $8.55 never charged");
    await expect(body).toContainText("Refused: Alcohol ¥1,198 · Gift card ¥3,000");
    await expect(page.locator("[data-need=water]")).toContainText("12 of 40 bottles");
    await expect(page.locator("[data-need=diapers]")).toContainText("6 of 6");
    await expect(page.locator("[data-need=batteries]")).toContainText("50 of 50");
    await expect(page.locator(".lg-receipt")).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("link", { name: "Receipt photo" })).toBeVisible();
    const cities = await page.locator(".lg-label").allTextContents();
    expect(cities).toEqual(width < 600 ? ["Columbus", "Berlin", "Osaka"] : ["Mark · Columbus", "Lena · Berlin", "Yuki · Osaka"]);
  });

  test(`ledger at ${width} px: open drive, the money is held and nothing says it returned`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openLedger(page, "open");
    await expectTotals(page, "Held");
    await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: "Donors’ money approved" })).toHaveCount(1);
    await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: "Donors’ money spent" })).toHaveCount(0);
    expect(await wider(page)).toBeLessThanOrEqual(0);
    expect((await crowded(page)).out).toEqual([]);
    await expect(page.locator(".lg-back .lg-line")).toHaveCount(0);
    await expect(page.locator(".lg-spent .lg-line")).toHaveCount(3);
    const body = page.locator("body");
    await expect(body).toContainText("$8.55 held");
    // What the page says about the money; the chat's quick question "How much came back to me?" asks, it says nothing.
    const said = await page.evaluate(() => {
      const chat = [...document.querySelectorAll<HTMLElement>("[data-testid=ask-widget]")];
      chat.forEach((e) => (e.style.display = "none"));
      const text = document.body.innerText;
      chat.forEach((e) => (e.style.display = ""));
      return text;
    });
    expect(said).toContain("$8.55 held"); // the reading sees the page
    expect(said).not.toMatch(/returned/i);
    expect(said).not.toMatch(/ back/);
  });
}

test("ledger: pressing a donor lights up what they paid for and filters the book; pressing again clears", async ({ page }) => {
  await openLedger(page, "closed");
  await expect(book(page)).toBeHidden();
  const open = page.getByRole("button", { name: /Every line of the book/ });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  await expect(book(page)).toBeVisible();
  await expect(bookRows(page)).toHaveCount(20);
  await expect(page.locator(".ag-header-cell-text")).toHaveText(["Line", "Receipt line", "Need", "Payer", "Share", "PayPal capture", "Status"]);
  await expect(page.locator(".ag-row").first()).toContainText("Spent");

  const lena = page.locator("button[data-donor=Lena]");
  await lena.click();
  await expect(lena).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-need=water]")).toHaveClass(/is-on/);
  await expect(page.locator("[data-need=diapers]")).toHaveClass(/is-dim/);
  await expect(page.locator(".lg-tags.is-dim")).toHaveCount(2);
  await expect(bookRows(page)).toHaveCount(6);
  await expect(page.locator(".ag-row").first()).toContainText("Water 2 L");
  await expect(page.locator(".ag-row", { hasText: "Diapers size M" })).toHaveCount(0);

  await lena.click();
  await expect(lena).toHaveAttribute("aria-pressed", "false");
  await expect(bookRows(page)).toHaveCount(20);
  await expect(page.locator(".is-dim")).toHaveCount(0);

  const diapers = page.locator("[data-need=diapers]");
  await diapers.click();
  await expect(diapers).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("button[data-donor=Mark]")).toHaveClass(/is-on/);
  await expect(bookRows(page)).toHaveCount(6);
  await diapers.click();
  await expect(bookRows(page)).toHaveCount(20);
});

test("ledger: the book's text fits, the items get the room, and a selection made while it is closed filters it", async ({ page }) => {
  await openLedger(page, "closed");
  await page.locator("button[data-donor=Mark]").click();
  await expect(book(page)).toBeHidden();
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(book(page)).toBeVisible();
  await expect(bookRows(page)).toHaveCount(6);
  await expect(page.locator(".ag-row", { hasText: "Paper diapers M 18 pieces" }).first()).toBeVisible();

  // The measure itself: a cell that cannot fit is found.
  await page.evaluate(() => {
    const cell = document.createElement("div");
    cell.className = "ag-cell";
    cell.dataset.control = "1";
    cell.style.cssText = "position:absolute;width:30px;overflow:hidden;white-space:nowrap";
    cell.textContent = "a text far too long for its cell";
    document.body.append(cell);
  });
  expect(await cutShort(page)).toEqual(["a text far too long for its cell"]);
  await page.evaluate(() => document.querySelector("[data-control]")?.remove());

  await expect(async () => expect(await cutShort(page)).toEqual([])).toPass({ timeout: 3_000 });

  const width = (name: string) => page.locator(`.ag-header-cell[col-id="book.${name}"]`).evaluate((e) => e.getBoundingClientRect().width);
  const itemWidth = await width("item");
  expect(itemWidth).toBeGreaterThan(300);
  expect(await width("line")).toBeLessThan(100);
  const needOf = { Lena: "Water 2 L", Yuki: "AA batteries", Mark: "Diapers size M" };
  for (const pick of ["Lena", "Yuki", "Mark"] as const) {
    await page.locator(`button[data-donor=${pick}]`).click();
    await expect(page.locator(".ag-row", { hasText: needOf[pick] })).toHaveCount(6);
    await expect(bookRows(page)).toHaveCount(6);
    await expect(async () => {
      expect(await cutShort(page)).toEqual([]);
      expect(await width("item")).toBe(itemWidth);
    }).toPass({ timeout: 3_000 });
  }
});

test("ledger: opening and closing the book moves nothing; Replay still runs it all again", async ({ page }) => {
  await openLedger(page, "closed");
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"], { timeout: 15_000 });
  await expect(async () => expect(await runningAnimations(page)).toBe(0)).toPass({ timeout: 20_000 });
  await page.evaluate(() => {
    const w = window as unknown as { kept: Element[]; started: number };
    w.kept = [...document.querySelectorAll(".ag-studio-value-widget-content, .lg-map, .lg-run, .lg-shelter")];
    w.started = 0;
    document.addEventListener("animationstart", (e) => {
      if ((e.target as Element).closest?.(".lg-map, .lg-shelter")) w.started++;
    });
  });
  const same = () => page.evaluate(() => (window as unknown as { kept: Element[] }).kept.filter((e) => !e.isConnected).length);
  const started = () => page.evaluate(() => (window as unknown as { started: number }).started);

  const button = page.getByRole("button", { name: /Every line of the book/ });
  for (let i = 0; i < 2; i++) {
    await button.click();
    await expect(book(page)).toBeVisible();
    await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"]);
    await button.click();
    await expect(book(page)).toBeHidden();
    await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"]);
  }
  await page.waitForTimeout(400);
  expect(await same()).toBe(0);
  expect(await started()).toBe(0);
  expect(await runningAnimations(page)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Replay" }).click();
  await expect(async () => expect(await started()).toBeGreaterThan(5)).toPass({ timeout: 3_000 });
});

test("ledger: a closed book is out of reach for Tab and for screen readers", async ({ page }) => {
  await openLedger(page, "closed");
  await page.getByRole("button", { name: /Every line of the book/ }).focus();
  const visited = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    visited.push(await page.evaluate(() => Boolean(document.activeElement?.closest(".ag-studio-layout-widget")?.querySelector(".ag-root-wrapper"))));
  }
  expect(visited).not.toContain(true);
  await expect(page.getByRole("grid")).toHaveCount(0);

  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(page.getByRole("grid")).toHaveCount(1);
});

test("ledger: a total under the pointer shows no tooltip of its own number", async ({ page }) => {
  await openLedger(page, "closed");
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"], { timeout: 15_000 });
  const tooltip = page.locator("[class*=tooltip]");
  await totals(page).nth(1).hover({ force: true });
  await page.waitForTimeout(2_600);
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(700, 500);

  // The control: with our rule taken off, Studio's tooltip appears and this locator finds it.
  await page.addStyleTag({ content: ".lg-frame .ag-studio-value-widget-content-container { pointer-events: auto !important; }" });
  await totals(page).nth(1).hover();
  await expect(tooltip.first()).toContainText("¥5,224", { timeout: 4_000 });
});

test("ledger: hovering lights up the pair without touching the book", async ({ page }) => {
  await openLedger(page, "closed");
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(bookRows(page)).toHaveCount(20);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("button[data-donor=Yuki]").hover();
  await expect(page.locator("[data-need=batteries]")).toHaveClass(/is-on/);
  await expect(page.locator("[data-need=water]")).toHaveClass(/is-dim/);
  await expect(bookRows(page)).toHaveCount(20);
  await page.mouse.move(700, 120);
  await expect(page.locator(".is-dim")).toHaveCount(0);
});

test("ledger: the phone presses rows, and the book filters there too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLedger(page, "closed");
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(bookRows(page)).toHaveCount(20);
  expect(await wider(page)).toBeLessThanOrEqual(0);
  const mark = page.locator("[data-donor-row=Mark]");
  await mark.click();
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-need=diapers]")).toHaveClass(/is-on/);
  await expect(bookRows(page)).toHaveCount(6);
  await expect(async () => expect(await cutShort(page)).toEqual([])).toPass({ timeout: 3_000 });
  await mark.click();
  await expect(bookRows(page)).toHaveCount(20);
  const water = page.locator("[data-need=water]");
  await water.click();
  await expect(page.locator("[data-donor-row=Lena]")).toHaveClass(/is-on/);
  await expect(bookRows(page)).toHaveCount(6);
});

test("finding 17: Tab walks the Ledger's buttons in order, Space presses, and the focus is seen whole", async ({ page }) => {
  await openLedger(page, "closed");
  await page.getByRole("link", { name: "Ledger" }).focus();
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => document.activeElement?.getAttribute("data-donor") ?? document.activeElement?.getAttribute("data-need") ?? document.activeElement?.textContent?.trim().slice(0, 28) ?? ""));
  }
  expect(seen.slice(0, 10)).toEqual(["Mark", "Lena", "Yuki", "Replay", "water", "diapers", "batteries", "Receipt photo", "Every line of the book →", "Download the book (CSV)"]);
  await page.getByRole("link", { name: "Ledger" }).focus();
  await page.keyboard.press("Tab");
  const mark = page.locator("button[data-donor=Mark]");
  await expect(mark).toBeFocused();
  const look = await mark.evaluate((e) => {
    const { outlineStyle, outlineWidth } = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top - 3);
    return { outlineStyle, outlineWidth: parseFloat(outlineWidth), underHeader: Boolean(top?.closest("header")) };
  });
  expect(look.outlineStyle).toBe("solid");
  expect(look.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(look.underHeader).toBe(false);
  await page.keyboard.press("Space");
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-need=diapers]")).toHaveClass(/is-on/);
  await page.keyboard.press("Space");
  await expect(mark).toHaveAttribute("aria-pressed", "false");
});

test("ledger: reduced motion shows the finished picture at once and moves nothing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLedger(page, "closed");
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"]);
  expect(await runningAnimations(page)).toBe(0);
  await expect(page.locator(".lg-part").first()).toBeHidden();
  const offset = await page.locator(".lg-spent .lg-line").first().evaluate((e) => getComputedStyle(e).strokeDashoffset);
  expect(parseFloat(offset)).toBe(0);
});

test("ledger: the numbers count up, the arcs draw, it all stops by itself, and Replay runs it again", async ({ page }) => {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { seen: Set<string> }).seen = seen;
    new MutationObserver(() => {
      for (const n of document.querySelectorAll(".ag-studio-value-widget-content")) seen.add(n.textContent ?? "");
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await openLedger(page, "closed");
  expect(await runningAnimations(page)).toBeGreaterThan(0);
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"], { timeout: 15_000 });
  const inBetween = await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen].filter((t) => /^¥[\d,]+$/.test(t) && !["¥10,783", "¥5,224", "¥5,559", "¥0"].includes(t)).length);
  expect(inBetween).toBeGreaterThan(3);

  await expect(async () => expect(await runningAnimations(page)).toBe(0)).toPass({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(await runningAnimations(page)).toBe(0);

  await page.getByRole("button", { name: "Replay" }).click();
  await expect(async () => expect(await runningAnimations(page)).toBeGreaterThan(0)).toPass({ timeout: 2_000 });
  await expect(async () => expect(await runningAnimations(page)).toBe(0)).toPass({ timeout: 20_000 });
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"]);
});

test("ledger: eight donors, an unknown place among them: nothing overlaps and everyone is on the screen", async ({ page }) => {
  const drive = JSON.parse(snapshot("closed")) as { holds: Record<string, unknown>[]; closeReport: Record<string, unknown>[] };
  const more: [string, string | null][] = [
    ["Anna (Oslo)", "NO"],
    ["Ben (Seattle)", "US"],
    ["Chloe (Paris)", "FR"],
    ["Dan (Sydney)", "AU"],
    ["Sam (Nowhere)", null],
  ];
  more.forEach(([donorName, donorCountry], i) => {
    const pledgeId = `extra${i}`;
    drive.holds.splice(3, 0, { ...drive.holds[1], pledgeId, donorName, donorCountry });
    drive.closeReport.splice(3, 0, { ...drive.closeReport[1], pledgeId, donorName });
  });
  const body = JSON.stringify(drive);
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width, height });
    await openLedger(page, "closed", body);
    // Each extra donor copies Mark: $30.00 at 151.20 is ¥4,536, five times over the ¥10,783.
    await expect(totals(page).first()).toHaveText("¥33,463", { timeout: 15_000 });
    expect(await wider(page)).toBeLessThanOrEqual(0);
    expect((await crowded(page)).out).toEqual([]);
    for (const name of ["Lena", "Mark", "Yuki", "Anna", "Ben", "Chloe", "Dan", "Sam"]) await expect(page.locator(".lg-map, .lg-donors").getByText(name).first()).toBeVisible();
  }
});

test("ledger: the tab sits beside the others, and only it loads AG Studio", async ({ page }) => {
  const bytes = new Map<string, number>();
  page.on("response", async (res) => {
    if (res.url().includes(".js")) bytes.set(res.url(), (await res.body().catch(() => Buffer.alloc(0))).length);
  });
  const id = await openLedger(page, "open");
  const nav = page.getByRole("navigation", { name: "Role" });
  await expect(nav.getByRole("link")).toHaveText(["Shelter", "Donor", "Volunteer", "Coordinator", "Ledger"]);
  await expect(nav.getByRole("link", { name: "Ledger" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".ag-studio-root").first()).toBeAttached();

  for (const role of ["shelter", "donor", "volunteer", "coordinator"]) {
    const fresh = await page.context().newPage();
    const loaded = new Map<string, number>();
    fresh.on("response", async (res) => {
      if (res.url().includes(".js")) loaded.set(res.url(), (await res.body().catch(() => Buffer.alloc(0))).length);
    });
    await fresh.route(`**/api/drives/${id}`, (r) => r.fulfill({ contentType: "application/json", body: snapshot("open") }));
    await fresh.goto(`/drive/${id}?as=${role}`, { waitUntil: "networkidle" });
    await expect(fresh.locator("header")).toBeVisible();
    await expect(fresh.locator(".ag-studio-root")).toHaveCount(0);
    const total = [...loaded.values()].reduce((a, b) => a + b, 0);
    expect(total, role).toBeLessThan(800_000);
    await fresh.close();
  }
  const ledgerTotal = [...bytes.values()].reduce((a, b) => a + b, 0);
  expect(ledgerTotal).toBeGreaterThan(1_000_000);
});

test("ledger of a drive taken through the app: held before the close, returned after it", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  // The sample receipt started a re-read of the drive every 2.5 s: the screen must not notice.
  await page.getByRole("navigation", { name: "Role" }).getByRole("link", { name: "Ledger" }).click();
  await expect(page).toHaveURL(/as=ledger$/);
  await expectTotals(page, "Held");
  await expect(page.locator(".lg-back .lg-line")).toHaveCount(0);
  const photo = page.locator(".lg-receipt img");
  await expect(photo).toHaveJSProperty("complete", true);
  expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.goto(`/drive/${driveId}?as=coordinator`);
  await captureUntilCompleted(page);
  await closeDrive(page);

  await page.goto(`/drive/${driveId}?as=ledger`);
  await expectTotals(page, "Never charged");
  await expect(page.locator(".lg-back .lg-line")).toHaveCount(0);
  // The amount stays with the donor: in the bar of the hold, inside the label.
  await expect(page.locator(".lg-label[data-donor=Mark] .pas-meter")).toHaveAttribute("aria-label", "$21.45 spent, $8.55 never charged");
});

// Drives the two snapshots never show.

const edited = (name: Snapshot, edit: (v: DriveView) => void) => {
  const v = JSON.parse(snapshot(name)) as DriveView;
  edit(v);
  return JSON.stringify(v);
};

test("ledger, finding 5: two receipts with the same line keep both lines in the book", async ({ page }) => {
  const body = edited("open", (v) => {
    const copies = v.ledger.map((r) => ({ ...r, receiptId: `${r.receiptId}b`, rowId: `b/${r.rowId}` }));
    v.ledger = [...v.ledger, ...copies];
    v.receipts = [...v.receipts, { ...v.receipts[0], id: `${v.receipts[0].id}b` }];
  });
  await openLedger(page, "open", body);
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(book(page)).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "41");
  await page.locator("[data-need=water]").click();
  await expect(bookRows(page)).toHaveCount(12);
  await expect(page.locator(".ag-header-cell-text")).toHaveText(["Line", "Receipt line", "Need", "Payer", "Share", "PayPal capture", "Status"]);
});

test("ledger, finding 6: a closing drive turns to Returned by itself", async ({ page }) => {
  const closed = snapshot("closed");
  const closing = edited("closed", (v) => {
    v.drive.status = "closing";
  });
  let reads = 0;
  const id = (JSON.parse(closed) as { drive: { id: string } }).drive.id;
  await page.route(`**/api/drives/${id}`, (r) => {
    reads += 1;
    return r.fulfill({ contentType: "application/json", body: reads < 2 ? closing : closed });
  });
  await page.goto(`/drive/${id}?as=ledger`);
  await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: "Held" })).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: "Never charged" })).toHaveCount(1, { timeout: 15_000 });
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559"], { timeout: 15_000 });
});

test("ledger, finding 8: a donor with no lines yet says so instead of emptying the book", async ({ page }) => {
  const body = edited("open", (v) => {
    v.ledger = v.ledger.filter((r) => r.donorName !== "Lena (Berlin)");
  });
  await openLedger(page, "open", body);
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(book(page)).toBeVisible();
  await page.locator("button[data-donor=Lena]").click();
  await expect(page.getByText("No lines yet")).toBeVisible();
  await page.locator("button[data-donor=Lena]").click();
  await expect(page.getByText("No lines yet")).toHaveCount(0);
  await expect(book(page)).toBeVisible();
  await expect(bookRows(page)).toHaveCount(17);
});

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`ledger, finding 10: thirty donors at ${width} px stay readable`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const body = edited("open", (v) => {
      const extra = Array.from({ length: 27 }, (_, i) => ({ ...v.holds[1], pledgeId: `extra${i}`, donorName: `Donor${i} (Nowhere)`, donorCountry: i % 2 ? "US" : "DE" }));
      v.holds.splice(3, 0, ...extra);
    });
    await openLedger(page, "open", body);
    await expect(page.locator(".ag-studio-value-widget-content").first()).toBeVisible();
    expect(await wider(page)).toBeLessThanOrEqual(0);
    expect((await crowded(page)).out).toEqual([]);
    if (width > 600) {
      await expect(page.locator(".lg-more")).toHaveText(/^\+\d+ more$/);
      const shown = await page.locator(".lg-listed li[data-label]").count();
      const more = Number(/\d+/.exec((await page.locator(".lg-more").textContent()) ?? "")?.[0]);
      const onMap = await page.locator(".lg-label").count();
      // Everyone accounted for: on the map, in the line, or in the count. A donor may be in two of them.
      expect(onMap + shown + more).toBeGreaterThanOrEqual(30);
      expect(await page.locator(".lg-listed").evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      const map = await page.locator(".lg-map").boundingBox();
      const list = await page.locator(".lg-listed").boundingBox();
      expect(list!.y + list!.height).toBeLessThanOrEqual(map!.y + map!.height);
      expect(list!.height).toBeLessThan(40);
    } else {
      await expect(page.locator("[data-donor-row]")).toHaveCount(30);
    }
  });
}

test("ledger: Yuki withdrew from an open drive: the header, the note and the row agree", async ({ page }) => {
  const body = edited("open", (v) => {
    const h = v.holds.find((x) => x.donorName.startsWith("Yuki"))!;
    Object.assign(h, { status: "voided", revoked: true, released: h.available, available: 0, capacityBase: 0 });
  });
  await openLedger(page, "open", body);
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥3,796"], { timeout: 15_000 });
  await expect(page.getByText("¥1,763 already released, never charged")).toBeVisible();
  await expect(page.getByText("¥5,224 waiting for the daily capture")).toBeVisible();
  await expect(page.locator(".lg-label[data-donor=Yuki] .pas-meter")).toHaveAttribute("aria-label", /¥1,763 never charged/);
  await expect(page.locator(".lg-back .lg-line")).toHaveCount(0);
  expect((await crowded(page)).out).toEqual([]);
});

test("ledger: a drive with no receipts draws no flow", async ({ page }) => {
  const body = edited("open", (v) => {
    v.ledger = [];
    v.receipts = [];
    for (const h of v.holds) Object.assign(h, { accrued: 0, available: h.authorized });
  });
  await openLedger(page, "open", body);
  await expect(page.locator(".lg-spent .lg-line")).toHaveCount(0);
  await expect(page.locator(".lg-map")).not.toContainText(/[€$¥]0(\.00)?\b/);
  await expect(page.locator(".lg-map")).toContainText("$30.00 held");
  await expect(page.locator(".lg-receipt")).toHaveCount(0);
});

// Findings of a design review of the Ledger and the screens, by number.

/** Solid, hatched or absent: what a part of a hold's bar looks like. */
const barLook = (page: Page, card: string, part: string) =>
  page.locator(".co-card", { hasText: card }).locator(`[data-part=${part}]`).evaluateAll((els) => (els.length ? (getComputedStyle(els[0]).backgroundImage.includes("repeating-linear-gradient") ? "hatched" : "solid") : "none"));

test("finding 1, 4: the screen leads step by step: sample, capture, close, ledger", async ({ page }) => {
  await openDemo(page);
  const sample = page.getByRole("button", { name: "Use the sample receipt" });
  await expect(sample).toBeVisible();
  expect((await sample.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator(".co-pMid")).toContainText("Use the sample receipt");
  // Before a receipt Close is the quiet button, and it asks.
  const close = page.getByRole("button", { name: "Close drive" });
  const closeBg = await close.evaluate((e) => getComputedStyle(e).backgroundColor);
  const sampleBg = await sample.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(closeBg).not.toBe(sampleBg);
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/close")) posts += 1;
  });
  await close.click();
  await expect(page.getByText("Close the drive? Shares still waiting are captured, and PayPal releases what is left of every hold: it is never charged.")).toBeVisible();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "Keep it open" }).click();
  await expect(page.getByText("Close the drive?")).toHaveCount(0);
  expect(posts).toBe(0);

  await sample.click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await captureUntilCompleted(page);
  await closeDrive(page);
  expect(posts).toBe(1);
  const toLedger = page.getByRole("link", { name: "See where the money went" });
  expect((await toLedger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toLedger.click();
  await expect(page).toHaveURL(/as=ledger$/);
  await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
});

test("finding 4: on a phone too the next step is big and Close asks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  expect((await page.getByRole("button", { name: "Use the sample receipt" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Close drive" }).click();
  await expect(page.getByRole("button", { name: "Yes, close the drive" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep it open" })).toBeVisible();
});

test("recheck: the need pictures are painted on the Ledger right after Close", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await captureUntilCompleted(page);
  await closeDrive(page);
  await page.getByRole("link", { name: "See where the money went" }).click();
  await page.waitForURL(/as=ledger/);
  const pics = page.locator(".lg-pic img");
  await expect(pics).toHaveCount(3, { timeout: 15_000 });
  for (const wait of [1_500, 6_000]) {
    await page.waitForTimeout(wait);
    for (let i = 0; i < 3; i++) {
      const shot = PNG.sync.read(await page.screenshot({ clip: (await pics.nth(i).boundingBox())! }));
      let ink = 0;
      for (let p = 0; p < shot.data.length; p += 4) if (Math.min(shot.data[p], shot.data[p + 1], shot.data[p + 2]) < 225) ink++;
      expect(ink, `picture ${i} after ${wait} ms`).toBeGreaterThan(200);
    }
  }
});

test("recheck: the buttons that confirm Close are on screen at 1440×900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await page.getByRole("button", { name: "Close drive" }).click();
  for (const name of ["Yes, close the drive", "Keep it open"]) {
    const box = (await page.getByRole("button", { name }).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  }
});

test("finding 2, 3: waiting and hatched before the capture, spent and solid after, the sums do not move", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  const lena = page.locator(".co-card", { hasText: "Lena" });
  await expect(lena).toContainText("€4.58 waiting");
  await expect(lena).toContainText("€15.42 held");
  await expect(lena).not.toContainText("spent");
  await expect(lena.locator(".co-tag")).toHaveText("Waiting for capture");
  expect(await barLook(page, "Lena", "waiting")).toBe("hatched");
  expect(await barLook(page, "Lena", "spent")).toBe("none");
  await expect(page.locator(".co-card", { hasText: "Kitasora Logistics" })).toContainText("¥5,224 waiting");

  await captureUntilCompleted(page);
  await expect(lena).toContainText("€4.58 spent");
  await expect(lena).toContainText("€15.42 held");
  await expect(lena.locator(".co-tag")).toHaveText("Partly spent");
  expect(await barLook(page, "Lena", "spent")).toBe("solid");
  expect(await barLook(page, "Lena", "waiting")).toBe("none");
  await expect(page.locator(".co-capDone")).toHaveText("PayPal captured €4.58 · $21.45 · ¥1,237 · ¥5,224");
  await expect(page.locator(".co-card", { hasText: "Kitasora Logistics" })).toContainText("¥5,224 used of ¥500,000");
  // Nothing is left to take: the button says so by not being pressable.
  await expect(page.getByRole("button", { name: "Capture now" })).toBeDisabled();
});

test("finding 3: the donor's statement says what is being bought until PayPal took it", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await page.goto(`/pledge/${driveId}.water`);
  await expect(page.getByRole("heading", { name: "What your money is buying" })).toBeVisible();
  await expect(page.locator(".st-sWait")).toContainText("€4.58");
  await expect(page.locator(".st-sSpent")).toContainText("€0.00");
  await expect(page.getByText("is becoming")).toBeVisible();
  await expect(page.locator(".st-cap").first()).toContainText("Waiting for capture");
});

test("finding 5: after Withdraw the statement says returning, then returned, by itself", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await captureUntilCompleted(page);
  const pledge = `${driveId}.water`;
  const drive = (await (await page.request.get(`/api/drives/${driveId}`)).json()) as DriveView;
  const statement = (await (await page.request.get(`/api/pledges/${pledge}/statement`)).json()) as { statement: { balance: Record<string, unknown> } };
  const hold = drive.holds.find((h) => h.pledgeId === pledge)!;
  const answer = (voided: boolean) => {
    const patch = voided ? { status: "voided", revoked: true, released: 1542, available: 0 } : { revoked: true };
    Object.assign(hold, patch);
    Object.assign(statement.statement.balance, patch);
  };
  let confirmed = false;
  answer(false);
  await page.route(`**/api/drives/${driveId}`, (r) => {
    drive.eventCount += confirmed ? 1 : 0;
    answer(confirmed);
    return r.fulfill({ json: drive });
  });
  await page.route(`**/api/pledges/${pledge}/statement`, (r) => {
    answer(confirmed);
    return r.fulfill({ json: statement });
  });
  await page.goto(`/pledge/${pledge}`);
  const sum = page.getByRole("region", { name: "Pledge summary" });
  await expect(sum).toContainText("Returning at PayPal…");
  await expect(sum).toContainText("€15.42");
  await expect(sum).toContainText("Withdrawn");
  await expect(sum).not.toContainText("held");
  const body = page.locator("body");
  await expect(body).not.toContainText("expires");
  await expect(body).not.toContainText("when the drive closes");
  await expect(page.getByText("on its way back at PayPal")).toBeVisible();
  // No press: PayPal's word arrives on the page's own re-read.
  confirmed = true;
  await expect(page.locator(".st-sRel")).toContainText("€15.42", { timeout: 10_000 });
  await expect(sum).not.toContainText("Returning");
  await expect(sum).toContainText("Withdrawn");
  await expect(body).not.toContainText("on its way back");
});

/** Text in `selector` drawn smaller than 11 px, counting the stage's zoom. `[data-control]` is the proof it can fail. */
const tooSmall = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(sel)) {
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
        const px = parseFloat(getComputedStyle(el).fontSize) * (el as Element & { currentCSSZoom: number }).currentCSSZoom;
        if (px < 11) out.push(`${px.toFixed(1)}: ${el.textContent}`);
      }
    }
    return out;
  }, selector);

test("finding 6: at 1440 the receipt's lines are at least 11 px, on all three screens", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  const rows = ".co-pill, .co-rej";
  await expect(page.locator(rows)).toHaveCount(11);
  await page.evaluate(() => {
    const el = document.createElement("span");
    el.dataset.control = "1";
    el.style.fontSize = "12px";
    el.textContent = "a line too small";
    document.querySelector(".co-pill")!.append(el);
  });
  expect(await tooSmall(page, rows)).toEqual(["9.0: a line too small"]);
  await page.evaluate(() => document.querySelector("[data-control]")?.remove());
  expect(await tooSmall(page, rows)).toEqual([]);
  // The original stays on screen, whole in its tooltip.
  const original = page.locator(".co-pill .line-original").first();
  await expect(original).toBeVisible();
  expect(await original.getAttribute("title")).toContain("北空");

  await page.goto(`/drive/${driveId}?as=donor`);
  await expect(page.locator(".dn-li")).toHaveCount(5);
  expect(await tooSmall(page, ".dn-li")).toEqual([]);

  await page.goto(`/drive/${driveId}?as=volunteer`);
  await expect(page.locator(".vo-rej")).toHaveCount(2);
  expect(await tooSmall(page, ".vo-rej, .vo-need, .vo-chk")).toEqual([]);
});

test("an unknown drive is a 404 with a sentence, not a server error", async ({ request }) => {
  const res = await request.get("/api/drives/demo-0000000000");
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: "unknown_drive", message: "No drive demo-0000000000." });
});

test("finding 10: every phone screen says which drive this is and that it is the sandbox", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const driveId = await openDemo(page);
  for (const role of ["shelter", "donor", "volunteer", "coordinator", "ledger"]) {
    await page.goto(`/drive/${driveId}?as=${role}`);
    const line = page.locator(".hd-mline");
    await expect(line, role).toHaveText("Kitasora Shelter · Earthquake relief · Fictional · PayPal Sandbox");
    expect((await line.boundingBox())!.height, role).toBeLessThan(30);
  }
  await page.goto("/");
  await expect(page.locator(".hd-mline")).toHaveCount(0);
});

test("finding 12: a failed re-read says so, keeps the data, and clears when the server is back", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  const bar = page.getByText("Can’t reach the server, showing the last data");
  await expect(bar).toHaveCount(0);
  // The sample receipt started the re-reads: the next one fails.
  await page.route(`**/api/drives/${driveId}`, (r) => r.abort());
  await expect(bar).toBeVisible();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await page.unroute(`**/api/drives/${driveId}`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(bar).toHaveCount(0);
});

test("finding 11: the phone's book has its own four columns and does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLedger(page, "open");
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(bookRows(page)).toHaveCount(20);
  await expect(page.locator(".ag-header-cell-text")).toHaveText(["What", "Who", "How much", "Status"]);
  await expect(page.locator(".ag-row").first()).toContainText("1 Water 2 L");
  await expect(page.locator(".ag-row").first()).toContainText("Waiting");
  await expect(async () => {
    expect(await page.locator('.ag-header-cell[col-id="book.state"]').evaluate((e) => e.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
    expect(await cutShort(page)).toEqual([]);
  }).toPass({ timeout: 3_000 });
});

test("finding 18: while the Ledger's code loads, the header stays and the page says what it waits for", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.route("**/_next/static/**", async (r) => {
    await new Promise((done) => setTimeout(done, 2_000));
    await r.continue();
  });
  await page.getByRole("navigation", { name: "Role" }).getByRole("link", { name: "Ledger" }).click();
  await expect(page.getByText("Loading the dashboard…")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Role" })).toBeVisible();
  await expect(page.locator(".lg-map [data-label]").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Loading the dashboard…")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(driveId));
});

test("finding 31: the book downloads as a real CSV from a button that is always there", async ({ page }) => {
  await openLedger(page, "closed");
  await page.getByRole("button", { name: /Every line of the book/ }).click();
  await expect(book(page)).toBeVisible();
  await book(page).hover();
  await expect(page.locator("[aria-label=gridWidgetFormSectionExport]")).toBeHidden();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download the book (CSV)" }).click()]);
  expect(file.suggestedFilename()).toMatch(/^demo-[0-9a-f]+-book\.csv$/);
  const text = readFileSync(await file.path(), "utf8");
  expect(text.split("\r\n")[0]).toBe("Receipt,Line,Item,Need,Payer,Share (JPY),Spent,PayPal capture,Status");
  expect(text).toContain("Alcohol");
  expect(text.trim().split("\r\n").at(-1)).toBe("Total,,,,,14646,,,");
});

test("finding 24: the company's card leads to its statement", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("link", { name: "Kitasora Logistics" }).click();
  await expect(page).toHaveURL(new RegExp(`/pledge/${driveId}\\.match$`));
  await expect(page.getByText("Your pledge to")).toBeVisible();
});

test("finding 21: the shelter sees the receipt and the flow", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await page.goto(`/drive/${driveId}?as=shelter`);
  await expect(page.getByRole("heading", { name: "Verified receipt" })).toBeVisible();
  await expect(page.getByText("What this drive has bought for your shelter")).toBeVisible();
  await expect(page.getByRole("button", { name: /PayPal/ })).toHaveCount(0);
});

test("finding 26: an address that leads nowhere offers the way back", async ({ page }) => {
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: "No such page" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open a new demo drive" })).toBeVisible();
});

test("finding 36: the amount hint covers empty, zero and negative", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.goto(`/drive/${driveId}?as=donor`);
  const amount = page.getByRole("textbox", { name: "Your pledge amount" }).first();
  const hint = page.locator(".dn-pfHint.dn-err").first();
  for (const text of ["", "0", "-5"]) {
    await amount.fill(text);
    await expect(hint, text).toContainText("Enter an amount above 0");
  }
});

test("finding 23: after a duplicate the paid receipt stays in front, and the pager says what each page is", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.locator(".co-pill")).toHaveCount(9);
  await page.getByRole("link", { name: "Volunteer" }).click();
  await page.getByRole("button", { name: "Upload another receipt" }).click();
  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.getByText("Waiting for the coordinator")).toBeVisible();
  await page.getByRole("link", { name: "Coordinator" }).click();
  await expect(page.getByRole("button", { name: "1 · Approved" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "2 · Duplicate" })).toBeVisible();
  await expect(page.locator(".co-pill")).toHaveCount(9);
});

// Playwright hides scrollbars. A classic one (Windows, or macOS set to show them always) takes 15 px and comes
// and goes with the page's height. A new drive's Coordinator at 1440 × 900 or 1280 × 800 is exactly as tall as
// the window: the stage's zoom once followed the scrollbar and the scrollbar the zoom, until React gave up
// ("Maximum update depth exceeded", the page did not load). These runs use a browser of their own that keeps its
// scrollbars, styled so they take room on every system.
const CLASSIC_SCROLLBARS = "::-webkit-scrollbar{width:15px;height:15px}::-webkit-scrollbar-thumb{background:#b9b9b9}::-webkit-scrollbar-track{background:#f1f1f1}";

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`desktop ${width} × ${height} with a scrollbar that takes room: a new drive's Coordinator opens before any receipt, with no errors`, async ({ baseURL }) => {
    const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    try {
      const context = await browser.newContext({ baseURL, viewport: { width, height } });
      await context.addInitScript((css) => {
        const put = () => {
          if (!document.documentElement) return void setTimeout(put, 0);
          const s = document.createElement("style");
          s.textContent = css;
          document.documentElement.appendChild(s);
        };
        put();
      }, CLASSIC_SCROLLBARS);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(e.message));

      // The precondition: here a vertical scrollbar really takes 15 px, or this test proves nothing.
      await page.goto("/");
      const gutter = await page.evaluate(() => {
        document.body.style.minHeight = "4000px";
        const g = window.innerWidth - document.documentElement.clientWidth;
        document.body.style.minHeight = "";
        return g;
      });
      expect(gutter).toBe(15);

      const driveId = await openDemo(page);
      await expect(page.locator("header.hd-top")).toBeVisible();
      await expect(page.getByRole("link", { name: "Coordinator" })).toHaveAttribute("aria-current", "page");
      await page.waitForTimeout(1_500);
      await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
      expect(await wider(page)).toBeLessThanOrEqual(0);
      // The same page again, still without a receipt.
      await page.goto(`/drive/${driveId}?as=coordinator`);
      await expect(page.locator("header.hd-top")).toBeVisible();
      await page.waitForTimeout(1_500);
      await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}
