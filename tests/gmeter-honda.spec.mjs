import { test, expect } from "@playwright/test";

async function openDash(page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.click('#navbar button[data-page="dash"]');
  await page.waitForSelector(".dash-session .dash-row");
}

// Poke the exposed sensor feed (src/pages/dash.ts exposes window.__dashfeed;
// the rAF loop calls feed.read() on that same object every frame).
async function feedMode(page, fnBody) {
  await page.evaluate(fnBody);
}

const SNAP = (extra) => `(() => {
  const base = { live: true, speed: 30, heading: 0, lat: 34.6, lng: 135.4,
    sittingSec: 0, distanceM: 1000, movingSec: 120, sittingTotalSec: 0,
    gx: 0, gy: 0, gLive: true, accuracy: 5, source: "gps", lastMoveClock: "10:00:00" };
  window.__dashfeed.read = () => ({ ...base, fixAt: performance.now(), ${extra} });
})()`;

test("dial is chalk and ball is crimson regardless of accent", async ({ page }) => {
  await openDash(page);
  await page.evaluate(() => (document.documentElement.dataset.accent = "cyber"));
  const [dial, ball] = await page.evaluate(() => [
    getComputedStyle(document.querySelector("#dash-gsvg .g-dial circle")).stroke,
    getComputedStyle(document.getElementById("dash-gdot")).fill,
  ]);
  expect(dial).toBe("rgb(242, 242, 242)");
  expect(ball).toBe("rgb(255, 45, 45)");
});

test("over-1g total reads crimson even with chalk text", async ({ page }) => {
  await openDash(page);
  await feedMode(page, SNAP("gx: 0, gy: -1.3")); // 1.3 g braking -> g-hot
  await page.waitForSelector("#dash-g-total.g-hot", { timeout: 3000 });
  // cyber accent first: the current accent-tinted g-hot can never coincidentally
  // equal crimson while we check the chalk-text guarantee
  await page.evaluate(() => (document.documentElement.dataset.accent = "cyber"));
  await page.evaluate(() => (document.documentElement.dataset.text = "chalk"));
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById("dash-g-total")).color)
  ).toBe("rgb(255, 45, 45)");
});

test("ball glides to target instead of teleporting", async ({ page }) => {
  await openDash(page);
  await feedMode(page, SNAP("gx: 1.4, gy: 0")); // target cx = 14
  await page.waitForTimeout(200);
  const early = await page.evaluate(() =>
    parseFloat(document.getElementById("dash-gdot").getAttribute("cx")));
  await page.waitForTimeout(400);
  const late = await page.evaluate(() =>
    parseFloat(document.getElementById("dash-gdot").getAttribute("cx")));
  expect(early).toBeGreaterThan(0);
  expect(late).toBeGreaterThan(early + 1);      // still approaching at t+600ms
  expect(late).toBeLessThanOrEqual(14.1);
  await page.waitForTimeout(1200);
  const done = await page.evaluate(() =>
    parseFloat(document.getElementById("dash-gdot").getAttribute("cx")));
  expect(done).toBeCloseTo(14, 0);              // settled within ~1
});

test("trail renders as fading comet segments once the ball moves", async ({ page }) => {
  await openDash(page);
  await feedMode(page, `(() => {
    const base = { live: true, speed: 30, heading: 0, lat: 34.6, lng: 135.4,
      sittingSec: 0, distanceM: 1000, movingSec: 120, sittingTotalSec: 0,
      gLive: true, accuracy: 5, source: "gps", lastMoveClock: "10:00:00", gx: 0, gy: 0 };
    window.__dashfeed.read = () => {
      const t = performance.now();
      return { ...base, fixAt: t, gx: Math.sin(t / 250) * 1.2, gy: Math.cos(t / 300) * 0.8 };
    };
  })()`);
  await page.waitForTimeout(1500);
  const counts = await page.evaluate(() =>
    [...document.querySelectorAll("#dash-gtrail .g-trail-seg")].map(
      (p) => (p.getAttribute("points") || "").trim().split(/\s+/).filter(Boolean).length));
  expect(new Set(counts).size).toBeGreaterThan(1); // segments cover different spans
  const segs = await page.evaluate(() =>
    [...document.querySelectorAll("#dash-gtrail .g-trail-seg")]
      .filter((p) => (p.getAttribute("points") || "").split(" ").length > 1)
      .map((p) => parseFloat(getComputedStyle(p).opacity)));
  expect(segs.length).toBeGreaterThanOrEqual(3);
  // oldest -> newest strictly brighter (comet fades toward the tail)
  for (let i = 1; i < segs.length; i++) expect(segs[i]).toBeGreaterThan(segs[i - 1]);
});
