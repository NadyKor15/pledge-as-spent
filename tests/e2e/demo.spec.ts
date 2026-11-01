import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

// SPEC-ui §3: open /, create the demo, take the sample receipt as coordinator,
// see 9 approved / 2 rejected and ¥10,448, close the drive, see "released" on
// every hold. The other screens are checked on the same drive.

async function openDemo(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the demo drive" }).click();
  await expect(page).toHaveURL(/\/drive\/demo-[0-9a-f]+\?as=coordinator$/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** The lookup that confirms captures runs on "Capture now": press until PayPal's word is on screen. */
async function captureUntilCompleted(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: "Capture now" }).click();
    await expect(page.getByText(/final_capture=false.*COMPLETED/).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
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

test("the way in offers one action, explains the path and shows no empty links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open the demo drive" })).toBeVisible();
  await expect(page.locator(".ld-steps li")).toHaveCount(3);
  await expect(page.getByRole("link", { name: /source code|demo video/i })).toHaveCount(0);
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

  await captureUntilCompleted(page);
  await expect(page.locator(".co-card", { hasText: "Mark" })).toContainText("$21.45");
  await expect(page.locator(".co-card", { hasText: "Mark" })).toContainText("$8.55");

  // Volunteer: the result from the API, with the name from the API.
  await page.goto(`/drive/${driveId}?as=volunteer`);
  await expect(page.getByText("9 lines approved")).toBeVisible();
  await expect(page.getByText("2 rejected")).toBeVisible();
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
  await page.getByRole("button", { name: "Close drive — release unspent holds" }).click();
  await expect(async () => {
    await expect(page.getByRole("button", { name: "Drive closed" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  const holds = page.locator(".co-card");
  await expect(holds).toHaveCount(4);
  for (const hold of await holds.all()) await expect(hold).toContainText("released");

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

/** Book cells whose text does not fit, as the reader would see it cut short. */
const cutShort = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".ag-cell")].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent));

async function expectTotals(page: Page, third: string) {
  await expect(page.locator(".ag-studio-layout-widget-title").filter({ hasText: third })).toHaveCount(1);
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"], { timeout: 10_000 });
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
    await expectTotals(page, "Returned to donors");
    expect(await wider(page)).toBeLessThanOrEqual(0);
    const labels = await crowded(page);
    expect(labels.count).toBeGreaterThan(8);
    expect(labels.marks).toBe(6);
    expect(labels.out).toEqual([]);
    await expect(page.locator(".lg-back .lg-line")).toHaveCount(3);
    await expect(page.locator(".lg-head")).toHaveCount(3);
    const body = page.locator("body");
    await expect(body).toContainText("$8.55");
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
    expect(await wider(page)).toBeLessThanOrEqual(0);
    expect((await crowded(page)).out).toEqual([]);
    await expect(page.locator(".lg-back .lg-line")).toHaveCount(0);
    await expect(page.locator(".lg-spent .lg-line")).toHaveCount(3);
    const body = page.locator("body");
    await expect(body).toContainText("$8.55 held");
    await expect(body).not.toContainText(/returned/i);
    await expect(body).not.toContainText(/ back/);
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
  await expect(page.locator(".ag-header-cell-text")).toHaveText(["Line", "Item", "Need", "Payer", "Share", "Charged", "PayPal capture", "Status"]);
  await expect(page.locator(".ag-row").first()).toContainText("Captured");

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
  await expect(async () => expect(await cutShort(page)).toEqual([])).toPass({ timeout: 3_000 });

  const width = (name: string) => page.locator(`.ag-header-cell[col-id="book.${name}"]`).evaluate((e) => e.getBoundingClientRect().width);
  const needOf = { Lena: "Water 2 L", Yuki: "AA batteries", Mark: "Diapers size M" };
  for (const pick of ["Lena", "Yuki", "Mark"] as const) {
    await page.locator(`button[data-donor=${pick}]`).click();
    await expect(page.locator(".ag-row", { hasText: needOf[pick] })).toHaveCount(6);
    await expect(bookRows(page)).toHaveCount(6);
    await expect(async () => {
      expect(await cutShort(page)).toEqual([]);
      expect(await width("item")).toBeGreaterThan(await width("need"));
      expect(await width("item")).toBeGreaterThan(await width("payer"));
    }).toPass({ timeout: 3_000 });
  }
});

test("ledger: opening and closing the book moves nothing; Replay still runs it all again", async ({ page }) => {
  await openLedger(page, "closed");
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"], { timeout: 15_000 });
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
    await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"]);
    await button.click();
    await expect(book(page)).toBeHidden();
    await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"]);
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
  await page.keyboard.press("Escape");
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
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"], { timeout: 15_000 });
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
  await mark.click();
  await expect(bookRows(page)).toHaveCount(20);
  const water = page.locator("[data-need=water]");
  await water.click();
  await expect(page.locator("[data-donor-row=Lena]")).toHaveClass(/is-on/);
  await expect(bookRows(page)).toHaveCount(6);
});

test("ledger: the keyboard reaches the map through Studio's own stops, and Space presses a donor", async ({ page }) => {
  await openLedger(page, "closed");
  await page.locator(".lg-replay").focus();
  await page.keyboard.press("Escape");
  const stop = page.getByRole("group", { name: /^Money map/ });
  await expect(stop).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".lg-map button").first()).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator(".lg-map button").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".is-on").first()).toBeVisible();
});

test("ledger: reduced motion shows the finished picture at once and moves nothing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLedger(page, "closed");
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"]);
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
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"], { timeout: 15_000 });
  const inBetween = await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen].filter((t) => /^¥[\d,]+$/.test(t) && !["¥10,783", "¥5,224", "¥5,559", "¥0"].includes(t)).length);
  expect(inBetween).toBeGreaterThan(3);

  await expect(async () => expect(await runningAnimations(page)).toBe(0)).toPass({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(await runningAnimations(page)).toBe(0);

  await page.getByRole("button", { name: "Replay" }).click();
  await expect(async () => expect(await runningAnimations(page)).toBeGreaterThan(0)).toPass({ timeout: 2_000 });
  await expect(async () => expect(await runningAnimations(page)).toBe(0)).toPass({ timeout: 20_000 });
  await expect(totals(page)).toHaveText(["¥10,783", "¥5,224", "¥5,559", "+¥5,224"]);
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
  await page.getByRole("button", { name: "Close drive — release unspent holds" }).click();
  await expect(async () => {
    await expect(page.getByRole("button", { name: "Drive closed" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });

  await page.goto(`/drive/${driveId}?as=ledger`);
  await expectTotals(page, "Returned to donors");
  await expect(page.locator(".lg-back .lg-line")).toHaveCount(3);
  await expect(page.locator("body")).toContainText("$8.55 back");
});
