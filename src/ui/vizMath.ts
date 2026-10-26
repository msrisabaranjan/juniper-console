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
