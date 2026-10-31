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
