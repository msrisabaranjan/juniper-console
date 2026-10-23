import { test, expect } from "@playwright/test";

async function openDash(page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.click('#navbar button[data-page="dash"]');
  await page.waitForSelector(".dash-session .dash-row");
}

test.describe("short window", () => {
  test.use({ viewport: { width: 1000, height: 520 } });
  test("TRIP panel text stays inside its frame when the window is short", async ({ page }) => {
  await openDash(page);
  const fits = await page.evaluate(() => {
    const p = document.querySelector(".dash-session");
    const pr = p.getBoundingClientRect();
    return [...p.querySelectorAll(".st, .dash-row, .dash-sub")]
      .every((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom <= pr.bottom + 1 && r.right <= pr.right + 1;
      });
  });
  expect(fits).toBe(true);
  });
});

test("G-METER panel is capped vertically (shrunk from 344px)", async ({ page }) => {
  await openDash(page);
  const box = await page.locator(".dash-gpanel").boundingBox();
  expect(box.height).toBeGreaterThan(150); // must not collapse
  expect(box.height).toBeLessThan(300);    // was 344 at 1280x720
});

test("EXTERIOR TEMP panel sits below SPEED", async ({ page }) => {
  await openDash(page);
  const temp = await page.locator(".dash-right .dash-panel", { hasText: "EXTERIOR TEMP" }).boundingBox();
  const speed = await page.locator(".dash-right .dash-panel", { hasText: "SPEED" }).boundingBox();
  expect(temp.y).toBeGreaterThan(speed.y + speed.height - 1);
});
