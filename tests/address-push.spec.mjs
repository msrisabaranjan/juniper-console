import { test, expect } from "@playwright/test";

async function boot(page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    document.getElementById("boot")?.classList.contains("done"));
}

test("parse: long Maps URL yields the place-pin coords", async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(() => window.__push.parse(
    "Google HQ 1600 Amphitheatre Pkwy, Mountain View, CA " +
    "https://www.google.com/maps/place/Google+HQ/@37.4221,-122.0842,17z" +
    "/data=!4m6!3m5!8m2!3d37.4221!4d-122.0842"));
  expect(out).toMatchObject({ kind: "coords", lat: 37.4221, lon: -122.0842 });
});

test("parse: q= and bare lat,lng yield coords; share text yields a query", async ({ page }) => {
  await boot(page);
  const qUrl = await page.evaluate(() =>
    window.__push.parse("https://maps.google.com/?q=37.4221,-122.0842"));
  expect(qUrl).toMatchObject({ kind: "coords", lat: 37.4221, lon: -122.0842 });
  const bare = await page.evaluate(() => window.__push.parse("37.4221, -122.0842"));
  expect(bare).toMatchObject({ kind: "coords", lat: 37.4221, lon: -122.0842 });
  const text = await page.evaluate(() => window.__push.parse(
    "Tesla Factory 3000 Hanover St, Mountain View, CA 94043 https://maps.app.goo.gl/abcDEF"));
  expect(text).toMatchObject({
    kind: "query",
    query: "Tesla Factory 3000 Hanover St, Mountain View, CA 94043",
  });
});

test("live SSE: a message published to a fresh ntfy topic arms and lands", async ({ page }) => {
  await boot(page);
  const topic = `juniper-dash-test-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  await page.evaluate((t) => window.__push.setTopic(t), topic);
  await page.waitForFunction(() => window.__push.state() === "live", null, { timeout: 10000 });
  const pub = await page.request.post(`https://ntfy.sh/${topic}`, {
    data: "https://maps.google.com/?q=37.44,-122.14",
  });
  expect(pub.status(), "publish to ntfy.sh should return 200").toBe(200);
  // the pushed pin lands on the dash and starts the drive (full mechanism,
  // works on Valhalla or the beeline fallback)
  await page.waitForSelector("#page-navigate.drive", { timeout: 20000 });
});

test("receive from a pinned long Maps URL jumps to NAVIGATE and starts the drive", async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    window.__push.receive(
      "Downtown Mountain View https://www.google.com/maps/place/" +
        "Downtown+Mountain+View/@37.39,-122.06,14z/data=!4m6!3m5!8m2!3d37.39!4d-122.06",
    ),
  );
  // the push pulls the dash to the navigate tab
  await expect(page.locator("html")).toHaveAttribute("data-page", "navigate");
  // and commits straight into drive phase (works even on the beeline fallback,
  // so this spec is not hostage to Valhalla uptime)
  await page.waitForSelector("#page-navigate.drive", { timeout: 15000 });
  await expect(page.locator("#nav-maneuver")).toBeVisible();
  await expect(page.locator("#nav-status")).toContainText("NAVIGATING");
});

test("comma-form share title falls back to the bare name and drives", async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    window.__push.receive("Google HQ, 1600 Amphitheatre Parkway, California"),
  );
  // Nominatim returns nothing for the stitched "name, street" string; the
  // push path must retry the part before the first comma, then drive.
  await page.waitForSelector("#page-navigate.drive", { timeout: 20000 });
  await expect(page.locator("#nav-status")).toContainText("NAVIGATING");
});
