# Telemetry-reactive mesh-grid visualizer on HOME

Plan file: `.hermes/plans/2026-10-25_230059-telemetry-visualizer-home.md`
Repo: `D:\Experiments\AI\TCinema_v2\juniper-console` (bash `/d/Experiments/AI/TCinema_v2/juniper-console`) · base branch `master` · new branch `visualizer` · GitHub `msrisabaranjan/juniper-console`

## Goal

Replace the 3D car on the HOME tab with a vizz.fm "Mesh Grid"-style WebGL visualizer whose waves travel/amplify with car speed, pulse with longitudinal G (accel/brake), bank with lateral G, and flare crimson above 1 g — then show a live preview for approval before pushing and opening a PR.

## Current context / assumptions

**Juniper console facts (verified this session):**
- `index.html`: one global three.js canvas `#stage` (z-index 0, `position:fixed; inset:0`) behind everything; the HOME page (`#page-home`) contains only the `DRAG TO ROTATE` hint — the "home screen content" is the car scene in `src/three/carScene.ts` (756 lines).
- `carScene.ts` already has a per-page blackout: `setPage()` sets `blackout = page === "dash"` → the tick clears the canvas to black and skips `renderer.render`. We reuse this exact mechanism for HOME.
- `ACCENT_COLORS: Record<Accent, THREE.Color>` exists in `carScene.ts` (not yet exported).
- Live telemetry already exists: `src/ui/sensors.ts` → `createSensorFeed()` returns `SensorFeed` with `read(): SensorSnapshot` carrying `speed` (m/s, Kalman-extrapolated), `gx` (lateral g, + = right), `gy` (longitudinal g, + = accel, − = brake), `live`, `gLive`, `source`. GPS-only philosophy: offline → `live:false`, speed 0. `createSensorFeed()` is a cheap factory; `src/pages/dash.ts` creates its own instance and starts/stops it on page switch (subscribe to `state.ts` page changes).
- Debug/test hook pattern: dash exposes `window.__dashfeed`; `tests/gmeter-honda.spec.mjs` pokes `window.__dashfeed.read = () => snap` to fake telemetry. We copy this pattern with `window.__vizfeed` / `window.__viz`.
- Tests: Playwright, `playwright.config.mjs` (NOT .ts), testDir `./tests`, baseURL/dev server port **5199**, `reuseExistingServer:true` and auto-starts vite. Full suite is ~18 specs. Typecheck: `npx tsc -p tsconfig.json --noEmit`.
- Boot: every test waits for `#boot.done` (~1.4 s). Home is the initial page (`chrome.ts` line 44, `main.ts` sets `html[data-page]`).
- Known pitfall (juniper-console skill): CDP screenshots of this app's WebGL canvases come back solid black — verify via DOM/`window` stats, not pixels.
- No existing test references `#page-home`, `home-hint`, or the car's visibility on home (grep-verified), so replacing home content breaks nothing.

