import * as THREE from "three";
import { getState, subscribe } from "../state";
import { ACCENT_COLORS } from "./carScene";
import { createSensorFeed, type SensorFeed } from "../ui/sensors";
import * as vizMath from "../ui/vizMath";

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

  const geo = new THREE.PlaneGeometry(vizMath.GRID_W, vizMath.GRID_D, vizMath.SEG_X, vizMath.SEG_Z);
  geo.rotateX(-Math.PI / 2); // lay flat on x/z, y up
  const base = Float32Array.from(geo.attributes.position.array as Float32Array);

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
  const statusEl = document.getElementById("viz-status")!;
  const stats: VizStats = {
    maxAbsY: 0, leftMeanY: 0, rightMeanY: 0, travel: 0,
    wave: 0, pulse: 0, bankGx: 0, hot: 0, signal: "NO SIGNAL",
  };
  let raf = 0;
  let running = false;

  let last = performance.now();
  let tSec = 0;
  let travel = 0;
  let waveS = 0;
  let noiseS = 0.3;
  const CRIMSON = new THREE.Color(0xff2d2d); // same g-hot red as the DASH G-meter
  let accentColor = ACCENT_COLORS[getState().accent].clone();
  let pulseS = 0, pulsePhase = 0, bankS = 0, hotS = 0;

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
    pulseS += (vizMath.pulseAmp(live ? snap.gy : 0) - pulseS) * 0.08;
    bankS += (vizMath.clampG(live ? snap.gx : 0) - bankS) * 0.08;
    hotS += (vizMath.hotMix(live ? snap.gx : 0, live ? snap.gy : 0) - hotS) * 0.1;
    if (live) pulsePhase += dt * (1.5 + Math.abs(pulseS) * 0.35) * (pulseS >= 0 ? 1 : -1);
    if (live) travel += snap.speed * dt * vizMath.K_TRAVEL;

    const f: vizMath.VizFrame = {
      wave: waveS, travel, pulse: pulseS, pulsePhase, bankGx: bankS, noise: noiseS, t: tSec,
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
    wireMat.color.copy(accentColor).lerp(CRIMSON, hotS);
    dotMat.color.copy(wireMat.color);
    dotMat.opacity = Math.min(0.9, 0.22 + 0.5 * hotS + vizMath.speedEnergy(live ? snap.speed : 0) * 0.25);

    stats.maxAbsY = maxAbs;
    stats.leftMeanY = lN ? lSum / lN : 0;
    stats.rightMeanY = rN ? rSum / rN : 0;
    stats.travel = travel;
    stats.wave = waveS;
    stats.pulse = pulseS;
    stats.bankGx = bankS;
    stats.hot = hotS;
    stats.signal = live ? "LIVE" : "NO SIGNAL";
    statusEl.textContent = live ? "LIVE" : "NO SIGNAL";

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
    if (s.accent !== prev.accent) accentColor = ACCENT_COLORS[s.accent].clone();
    if (s.page === "home" && prev.page !== "home") start();
    else if (s.page !== "home" && prev.page === "home") stop();
  });
  if (getState().page === "home") start();

  (window as unknown as Record<string, unknown>).__viz = { stats: () => ({ ...stats }), feed };
  (window as unknown as Record<string, unknown>).__vizfeed = feed;

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__vizmath = vizMath;
  }

  return { stats: () => ({ ...stats }), feed };
}
