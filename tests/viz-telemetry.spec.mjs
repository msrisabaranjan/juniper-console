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

test("grid waves scale with speed and travel while moving", async ({ page }) => {
  await openHome(page);
  await page.evaluate(SNAP("speed: 30")); // ~67 mph
  await page.waitForFunction(() => window.__viz.stats().maxAbsY > 4, undefined, { timeout: 5000 });
  const t1 = await page.evaluate(() => window.__viz.stats().travel);
  await page.waitForTimeout(500);
  const t2 = await page.evaluate(() => window.__viz.stats().travel);
  expect(t2 - t1).toBeGreaterThan(1.5); // 30 m/s * 0.5 s * K 0.2 ~ 3 rad
  await page.evaluate(SNAP("speed: 0"));
  await page.waitForFunction(() => window.__viz.stats().maxAbsY < 2.2, undefined, { timeout: 6000 });
  const u1 = await page.evaluate(() => window.__viz.stats().travel);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__viz.stats().travel) - u1).toBeLessThan(0.01);
});

test("braking collapses rings inward and flags g-hot over 1g", async ({ page }) => {
  await openHome(page);
  await page.evaluate(SNAP("speed: 20, gy: -1.3")); // 1.3 g braking
  await page.waitForFunction(
    () => window.__viz.stats().pulse < -4 && window.__viz.stats().hot > 0.85,
    undefined, { timeout: 5000 }
  );
  await page.evaluate(SNAP("speed: 20, gy: 1.2")); // accelerating: rings flip outward
  await page.waitForFunction(() => window.__viz.stats().pulse > 4, undefined, { timeout: 5000 });
});

test("lateral G banks the grid into the turn", async ({ page }) => {
  await openHome(page);
  await page.evaluate(SNAP("speed: 20, gx: 1.2")); // hard right
  await page.waitForFunction(
    () => window.__viz.stats().rightMeanY < window.__viz.stats().leftMeanY - 1,
    undefined, { timeout: 5000 }
  );
  await page.evaluate(SNAP("speed: 20, gx: -1.2")); // hard left flips the bank
  await page.waitForFunction(
    () => window.__viz.stats().rightMeanY > window.__viz.stats().leftMeanY + 1,
    undefined, { timeout: 5000 }
  );
});

test("offline grid parks small and reads NO SIGNAL", async ({ page }) => {
  await openHome(page); // desktop headless: geolocation denied -> feed never goes live
  expect(((await page.textContent("#viz-status")) ?? "").trim()).toBe("NO SIGNAL");
  expect(
    await page.evaluate(() => window.__viz.stats().signal)
  ).toBe("NO SIGNAL");
  expect(
    await page.evaluate(() => window.__viz.stats().maxAbsY)
  ).toBeLessThan(1.2);
  await page.evaluate(SNAP("speed: 10"));
  await page.waitForFunction(
    () => document.getElementById("viz-status").textContent.trim() === "LIVE",
    undefined, { timeout: 3000 }
  );
});

test("?vizdemo=1 drives a scripted live scenario (DEV preview)", async ({ page }) => {
  await page.goto("/?vizdemo=1");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
  await page.waitForFunction(
    () => window.__viz.stats().signal === "LIVE" && window.__viz.stats().maxAbsY > 4,
    undefined, { timeout: 8000 }
  );
  // demo mode enables preserveDrawingBuffer, so the canvas is capturable
  // (CDP screenshots of this app's WebGL stay black - toDataURL is the check)
  const png = await page.evaluate(() => document.getElementById("viz").toDataURL("image/png"));
  expect(png.startsWith("data:image/png;base64,")).toBe(true);
  expect(png.length).toBeGreaterThan(20000);
});
