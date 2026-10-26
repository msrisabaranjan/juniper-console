import { test, expect } from "@playwright/test";

// deterministic route: 11 vertices straight east at lat 39.74, plus seeded
// heights (debug-only __elev.inject 4th arg) so marker math is exact
const RAMP = Array.from({ length: 40 }, (_, i) => i * 10); // 0..390 m

async function openDashWithRoute(page, heights) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.click('#navbar button[data-page="dash"]');
  await page.evaluate((h) => {
    const coords = [];
    for (let i = 0; i <= 10; i++) coords.push([-105.1 + i * 0.02, 39.74]);
    window.__elev.inject(coords, 7, "TEST ROUTE", h);
  }, heights);
  await page.waitForFunction(() =>
    (document.getElementById("elev-line").getAttribute("d") || "").length > 0);
}

test("no fix and no demoFix leaves the car marker hidden", async ({ page }) => {
  await openDashWithRoute(page, RAMP);
  // the dash slowTimer ticks every 250ms with a null pos — must not invent a marker
  await page.waitForTimeout(400);
  await expect(page.locator("#elev-car")).toBeHidden();
});

test("the car marker snaps to the profile at the fix position", async ({ page }) => {
  await openDashWithRoute(page, RAMP);
  await page.evaluate(() => window.__elev.demoFix([-105.04, 39.74]));
  await page.waitForFunction(() => getComputedStyle(document.getElementById("elev-car")).display !== "none");
  const attrs = await page.evaluate(() => {
    const g = (id) => ({
      x1: document.getElementById(id).getAttribute("x1"),
      x2: document.getElementById(id).getAttribute("x2"),
      y1: document.getElementById(id).getAttribute("y1"),
      y2: document.getElementById(id).getAttribute("y2"),
      y: document.getElementById(id).getAttribute("y"),
    });
    return { rule: g("elev-car-rule"), vert: g("elev-car-vert"), horiz: g("elev-car-horiz") };
  });
  // Math: x(i) = 2 + i*(296/39); y(m) = 46 - (m/390)*38.
  // Fix projects to vertex 3/10 -> prog 0.3 -> sampled index f = 0.3*39 = 11.7
  // -> x = 2 + 11.7*(296/39) = 90.8 ; height 117 m -> y = 46 - (117/390)*38 = 34.6
  expect(attrs.rule.x1).toBe("90.8");
  expect(attrs.rule.x2).toBe("90.8");
  expect(attrs.horiz.y).toBe("34.6");
  expect(attrs.vert.y1).toBe("30.6"); // cy - 4
  expect(attrs.vert.y2).toBe("38.6"); // cy + 4
});
