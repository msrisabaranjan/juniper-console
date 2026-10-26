import * as THREE from "three";
import { getState, subscribe } from "../state";
// ACCENT_COLORS is imported in Task 9 when the g-hot colour pass lands
// (tsconfig noUnusedLocals rejects it until then).
// import { ACCENT_COLORS } from "./carScene";
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
