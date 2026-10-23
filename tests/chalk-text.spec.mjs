import { test, expect } from "@playwright/test";

// same open procedure as tests/accent-swatches.spec.mjs
async function openDisplayTab(page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.click('#navbar button[data-page="vehicle"]');
  await page.locator("#veh-subtabs button").nth(2).click();
  await page.waitForSelector("#veh-body .swatches");
}

test("HUD Text segmented control appears on the Display tab", async ({ page }) => {
  await openDisplayTab(page);
  const seg = page.locator('#veh-body [aria-label="HUD text color"] button');
  await expect(seg).toHaveCount(2);
  // segmented buttons render their option labels uppercased (ui/segmented.ts)
  await expect(seg.nth(0)).toHaveText("ACCENT");
  await expect(seg.nth(1)).toHaveText("CHALK");
});

test("clicking Chalk re-points text tokens but not the accent", async ({ page }) => {
  await openDisplayTab(page);
  await page.click('#veh-body .swatch[data-value="cyber"]');
  await page.click('#veh-body [aria-label="HUD text color"] button:has-text("Chalk")');
  expect(await page.evaluate(() => document.documentElement.dataset.text)).toBe("chalk");
  const [t, a] = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return [cs.getPropertyValue("--text").trim(), cs.getPropertyValue("--accent").trim()];
  });
  // Chromium serializes substituted custom properties space-separated
  expect(t).toBe("rgb(242 242 242)");
  expect(a).toBe("176 38 255"); // accent stays Cyber for bars/glows/car
});

test("chalk text persists across reload", async ({ page }) => {
  await openDisplayTab(page);
  await page.click('#veh-body [aria-label="HUD text color"] button:has-text("Chalk")');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.text === "chalk");
});
