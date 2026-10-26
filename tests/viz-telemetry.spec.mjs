import { test, expect } from "@playwright/test";

// HOME is the initial page; wait for the boot curtain, then for the
// visualizer module to have mounted its debug hook (src/three/telemetryViz).
async function openHome(page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.waitForFunction(() => typeof window.__viz === "object", undefined, { timeout: 5000 });
}

// Same fake-feed pattern as tests/gmeter-honda.spec.mjs: poke read() on the
// feed the rAF loop calls every frame (window.__vizfeed === window.__viz.feed).
const SNAP = (extra) => `(() => {
  const base = { live: true, speed: 0, heading: 0, lat: 37.77, lng: -122.42,
    sittingSec: 0, distanceM: 0, movingSec: 0, sittingTotalSec: 0,
    gx: 0, gy: 0, gLive: true, accuracy: 4, source: "gps", lastMoveClock: "10:00:00" };
  window.__viz.feed.read = () => ({ ...base, fixAt: performance.now(), ${extra} });
})()`;

test("HOME shows the viz layer, other pages do not", async ({ page }) => {
  await openHome(page);
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById("viz")).display)
  ).toBe("block");
  await page.click('#navbar button[data-page="dash"]');
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById("viz")).display)
  ).toBe("none");
});
