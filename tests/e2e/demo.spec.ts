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

test("volunteer: a photo over the limit is shrunk in the browser, and a limit error points to the sample", async ({ page }) => {
  const driveId = await openDemo(page);
  await page.goto(`/drive/${driveId}?as=volunteer`);
  await expect(page.getByRole("button", { name: "Upload a receipt photo" })).toBeVisible();

  const big = hugePng();
  expect(big.length).toBeGreaterThan(3.5 * 1024 * 1024);
  const post = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/receipts"));
  await page.getByLabel("Receipt photo").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: big });
  const sent = (await post).postDataBuffer();
  expect(sent).not.toBeNull();
  expect(sent!.length).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 1024);

  // No live reading on this server: the refusal is shown in plain words with the way out.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Live receipt reading is not switched on");
  await expect(alert).toContainText("sample receipt");

  await page.getByRole("button", { name: "Use the sample receipt" }).click();
  await expect(page.getByText("¥10,448 sent to your PayPal")).toBeVisible();

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
  await expect(page.getByRole("alert")).toContainText("could not be opened as a photo");
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
});

test("an unknown pledge and an unknown drive say so and lead back", async ({ page }) => {
  await page.goto("/pledge/nope");
  await expect(page.getByRole("heading", { name: "No such pledge" })).toBeVisible();
  await page.goto("/drive/nope?as=coordinator");
  await expect(page.getByRole("heading", { name: "No such drive" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open a new demo drive" })).toBeVisible();
});
