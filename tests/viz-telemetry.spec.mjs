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

test("telemetry math mappings are monotone and signed", async ({ page }) => {
  await openHome(page);
  const r = await page.evaluate(() => {
    const m = window.__vizmath;
    const flat = { wave: 0, travel: 0, pulse: 0, pulsePhase: 0, bankGx: 1.2, noise: 0, t: 0 };
    return {
      idle: m.waveAmp(0),
      fast: m.waveAmp(50),
      pulseBrake: m.pulseAmp(-1.2),
      pulseAccel: m.pulseAmp(1.2),
      hot13: m.hotMix(0, -1.3),
      hot0: m.hotMix(0, 0),
      n1: m.valueNoise2(3.7, -1.2),
      n1b: m.valueNoise2(3.7, -1.2),
      bendRight: m.heightAt(70, 0, flat),
      bendLeft: m.heightAt(-70, 0, flat),
    };
  });
  expect(r.idle).toBeCloseTo(0.6);
  expect(r.fast).toBeGreaterThan(r.idle + 6);
  expect(r.pulseBrake).toBeLessThan(-4);
  expect(r.pulseAccel).toBeGreaterThan(4);
  expect(r.hot13).toBe(1);
  expect(r.hot0).toBe(0);
  expect(r.n1).toBe(r.n1b);            // deterministic
  expect(Math.abs(r.n1)).toBeLessThanOrEqual(1);
  expect(r.bendRight).toBeLessThan(r.bendLeft); // right turn (+gx) dips +x rim
});
