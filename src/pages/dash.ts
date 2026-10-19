import { setState, subscribe } from "../state";
import { cancelFx, glitchIn, hideForType, schedule, typeIn } from "../ui/fx";
import { createMapView } from "../ui/mapView";
import { createSensorFeed, type SensorSnapshot } from "../ui/sensors";
import { createWeatherFeed } from "../ui/weather";

/**
 * DASH — track-style telemetry screen (Roadster Track Mode homage).
 *
 * Everything real runs off ui/sensors.ts (GPS -> ENU -> Kalman, see the
 * telemetry note in the README) and the panels redraw on requestAnimationFrame:
 * the filter's peek() extrapolates the physics model between ~1 Hz GPS fixes,
 * so the gauges run at 60 FPS while data lands once per second.
 * BRAKE / ACCEL / REGEN are derived from filtered longitudinal G while a live
 * fix is held and park at NO SIGNAL otherwise; AERO BALANCE has no sensor
 * source yet and stays parked. Map, trip stats and exterior temp follow the
 * same real sources (GPS + Open-Meteo) — offline they freeze and dash.
 */

const STAGGER = 70; // ms between panel entrances
const GLITCH_LEAD = 150; // glitch burst runs this long before typing starts
const TRAIL_MS = 40; // G-trail sample gap (~1 s of history at 26 points)

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** h:mm:ss */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const MPH = 2.23694; // m/s -> mph
const G = 9.81; // m/s² per g
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// pedal-envelope assumptions for deriving pedal % from filtered lon G
const ACCEL_G_FULL = 1.0; // +1.0 g reads as 100 % throttle
const BRAKE_G_FULL = 1.2; // −1.2 g reads as 100 % brake
const REGEN_G_FULL = 0.35; // decel up to this is regen doing the work
const REGEN_KW_MAX = 120; // gauge scale
const VEH_MASS = 2000; // ~kg, Model Y Performance, for the regen power estimate

export interface DashPage {
  playIntro(): void;
  /** Status-bar ticker text for the dash page (TRIP · MOVING · SITTING). */
  ticker(): string;
}

