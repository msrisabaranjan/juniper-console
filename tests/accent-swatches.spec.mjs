import { test, expect } from "@playwright/test";

// Deterministic setup: wait out the 1.4s boot overlay, go to VEHICLE page,
// open the DISPLAY sub-tab. Tab buttons are built in fixed order
// dynamics/lights/display/charging, so nth(2) == DISPLAY regardless of the
// glitch/type-in intro animation rewriting label text.
async function openDisplayTab(page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.click('#navbar button[data-page="vehicle"]');
  await page.locator("#veh-subtabs button").nth(2).click();
  await page.waitForSelector("#veh-body .swatches");
}

test("seven swatches render and the Crimson/Chalk segmented stays", async ({ page }) => {
  await openDisplayTab(page);
  await expect(page.locator("#veh-body .swatches .swatch")).toHaveCount(7);
  // scoped by aria-label: the Display tab now also has a HUD Text segmented
  // with a data-value="Chalk" button (chalk-text setting)
  await expect(page.locator('#veh-body [aria-label="Appearance accent"] button[data-value="Chalk"]')).toHaveCount(1);
});

test("clicking Amber sets data-accent and retints --accent", async ({ page }) => {
  await openDisplayTab(page);
  await page.click('.swatch[data-value="amber"]');
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe("amber");
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
  )).toBe("255 179 71");
  await expect(page.locator('.swatch[data-value="amber"]')).toHaveAttribute("aria-pressed", "true");
});

test("existing Chalk preset still works via swatch (regression)", async ({ page }) => {
  await openDisplayTab(page);
  await page.click('.swatch[data-value="white"]');
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe("white");
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
  )).toBe("242 242 242");
});

test("clicking Cyber retints to neon violet", async ({ page }) => {
  await openDisplayTab(page);
  await page.click('.swatch[data-value="cyber"]');
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe("cyber");
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
  )).toBe("176 38 255");
});

test("hidden map pages never leave clickable attribution links (click-trap regression)", async ({ page }) => {
  await openDisplayTab(page);
  const stillClickable = await page.evaluate(() =>
    [...document.querySelectorAll(".page:not(.active) .maplibregl-ctrl a, .page:not(.active) .maplibregl-ctrl button")]
      .some((el) => getComputedStyle(el).pointerEvents !== "none"));
  expect(stillClickable).toBe(false);
});

test("accent choice persists across reload", async ({ page }) => {
  await openDisplayTab(page);
  await page.click('.swatch[data-value="cyan"]');
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe("cyan");
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
  )).toBe("34 211 238");
});