**vizz.fm REA findings (static bundle analysis done during planning — evidence is real, do not re-derive from scratch):**
- The app is Next.js. All 37 chunks of `https://vizz.fm/app/?preset=Y29uZmln…` were fetched with curl (3.7 MB) and grepped.
- The preset param is base64: `echo Y29uZmlnLTE3ODUwMDc2NDY0NzItNDg1 | base64 -d` → `config-1785007646472-485` = **"Mesh Grid Variant #16"** (the UI label "Variant #1" is just their display numbering; the bundle names it #16).
- Everything visualizer-related lives in chunk `/_next/static/chunks/9583-0b194b6148e96c8b.js`. Registry entry (module 57202): `{id:"mesh-grid", name:"Mesh Grid", description:"3D grid surface that reacts to audio", renderer:"webgl"}`.
- Mechanism (observed in the minified hook, span ~10 KB at offset 170797):
  - three.js `PlaneGeometry(w, h, wSegs, hSegs)` grid (alias `r.bdM`), one shared BufferGeometry fed to four passes: wireframe `Mesh` (`r.eaF` + `wireframe:true`), a transparent fill `Mesh`, `Points` dots (`r.ONl`), and an additive-blend glow `Points`.
  - Custom `ShaderMaterial`s (alias `r.BKk`) with uniforms `baseColor, time, colorIntensity, colorReactivity, circleMode, gridHalfX, gridHalfZ, angleHueMix, surfaceOpacity, fillReactivity, dotSize, dotReactivity, dotGlow, uPixelRatio, sizeMul` — the vertex shader does the *warping* (circle shape, spiral, perlin drift), while the **FFT→height displacement is done on the CPU each frame**: positions plus a custom `frequency` attribute are written into JS arrays, then `attributes.position.needsUpdate = true`.
  - Audio side: analyser `fftSize:16384`, `drawFrame({dt, dataArray, bufferLength})` consumes the FFT bytes; per-parameter `controlModulations` map audio "flux" (e.g. `perlinNoiseIntensity` amount 2.8, `radialMix` amount 2.2 inverted) — i.e. parameters themselves are audio-modulated.
  - Variant #16 params (full dump in the research doc): `cellSize:1, waveHeight:1.1, waveSpeed:.8, colorIntensity:2, perlinNoiseIntensity:1.35, perlinNoiseSpeed:.93, meshBend:-12, circleShape:true, radialMix:.25, flowMix:.6, spectrumSpiral:.72, spiralTurns:8, angleHueMix:.3, fillOpacity:.1, dotSize:1, dotGlow:1, feedback{decay .52, add, zoom 1.01}, gammaCorrection{hueSpeed .49}, background starfield`.
- We **re-implement the concepts, not the code** (minified proprietary bundle; legal note in the doc): FFT bands are replaced by telemetry channels.

**Port map (FFT → telemetry), the design in one table:**

| vizz.fm channel | ours | visual |
|---|---|---|
| FFT amplitude → vertex height | **speed** | crest amplitude `0.6 → 10` world units over 0–125 mph; crest lines *travel* along z at a phase rate ∝ speed (road rushing past) |
| bass flux modulating `waveHeight`/`perlin` | **longitudinal G (gy)** | radial ring from grid centre; +gy (accel) rings expand outward, −gy (brake) rings collapse inward; amp = `clampG(gy) * 7.5` |
| `meshBend:-12` | **lateral G (gx)** | whole grid banks: right turn (+gx) dips the +x rim |
| `gammaCorrection` hue + audio flux | **total ‖G‖** | perlin breathing amp ∝ ‖G‖, wire/dot colour lerps accent → crimson at ≥1.0 g (same "g-hot" semantics as the DASH G-meter) |
| `feedback`/`starfield` post chain | — (omitted) | YAGNI + Tesla-browser GPU budget; see Risks |

**Assumption (flag for the preview gate):** "replace what the home screen shows" = the car is hidden on the **HOME tab only**; VEHICLE (and the shared stage behind MEDIA/NAVIGATE) still render the car exactly as today. If the user wants the car kept behind the visualizer instead, revert one line in `carScene.setPage` at preview time.

## Architecture

A second fixed full-screen canvas `#viz` sits after `#stage` in the DOM (same z-index 0 → paints on top) and is shown only while `html[data-page="home"]` (pure CSS, same pattern as the `elev-strip` swap). `carScene.setPage` gains HOME to its existing blackout condition so the car stops rendering there. A new self-contained module `src/three/telemetryViz.ts` owns its own `createSensorFeed()` (start/stop on page switch, mirroring `dash.ts` exactly), displaces the grid's CPU position buffer every frame from a pure, unit-tested math module `src/ui/vizMath.ts`, and exposes `window.__viz.stats()` + `window.__vizfeed` for Playwright — no pixel assertions. A DEV-only `?vizdemo=1` flag scripts a synthetic drive scenario (launch → top-speed → hard brake → cornering) so a live preview works on desktop with no GPS, and enables `preserveDrawingBuffer` so a screenshot can be captured at all.

## Conventions for every task

- All paths below are repo-relative; run commands from `cd /d/Experiments/AI/TCinema_v2/juniper-console`.
- TDD: for each code task, paste the new test(s) into `tests/viz-telemetry.spec.mjs` first, run, **confirm it fails**, implement, run again, **confirm it passes**, then commit. Run the targeted file only (`npx playwright test tests/viz-telemetry.spec.mjs`) for speed; the full suite runs in Task 14.
- The dev server is auto-managed by `playwright.config.mjs` (`reuseExistingServer:true`); no manual server needed for tests.

---

## Task 0 — Branch (2 min)

```bash
cd /d/Experiments/AI/TCinema_v2/juniper-console
git status --short                      # expect: no output (clean tree; only .hermes/plans/ may appear — ignore/commit it with Task 1)
git checkout -b visualizer master
```
Expected: `Switched to a new branch 'visualizer'`. `git branch --show-current` → `visualizer`.

## Task 1 — Research doc (REA evidence ledger) (5 min)

Create `docs/visualizer-research.md` with the content below (it is already verified; do not redo the curl pass — the "reproduce" block is for future readers). This is the only non-TDD task (docs).

```markdown
# HOME visualizer — vizz.fm "Mesh Grid" research (2026-10-25)

Target: https://vizz.fm/app/?preset=Y29uZmlnLTE3ODUwMDc2NDY0NzItNDg1
Preset id (base64 of the `preset` param): config-1785007646472-485 = "Mesh Grid Variant #16"
(in the UI it shows as "Mesh Grid Variant #1" — display numbering only).

## Method
Static bundle analysis (REA-style, no runtime execution): all 37 script chunks of the app
page fetched with curl; visualizer registry + hook live in
/_next/static/chunks/9583-0b194b6148e96c8b.js (557 KB, minified).

Reproduce:
    curl -sL -A "Mozilla/5.0" "https://vizz.fm/app/" -o vizz.html
    grep -oE '/_next/static/chunks/[^"]*\.js' vizz.html | sort -u | while read p; do
      curl -s -A "Mozilla/5.0" "https://vizz.fm$p" -o "vizzchunks/$(basename $p)"; done
    grep -l "Mesh Grid" vizzchunks/*          # → 9583-0b194b6148e96c8b.js

## Findings (observations from the bundle)
- Registry: module 57202 — {id:"mesh-grid", name:"Mesh Grid",
  description:"3D grid surface that reacts to audio", renderer:"webgl",
  presetId:"config-1741367309222-608", variants:[... config-1785007646472-485 ...]}.
- Geometry: one PlaneGeometry(w, h, wSegs, hSegs)-style grid; a single shared
  BufferGeometry drives 4 passes: wireframe Mesh, transparent fill Mesh,
  Points dots, additive glow Points (custom vertexShader/fragmentShader pairs).
- Displacement: CPU-side each frame — the drawFrame hook receives
  {dt, dataArray, bufferLength} (analyser bytes, fftSize 16384) and writes
  position + a custom `frequency` attribute, then sets needsUpdate.
  The vertex shader then warps: circleShape/radialMix, spectrumSpiral+spiralTurns,
  meshBend, perlin noise (intensity/scale/speed), flowMix.
- Parameters are themselves audio-modulated via `controlModulations`
  (mode:"audio", source:"flux", e.g. perlinNoiseIntensity amount 2.8).
- Post chain (this preset): effectOrder ["gammaCorrection" hueSpeed .49] plus
  feedback (add blend, decay .52, zoom 1.01); background "starfield".

## Variant #16 parameter dump (verbatim from bundle)
visualizationType:"mesh-grid", backgroundColor:"#000000", fftSize:16384,
enablePostProcessing:true, effectOrder:["gammaCorrection"], cameraRotationY:4e-4,
backgroundType:"starfield", backgroundTwinkleSpeed:1.8, backgroundAudioReactivity:2.4,
backgroundPlasmaScale:3, backgroundPlasmaSpeed:.5, gridColor:"#000000", cellSize:1,
waveHeight:1.1, waveSpeed:.8, colorIntensity:2, dampeningFactor:0, jaggedness:0,
perlinNoiseIntensity:1.35, perlinNoiseSpeed:.93, meshBend:-12, circleShape:true,
radialMix:.25, flowMix:.6, spectrumSpiral:.72, spiralTurns:8, angleHueMix:.3,
fillOpacity:.1, fillReactivity:1, dotSize:1, dotReactivity:1, dotGlow:1,
feedback_enabled:true, feedback_decay:.52, feedback_blendMode:"add", feedback_zoom:1.01,
gammaCorrection_enabled:true, gammaCorrection_hueSpeed:.49, concentricTile_enabled:true,
concentricTile_scaleFactor:1.83, concentricTile_blend:.5, concentricTile_innerRings:0,
controlModulations: perlinNoiseIntensity{mode:audio, source:flux, amount:2.8},
radialMix{mode:audio, source:flux, amount:2.2, invert:true};
cameraState{position:{x:78.14,y:50.52,z:36.86}, target:{x:-0.745,y:-12.28,z:-2.660}}.

## Our port (telemetry, not audio)
speed → traveling crest amplitude + phase; gy → radial ring amplitude/sign
(accel out, brake in); gx → bank; ‖G‖ → perlin breathing + crimson g-hot lerp.
Concepts re-implemented from observation; no code or assets copied from the
proprietary minified bundle. Deliberately omitted: feedback/gammaCorrection post
chain, starfield, spiral/circle warps (GPU budget on the Tesla browser).
```

Commit:
```bash
git add docs/visualizer-research.md .hermes/plans
git commit -m "docs: vizz.fm Mesh Grid research + telemetry port map"
```
Expected: `1 file changed` (or 2 if the plan file is included).

## Task 2 — Test: HOME shows the viz layer, other pages don't (write failing test first) (3 min)

Create `tests/viz-telemetry.spec.mjs`:

```js
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
```

Run: `npx playwright test tests/viz-telemetry.spec.mjs`
Expected FAIL: `TypeError: Cannot read properties of null (reading 'display')` at the first expect (there is no `#viz` yet). Copy-paste the failing test text into the file before writing ANY app code.

## Task 3 — Implement the layer + module skeleton (make it pass) (10 min)

**3a. `index.html`** — two patches:

```html
      <canvas id="stage" aria-hidden="true"></canvas>
      <canvas id="viz" aria-hidden="true"></canvas>
```
and (replacing the whole `#page-home` section):
```html
        <section class="page" id="page-home" aria-label="Home">
          <div class="home-hint" id="home-hint">SPEED · G-FORCE REACTIVE</div>
          <div class="viz-status" id="viz-status">NO SIGNAL</div>
        </section>
```

**3b. `src/styles/base.css`** — append after the `#stage { ... }` block:

```css
#viz {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  display: none;
}

/* HOME is the visualizer stage: carScene blackouts the car there (like it
   already does for dash) and #viz paints over it — later in the DOM, same
   z-index, so stacking is deterministic. */
html[data-page="home"] #viz {
  display: block;
}
```

**3c. `src/styles/pages.css`** — append (inside/after the `/* ---------- home ---------- */` block):

```css
.viz-status {
  position: absolute;
  left: var(--sp-4);
  bottom: var(--sp-4);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.3em;
  color: var(--text-faint);
}
```

**3d. `src/three/carScene.ts`** — two patches:
- `const ACCENT_COLORS: Record<Accent, THREE.Color> = {` → `export const ACCENT_COLORS: Record<Accent, THREE.Color> = {`
- inside `setPage(page)`: `blackout = page === "dash";` →
  ```ts
      blackout = page === "dash" || page === "home"; // home: telemetry visualizer paints over the stage
  ```

**3e. New file `src/three/telemetryViz.ts`** (skeleton — flat dim grid + lifecycle + hooks; displacement comes in Tasks 7/9):

```ts
import * as THREE from "three";
import { getState, subscribe } from "../state";
import { ACCENT_COLORS } from "./carScene";
import { createSensorFeed, type SensorFeed } from "../ui/sensors";
import { GRID_D, GRID_W, SEG_X, SEG_Z } from "../ui/vizMath";

/**
 * HOME telemetry visualizer — a three.js mesh grid that replaces the car on
 * the HOME tab (carScene blackouts the stage there). A flat grid's position
 * buffer is displaced on the CPU every frame from ui/sensors telemetry; the
 * channel map ports vizz.fm's "Mesh Grid" preset (docs/visualizer-research.md):
 * speed -> traveling crests, longitudinal G -> radial rings, lateral G -> bank,
 * total G -> perlin breathing + crimson g-hot colour.
 *
 * Lifecycle mirrors dash.ts exactly: one feed instance, start/stop on page
 * switch, gauges ride rAF (feed.read() extrapolates the filter to "now").
 * Real data only — offline the grid parks at idle and #viz-status reads
 * NO SIGNAL. Debug hooks: window.__viz ({stats, feed}) + window.__vizfeed,
 * same spirit as window.__dashfeed (tests fake feed.read).
 */

export interface VizStats {
  maxAbsY: number;   // largest |displacement| on the grid this frame
  leftMeanY: number; // mean y over x < -60
  rightMeanY: number;// mean y over x > +60
  travel: number;    // cumulative crest phase (rad) — grows only while moving
  wave: number;
  pulse: number;     // signed ring amplitude (+ accel / - brake)
  bankGx: number;    // smoothed clamped lateral G
  hot: number;       // 0..1 crimson mix (1 at >= 1 g total)
  signal: "LIVE" | "NO SIGNAL";
}

export interface TelemetryViz {
  stats(): VizStats;
  feed: SensorFeed;
}

export function initTelemetryViz(canvas: HTMLCanvasElement): TelemetryViz {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1); // OLED black, like the car stage

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    52, window.innerWidth / window.innerHeight, 0.1, 600
  );
  camera.position.set(0, 42, 104); // hero angle down the grid plane
  camera.lookAt(0, 0, -20);

  const geo = new THREE.PlaneGeometry(GRID_W, GRID_D, SEG_X, SEG_Z);
  geo.rotateX(-Math.PI / 2); // lay flat on x/z, y up

  const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x2a2a2a });
  scene.add(new THREE.Mesh(geo, wireMat));
  const dotMat = new THREE.PointsMaterial({
    color: 0x2a2a2a, size: 1.1, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  scene.add(new THREE.Points(geo, dotMat));

  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const feed = createSensorFeed();
  const stats: VizStats = {
    maxAbsY: 0, leftMeanY: 0, rightMeanY: 0, travel: 0,
    wave: 0, pulse: 0, bankGx: 0, hot: 0, signal: "NO SIGNAL",
  };
  let raf = 0;
  let running = false;

  function frame(): void {
    raf = requestAnimationFrame(frame);
    renderer.render(scene, camera);
  }
  function start(): void {
    if (running) return;
    running = true;
    feed.start();
    raf = requestAnimationFrame(frame);
  }
  function stop(): void {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    feed.stop(); // next visit re-anchors the ENU plane (see sensors.ts)
  }

  subscribe((s, prev) => {
    if (s.accent !== prev.accent) { /* colour wired in Task 9 */ }
    if (s.page === "home" && prev.page !== "home") start();
    else if (s.page !== "home" && prev.page === "home") stop();
  });
  if (getState().page === "home") start();

  (window as unknown as Record<string, unknown>).__viz = { stats: () => ({ ...stats }), feed };
  (window as unknown as Record<string, unknown>).__vizfeed = feed;

  return { stats: () => ({ ...stats }), feed };
}
```

**3f. `src/main.ts`** — two patches:
- after `import { initCarScene } from "./three/carScene";` add `import { initTelemetryViz } from "./three/telemetryViz";`
- after `const scene = initCarScene(canvas);` add:
  ```ts
  // ---------- home visualizer (replaces the car on HOME; self-subscribes) ----------
  initTelemetryViz(document.querySelector<HTMLCanvasElement>("#viz")!);
  ```

**3g. `src/ui/vizMath.ts`** — minimal placeholder so it typechecks (real math lands in Task 5):
```ts
export const GRID_W = 160; // x span, world units
export const GRID_D = 200; // z span
export const SEG_X = 100; // grid cells across (101 x 126 = 12,726 vertices)
export const SEG_Z = 125;
export const GRID_HALF_W = GRID_W / 2;
```

Run: `npx playwright test tests/viz-telemetry.spec.mjs`
Expected: `1 passed`. Then `npx tsc -p tsconfig.json --noEmit` → no output.

Commit:
```bash
git add index.html src/main.ts src/styles/base.css src/styles/pages.css src/three/telemetryViz.ts src/three/carScene.ts src/ui/vizMath.ts tests/viz-telemetry.spec.mjs
git commit -m "feat(viz): home visualizer layer - canvas, stage blackout, page lifecycle"
```

## Task 4 — Test: pure telemetry math (failing) (4 min)

Append to `tests/viz-telemetry.spec.mjs`:

```js
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
```

Run: `npx playwright test tests/viz-telemetry.spec.mjs`
Expected: first test passes, new one FAILS (`window.__vizmath is undefined`).

## Task 5 — Implement `src/ui/vizMath.ts` (passing) (8 min)

Replace the placeholder file entirely with the full module:

```ts
/**
 * Pure telemetry -> mesh-grid field math for the HOME visualizer
 * (src/three/telemetryViz.ts). No three.js, no DOM, no state: the Playwright
 * suite asserts these directly through window.__vizmath (exposed in DEV).
 *
 * Channel map ports vizz.fm's "Mesh Grid" preset (docs/visualizer-research.md):
 *   speed          -> crest amplitude + traveling phase (road rushing past)
 *   longitudinal G -> signed radial ring (+ accel expands, brake collapses)
 *   lateral G      -> bank slope (right turn dips the +x rim)
 *   total |G|      -> perlin breathing + crimson g-hot colour mix (>= 1 g)
 */

export const GRID_W = 160;   // x span, world units
export const GRID_D = 200;   // z span
export const SEG_X = 100;    // grid cells across (101 x 126 = 12,726 vertices)
export const SEG_Z = 125;
export const GRID_HALF_W = GRID_W / 2;

const TOP_SPEED_MS = 125 / 2.23694; // 125 mph — Juniper AWD top speed, m/s (same as dash.ts ramp)
const G_MAX = 1.6; // clamp G past real tire limits so spikes can't explode the field

export const K_TRAVEL = 0.2;  // crest wavelength ~ 2*pi/0.2 = 31 units
export const K_RING = 0.16;   // pulse ring wavelength ~ 39 units

export function clampG(g: number): number {
  return Math.max(-G_MAX, Math.min(G_MAX, g));
}

/** 0..1 normalized speed energy. */
export function speedEnergy(mps: number): number {
  return Math.min(1, Math.max(0, mps) / TOP_SPEED_MS);
}

/** Crest amplitude (world units); an idle ripple floor of 0.6 survives at 0 speed. */
export function waveAmp(mps: number): number {
  return 0.6 + 9.4 * Math.pow(speedEnergy(mps), 0.7);
}

/** Signed ring amplitude: + gy (accelerating) expands outward, brake collapses. */
export function pulseAmp(gy: number): number {
  return clampG(gy) * 7.5;
}

/** Bank slope: lateral G of +gx (right) dips the +x edge, up to 4.2 units at the rim. */
export function bankY(gx: number, x: number): number {
  return (-clampG(gx) * 4.2 * x) / GRID_HALF_W;
}

/** 0..1 tire-energy mix for the g-hot crimson lerp (>= 1.0 g total reads 1). */
export function hotMix(gx: number, gy: number): number {
  return Math.min(1, Math.hypot(gx, gy));
}

/** Per-frame field state (the renderer smooths/eases every value before use). */
export interface VizFrame {
  wave: number;       // crest amplitude
  travel: number;     // cumulative phase, rad — advances only while moving
  pulse: number;      // signed ring amplitude
  pulsePhase: number; // ring phase; sign of pulse picks outward/inward travel
  bankGx: number;     // smoothed, clamped lateral G
  noise: number;      // perlin breathing amplitude
  t: number;          // seconds since start (keeps idle breathing alive)
}

/** Grid height at world (x, z) for the current field frame. */
export function heightAt(x: number, z: number, f: VizFrame): number {
  let y = f.wave * Math.sin(z * K_TRAVEL + f.travel);
  y += f.pulse * Math.sin(Math.hypot(x, z) * K_RING - f.pulsePhase);
  y += bankY(f.bankGx, x);
  y += f.noise * valueNoise2(x * 0.045 + f.t * 0.35, z * 0.045 - f.t * 0.2);
  return y;
}

/** Deterministic lattice hash -> [0,1). */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Smooth bilinear value noise -> [-1,1] — dependency-free perlin stand-in. */
export function valueNoise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const s = (t: number): number => t * t * (3 - 2 * t);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf)) * 2 - 1;
}
```

**5b. `src/three/telemetryViz.ts`** — append at the bottom, after the existing `__vizfeed` line:

```ts
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__vizmath = vizMath;
  }
```
and extend the `../ui/vizMath` import to a namespace so the hook is one object:
`import { GRID_D, GRID_W, SEG_X, SEG_Z } from "../ui/vizMath";` →
```ts
import * as vizMath from "../ui/vizMath";
```
(then update usages in this file: `GRID_W` → `vizMath.GRID_W`, `GRID_D` → `vizMath.GRID_D`, `SEG_X` → `vizMath.SEG_X`, `SEG_Z` → `vizMath.SEG_Z` in the `PlaneGeometry(...)` line).

Run: `npx playwright test tests/viz-telemetry.spec.mjs` → `2 passed`.
`npx tsc -p tsconfig.json --noEmit` → no output.

Commit:
```bash
git add src/ui/vizMath.ts src/three/telemetryViz.ts tests/viz-telemetry.spec.mjs
git commit -m "feat(viz): pure telemetry math + __vizmath dev hook"
```

## Task 6 — Test: speed drives wave amplitude and crest travel (failing) (4 min)

Append:

```js
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
```

Run → this test FAILS (`stats().maxAbsY` stays 0 — nothing displaces yet).

## Task 7 — Implement displacement: speed waves + travel (passing) (8 min)

In `src/three/telemetryViz.ts`:

1. Extend the vizMath import line to:
```ts
import * as vizMath from "../ui/vizMath";
```
(no change needed — already namespace from Task 5; the new calls below use `vizMath.`).

2. Right after `const geo = ...` block, add the flat-state reference:
```ts
  const base = Float32Array.from(geo.attributes.position.array as Float32Array);
```

3. Replace the skeleton `frame()` with:
```ts
  let last = performance.now();
  let tSec = 0;
  let travel = 0;
  let waveS = 0;
  let noiseS = 0.3;

  function frame(): void {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tSec += dt;
    const snap = feed.read(); // filter peek -> 60 FPS field from ~1 Hz fixes
    const live = snap.live;

    waveS += ((live ? vizMath.waveAmp(snap.speed) : 0.24) - waveS) * 0.06;
    noiseS += ((live ? 1.0 : 0.3) - noiseS) * 0.06;
    if (live) travel += snap.speed * dt * vizMath.K_TRAVEL;

    const f: vizMath.VizFrame = {
      wave: waveS, travel, pulse: 0, pulsePhase: 0, bankGx: 0, noise: noiseS, t: tSec,
    };
    const pos = geo.attributes.position as THREE.BufferAttribute;
    let maxAbs = 0, lSum = 0, rSum = 0, lN = 0, rN = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = base[3 * i], z = base[3 * i + 2];
      const y = vizMath.heightAt(x, z, f);
      pos.setY(i, y);
      const a = Math.abs(y);
      if (a > maxAbs) maxAbs = a;
      if (x < -60) { lSum += y; lN++; }
      else if (x > 60) { rSum += y; rN++; }
    }
    pos.needsUpdate = true;

    stats.maxAbsY = maxAbs;
    stats.leftMeanY = lN ? lSum / lN : 0;
    stats.rightMeanY = rN ? rSum / rN : 0;
    stats.travel = travel;
    stats.wave = waveS;
    stats.signal = live ? "LIVE" : "NO SIGNAL";

    renderer.render(scene, camera);
  }
```

Run → `3 passed`. Typecheck clean.

Commit:
```bash
git add src/three/telemetryViz.ts tests/viz-telemetry.spec.mjs
git commit -m "feat(viz): speed-driven traveling crest displacement"
```

## Task 8 — Test: G-force reactions (failing) (4 min)

Append:

```js
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
```

Run → these two FAIL (`stats().pulse`/`hot`/bank stay 0).

## Task 9 — Implement G channels: ring, bank, g-hot colour (passing) (8 min)

In `src/three/telemetryViz.ts`:

1. Add near the other loop variables (before `frame`):
```ts
  const CRIMSON = new THREE.Color(0xff2d2d); // same g-hot red as the DASH G-meter
  let accentColor = ACCENT_COLORS[getState().accent].clone();
  let pulseS = 0, pulsePhase = 0, bankS = 0, hotS = 0;
```

2. In `frame()`, right after the `noiseS` easing line, add:
```ts
    pulseS += (vizMath.pulseAmp(live ? snap.gy : 0) - pulseS) * 0.08;
    bankS += (vizMath.clampG(live ? snap.gx : 0) - bankS) * 0.08;
    hotS += (vizMath.hotMix(live ? snap.gx : 0, live ? snap.gy : 0) - hotS) * 0.1;
    if (live) pulsePhase += dt * (1.5 + Math.abs(pulseS) * 0.35) * (pulseS >= 0 ? 1 : -1);
```

3. Fill the `VizFrame` fields (replace the zeros):
```ts
    const f: vizMath.VizFrame = {
      wave: waveS, travel, pulse: pulseS, pulsePhase, bankGx: bankS, noise: noiseS, t: tSec,
    };
```

4. Right after `pos.needsUpdate = true;` add the colour pass:
```ts
    wireMat.color.copy(accentColor).lerp(CRIMSON, hotS);
    dotMat.color.copy(wireMat.color);
    dotMat.opacity = Math.min(0.9, 0.22 + 0.5 * hotS + vizMath.speedEnergy(live ? snap.speed : 0) * 0.25);
```

5. In `frame()`'s stats block add:
```ts
    stats.pulse = pulseS;
    stats.bankGx = bankS;
    stats.hot = hotS;
```

6. In the existing `subscribe((s, prev) => {...})` replace the empty accent branch:
```ts
    if (s.accent !== prev.accent) accentColor = ACCENT_COLORS[s.accent].clone();
```

Run → `5 passed`. Typecheck clean.

Commit:
```bash
git add src/three/telemetryViz.ts tests/viz-telemetry.spec.mjs
git commit -m "feat(viz): G-force ring, bank, and g-hot crimson mix"
```

## Task 10 — Test: offline state reads NO SIGNAL (failing) (3 min)

Append:

```js
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
```

Run → FAILS (`#viz-status` text never updates from its static HTML value; signal stat already exists but text wiring doesn't — the first assertion passes by accident from the HTML default; the last assertion fails).

## Task 11 — Implement status readout (passing) (3 min)

In `src/three/telemetryViz.ts`, after `const feed = createSensorFeed();` add:
```ts
  const statusEl = document.getElementById("viz-status")!;
```
and in `frame()`'s stats block add:
```ts
    statusEl.textContent = live ? "LIVE" : "NO SIGNAL";
```

Run → `6 passed`.

Commit:
```bash
git add src/three/telemetryViz.ts tests/viz-telemetry.spec.mjs
git commit -m "feat(viz): LIVE / NO SIGNAL status readout"
```

## Task 12 — Test: `?vizdemo=1` scripted drive (failing) (3 min)

Append:

```js
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
```

Run → FAILS (`signal` stays `NO SIGNAL` — no GPS on desktop, and `toDataURL` would be tiny without `preserveDrawingBuffer`).

## Task 13 — Implement the DEV demo scenario (passing) (6 min)

In `src/three/telemetryViz.ts`:

1. Module-level, above `initTelemetryViz`:
```ts
import { createSensorFeed, type SensorFeed, type SensorSnapshot } from "../ui/sensors";

/** Scripted 30 s drive: launch -> top-speed cruise -> hard brake -> cornering
 *  roll-off. DEV-only (?vizdemo=1) so a live preview reacts without a GPS
 *  signal; production keeps the real-data-only rule from sensors.ts. */
function demoSnapshot(t: number): SensorSnapshot {
  const G = 9.81;
  const cyc = t % 30;
  let speed = 0, gy = 0, gx = 0;
  if (cyc < 6) { gy = 0.9; speed = 0.9 * G * cyc; }            // hard launch, 0 -> ~53 m/s
  else if (cyc < 12) { speed = 52.9; }                         // ~118 mph cruise
  else if (cyc < 15) { gy = -1.25; speed = Math.max(16, 52.9 - 1.25 * G * (cyc - 12)); }
  else if (cyc < 23) { speed = 16; gx = 1.1 * Math.sin((Math.PI * (cyc - 15)) / 8); } // 15 mph corner
  else { speed = Math.max(0, 16 - (16 / 7) * (cyc - 23)); }    // roll to stop, idle breathing
  return {
    live: true, speed, heading: 0, lat: 37.77, lng: -122.42, fixAt: performance.now(),
    sittingSec: 0, distanceM: 0, movingSec: 0, sittingTotalSec: 0,
    gx, gy, gLive: true, accuracy: 4, source: "gps", lastMoveClock: null,
  };
}
```
(update the existing `../ui/sensors` import line to include `type SensorSnapshot` rather than importing twice).

2. Inside `initTelemetryViz`, as the FIRST statement (the flag must exist before the renderer is built):
```ts
  const demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("vizdemo");
```
and change the renderer construction to:
```ts
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: demoMode });
```

3. After `const feed = createSensorFeed();` (and the `statusEl` line), add:
```ts
  if (demoMode) {
    const t0 = performance.now();
    feed.read = () => demoSnapshot((performance.now() - t0) / 1000);
  }
```

4. Update the status line in `frame()` to label the demo:
```ts
    statusEl.textContent = live ? (demoMode ? "LIVE · DEMO" : "LIVE") : "NO SIGNAL";
```

Run → `7 passed`. Full suite: `npx playwright test` → expect all ~24 specs passed (18 existing + 7 new minus none; the four pre-existing files must stay green — the `carScene.setPage` blackout change on home must not affect them).

Commit:
```bash
git add src/three/telemetryViz.ts tests/viz-telemetry.spec.mjs
git commit -m "feat(viz): ?vizdemo scripted drive scenario for live preview (DEV only)"
```

## Task 14 — Live preview, user approval gate, push + PR (10 min + user time)

1. Typecheck + suite one more time:
```bash
npx tsc -p tsconfig.json --noEmit          # expect: no output
npx playwright test                        # expect: all specs passed
```
2. Start the preview server:
```bash
npm run dev -- --port 5199 --strictPort    # expect: "VITE v6.x ready ... http://localhost:5199/"
```
3. **Live preview (ask the user to look):** open `http://localhost:5199/?vizdemo=1` — HOME now shows the reactive mesh grid running the scripted drive (you will see crests race by during launch, rings collapse inward on braking at ~12 s, the grid banks through the corner at ~15–23 s, and the wire flares crimson whenever total G passes 1.0). Also open plain `http://localhost:5199/` to confirm the idle state reads `NO SIGNAL` and that VEHICLE/NAVIGATE/MEDIA still render the car as before.
4. In-agent visual check (drives the running dev server via the browser tool): navigate to `/?vizdemo=1`, wait ~5 s into the launch phase, then `js("document.getElementById('viz').toDataURL('image/png')")` (works because demo mode sets `preserveDrawingBuffer`), decode the base64 to a PNG in the scratch dir and deliver it with `MEDIA:` so the user sees a frame inline. Do NOT trust a raw CDP screenshot (known black-canvas pitfall).
5. **STOP and ask the user to approve the look** (wave feel, colors, whether the car should stay visible behind the grid — that fallback is one line: drop `|| page === "home"` from the `carScene.setPage` blackout).
6. Only after explicit approval:
```bash
git push -u origin visualizer
gh pr create --base master --title "visualizer: telemetry-reactive mesh grid on HOME" \
  --body "Replaces the 3D car on the HOME tab with a vizz.fm 'Mesh Grid'-style visualizer driven by real telemetry: speed drives traveling crests, longitudinal G pulses rings (brake = collapse, accel = expand), lateral G banks the grid, total G >= 1 flares g-hot crimson. DEV-only ?vizdemo=1 scripted drive for preview. REA research notes in docs/visualizer-research.md."
```
Expected: `https://github.com/msrisabaranjan/juniper-console/pull/<n>` printed. Verify with `gh pr view --json number,title,url` before reporting success.

## Tests / validation summary

| # | Assertion | Command |
|---|---|---|
| 1 | `#viz` visible only on HOME | `npx playwright test tests/viz-telemetry.spec.mjs` |
| 2 | math monotone/signed/deterministic | idem |
| 3 | speed → amplitude + crest travel; parked → both stop | idem |
| 4 | brake ring sign + g-hot >0.85; accel flips outward | idem |
| 5 | bank sign flips with gx | idem |
| 6 | offline `NO SIGNAL`, tiny idle; fake live → `LIVE` | idem |
| 7 | `?vizdemo=1` goes LIVE and canvas is PNG-capturable | idem |
| 8 | no regressions (18 existing specs) + typecheck | `npx playwright test` + `npx tsc -p tsconfig.json --noEmit` |
| 9 | human visual approval before push | browser at `:5199/?vizdemo=1` |

Every task is red → green → commit; nothing is pushed until Task 14 step 6 after user sign-off.

## Risks, tradeoffs, open questions

- **Scope of "replace home"** (open question, resolved at the preview gate): default hides the car on HOME only; VEHICLE/MEDIA/NAVIGATE unchanged. Revert = one line in `carScene.setPage`.
- **No vizz.fm code reused** — concepts only, from observed minified bundle; documented in `docs/visualizer-research.md`. Their feedback/gamma/starfield post chain and spiral/circle warps are deliberately omitted (GPU budget on the Tesla in-car browser; YAGNI for a speed/G viz).
- **CPU displacement cost**: 12.7k vertices × ~4 transcendental ops ≈ trivial at 60 fps desktop; the Tesla browser is Chromium-class but weak — if frame drops appear, halve `SEG_X/SEG_Z` in `vizMath.ts` (single constant site).
- **Real GPS on the Tesla** requires the https dev server (`npm run dev:https`) — geolocation needs a secure context; on plain localhost desktop the honest state is `NO SIGNAL`, which is why the DEV demo flag exists. `import.meta.env.DEV` means `?vizdemo` and `preserveDrawingBuffer` are dead-code-eliminated from `npm run build`.
- **Black WebGL screenshots** (repo pitfall): all automated verification goes through `__viz.stats()` DOM stats and `toDataURL` in demo mode — never pixel diffs.
- **Kalman/GPS realism at rest**: `speed:0` injected snapshots still ease the wave to its 0.6 idle floor plus breathing noise — intentional (a dead-flat grid looks broken); the `maxAbsY < 2.2` bound keeps that bounded.
- **`feed.read` override in tests/demo replaces the method on the object** — same contract `gmeter-honda.spec.mjs` already relies on; if `SensorFeed` ever goes `readonly`, revisit both call sites together.