export function initDashPage(onStatus: () => void): DashPage {
  const el = {
    brakeFill: $("dash-brake-fill"),
    brakeVal: $("dash-brake-val"),
    accelFill: $("dash-accel-fill"),
    accelVal: $("dash-accel-val"),
    regenFill: $("dash-regen-fill"),
    regenVal: $("dash-regen-val"),
    extFill: $("dash-exttemp-fill"),
    extVal: $("dash-exttemp-val"),
    gsvg: $("dash-gsvg"),
    gdot: $("dash-gdot"),
    gtrail: $("dash-gtrail"),
    gLat: $("dash-g-lat"),
    gLon: $("dash-g-lon"),
    mapSitting: $("dash-map-sitting"),
    mapSub: $("dash-map-sub"),
    tripDist: $("dash-trip-dist"),
    tripMoving: $("dash-trip-moving"),
    tripSitting: $("dash-trip-sitting"),
    tripSpeed: $("dash-trip-speed"),
    tripLastMove: $("dash-trip-lastmove"),
    tripGps: $("dash-trip-gps"),
    abalF: $("dash-abal-f"),
    abalR: $("dash-abal-r"),
    abalMark: $("dash-abal-mark"),
    exit: $("dash-exit"),
  };

  // ---- real sensors + map + weather (GPS / accelerometer / Open-Meteo) ----
  const feed = createSensorFeed();
  const map = createMapView($("dash-map-wrap"), feed);
  const weather = createWeatherFeed();

  // debug hooks (same spirit as window.__stage): poke a fake feed in the
  // console to exercise the map without a GPS signal
  (window as unknown as Record<string, unknown>).__dashfeed = feed;
  (window as unknown as Record<string, unknown>).__dashmap = map;
  (window as unknown as Record<string, unknown>).__wx = weather;

  const trail: [number, number][] = [];
  let lastTrailAt = 0;

  const gScale = 10; // 1g = 10 svg units (ring at 14 ≈ 1.4g)

  // no sensor source maps chassis/aero loads yet — park the panel
  el.abalF.textContent = "—";
  el.abalR.textContent = "—";
  el.abalMark.style.left = "50%";

  function render(snap: SensorSnapshot): void {
    // pedals: derived from the Kalman-filtered longitudinal G
    if (snap.live) {
      const decel = Math.max(0, -snap.gy);
      const accelPct = clamp01(snap.gy / ACCEL_G_FULL) * 100;
      const brakePct = clamp01(decel / BRAKE_G_FULL) * 100;
      // light deceleration is regen braking; past ~0.35 g the friction brake
      // fades in and regen tapers off toward zero
      const regenFrac =
        Math.min(1, decel / REGEN_G_FULL) * (1 - clamp01((decel - REGEN_G_FULL) / 0.4));
      const regenKw =
        Math.min(REGEN_KW_MAX, (VEH_MASS * G * decel * snap.speed) / 1000) * regenFrac;

      el.brakeFill.style.width = `${brakePct}%`;
      el.brakeVal.textContent = `${Math.round(brakePct)}%`;
      el.accelFill.style.width = `${accelPct}%`;
      el.accelVal.textContent = `${Math.round(accelPct)}%`;
      el.regenFill.style.width = `${(regenKw / REGEN_KW_MAX) * 100}%`;
      el.regenVal.textContent = `${Math.round(regenKw)} kW`;
    } else {
      el.brakeFill.style.width = "0%";
      el.brakeVal.textContent = "—";
      el.accelFill.style.width = "0%";
      el.accelVal.textContent = "—";
      el.regenFill.style.width = "0%";
      el.regenVal.textContent = "—";
    }

    const extT = weather.tempF();
    el.extVal.textContent = extT === null ? "—" : `${Math.round(extT)}°F`;
    // bar maps roughly -10°F..110°F across its width
    el.extFill.style.width =
      extT === null ? "0%" : `${Math.max(0, Math.min(1, (extT + 10) / 120)) * 100}%`;

    // G-meter: live sensor values (devicemotion > GPS-derived > parked)
    const px = snap.gx * gScale;
    const py = -snap.gy * gScale;
    el.gdot.setAttribute("cx", px.toFixed(2));
    el.gdot.setAttribute("cy", py.toFixed(2));
    const now = performance.now();
    if (now - lastTrailAt > TRAIL_MS) {
      trail.push([px, py]);
      if (trail.length > 26) trail.shift();
      lastTrailAt = now;
    }
    el.gtrail.setAttribute("points", trail.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
    el.gLat.textContent = snap.gLive ? snap.gx.toFixed(2) : "—";
    el.gLon.textContent = snap.gLive ? snap.gy.toFixed(2) : "—";

    // map readout: how long the car has been sitting in this spot
    el.mapSitting.textContent = fmtClock(snap.sittingSec);
    if (snap.live) {
      const acc = snap.accuracy === null ? "" : ` · ACC ${Math.round(snap.accuracy)}M`;
      el.mapSub.textContent = `${Math.round(snap.speed * MPH)} MPH${acc} · GPS`;
    } else {
      el.mapSub.textContent = "NO SIGNAL";
    }

    // trip stats (GPS-derived, frozen while offline)
    el.tripDist.textContent = `${(snap.distanceM * 0.000621371).toFixed(1)} MI`;
    el.tripMoving.textContent = fmtClock(snap.movingSec);
    el.tripSitting.textContent = fmtClock(snap.sittingTotalSec);
    el.tripSpeed.textContent = snap.live ? `${Math.round(snap.speed * MPH)} MPH` : "—";
    el.tripLastMove.textContent = snap.lastMoveClock ?? "—";
    el.tripGps.textContent =
      snap.source === "gps"
        ? "LIVE"
        : snap.source === "motion+gps"
          ? "LIVE · ACCEL"
          : snap.source === "motion"
            ? "ACCEL ONLY"
            : "NO SIGNAL";
  }

  let raf = 0;
  let slowTimer: number | undefined;

  function frame(): void {
    render(feed.read()); // read() extrapolates the filter to "now" -> 60 FPS gauges
    raf = requestAnimationFrame(frame);
  }

  function startAll(): void {
    if (raf) return;
    feed.start();
    map.start();
    render(feed.read());
    // weather + status ticker run at 4 Hz; gauges ride the rAF loop
    slowTimer = window.setInterval(() => {
      const snap = feed.read();
      weather.maybeUpdate(snap.lat, snap.lng); // exterior temp follows the real fix
      onStatus();
    }, 250);
    raf = requestAnimationFrame(frame);
  }

  function stopAll(): void {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (slowTimer !== undefined) {
      clearInterval(slowTimer);
      slowTimer = undefined;
    }
    feed.stop();
    map.stop();
  }

  subscribe((s, prev) => {
    if (s.page === "dash" && prev.page !== "dash") startAll();
    else if (s.page !== "dash" && prev.page === "dash") stopAll();
  });

  // ---- map road colors follow the accent theme (Crimson <-> Chalk) ----
  subscribe((s, prev) => {
    if (s.accent !== prev.accent) {
      map.setAccent(s.accent === "red" ? [255, 45, 45] : [242, 242, 242]);
    }
  });

  el.exit.addEventListener("click", () => setState({ page: "home" }));

  // ---- glitch -> type-in entrance, same language as the Vehicle menu ----
  const panelEls = [...document.querySelectorAll<HTMLElement>("#page-dash .dash-title")];
  const introTargets: HTMLElement[] = [...panelEls, el.exit];

  function playIntro(): void {
    cancelFx();
    introTargets.forEach(hideForType);
    let t = 0;
    for (const node of introTargets) {
      schedule(t, () => glitchIn(node));
      schedule(t + GLITCH_LEAD, () => typeIn(node));
      t += STAGGER;
    }
  }

  return {
    playIntro,
    ticker() {
      const s = feed.read();
      if (!s.live) return "GPS OFFLINE · TRIP STATS PAUSED";
      return `TRIP ${(s.distanceM * 0.000621371).toFixed(1)} MI · MOVING ${fmtClock(
        s.movingSec
      )} · SITTING ${fmtClock(s.sittingTotalSec)}`;
    },
  };
}
