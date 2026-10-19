/**
 * Sensor feed for the DASH page — real data only.
 *
 * GPS via geolocation: each fix is projected onto a local ENU plane (ui/geo)
 * and fused in a constant-acceleration Kalman filter (ui/kalman) that
 * prioritises Doppler speed/heading over position differentials and weights
 * every fix by its accuracy field. The filter's physics model is then
 * extrapolated (peek) on every read, so 60 FPS renderers glide smoothly
 * between ~1 Hz fixes. Body-frame G comes from projecting the filtered
 * acceleration onto the velocity direction (lon + = accelerating, lat + = right).
 * devicemotion, where the platform offers it (rare in-car), outranks the
 * GPS-derived G. There is no simulated fallback: offline the map parks at the
 * last fix, trip accounting freezes, and readouts show dashes / NO SIGNAL.
 * Geolocation needs a secure context — http://localhost works for desktop,
 * the Tesla needs the https dev server.
 */

import { EnuFrame, type Enu } from "./geo";
import { KalmanCA } from "./kalman";

const G = 9.81;
const MOVE_SPEED = 0.5; // m/s below this counts as "sitting"
const GPS_STALE_MS = 10000; // stationary devices can go quiet between fixes
const MOTION_STALE_MS = 2000;
const PREDICT_CAP_MS = 2000; // never extrapolate the physics model past this

export type SensorSource = "gps" | "motion+gps" | "motion" | "off";

export interface SensorSnapshot {
  live: boolean; // fresh GPS fix
  speed: number; // m/s (0 when GPS offline)
  heading: number; // rad, 0 = north, clockwise (last known)
  lat: number | null; // last fix position (kept even when stale)
  lng: number | null;
  fixAt: number; // performance.now() of the last fix (0 = none yet)
  sittingSec: number; // continuous seconds without movement
  distanceM: number; // trip distance
  movingSec: number;
  sittingTotalSec: number;
  gx: number; // lateral g (+ = right)
  gy: number; // longitudinal g (+ = accelerating)
  gLive: boolean; // gx/gy come from a real sensor
  accuracy: number | null; // GPS accuracy, metres
  source: SensorSource;
  lastMoveClock: string | null; // local time of the last movement
}

export interface SensorFeed {
  read(): SensorSnapshot;
  start(): void;
  stop(): void;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function createSensorFeed(): SensorFeed {
  // ---- shared outputs (trip accounting) ----
  let lat: number | null = null;
  let lng: number | null = null;
  let fixAt = 0;
  let sittingSec = 0;
  let distanceM = 0;
  let movingSec = 0;
  let sittingTotalSec = 0;
  let accuracy: number | null = null;
  let lastMoveClock: string | null = null;

  // ---- GPS -> ENU -> Kalman pipeline ----
  let watchId: number | undefined;
  let lastGpsAt = 0;
  let frame: EnuFrame | null = null;
  let kalman: KalmanCA | null = null;
  let lastKalmanAt = 0;
  let prevEnu: Enu | null = null;
  let gpsHeading = 0; // rad clockwise from north, last trustworthy value

  // ---- devicemotion state ----
  let motionOn = false;
  let lastMotionAt = 0;
  let gravX = 0;
  let gravY = 0;
  let mGx = 0;
  let mGy = 0;

  let timer: number | undefined;
  let lastTick = 0;

  const onMotion = (e: DeviceMotionEvent): void => {
    let ax = e.acceleration?.x;
    let ay = e.acceleration?.y;
    if (ax == null || ay == null) {
      const incl = e.accelerationIncludingGravity;
      if (!incl || incl.x == null || incl.y == null) return;
      // low-pass the raw signal to estimate gravity, subtract for linear accel
      gravX = gravX * 0.92 + incl.x * 0.08;
      gravY = gravY * 0.92 + incl.y * 0.08;
      ax = incl.x - gravX;
      ay = incl.y - gravY;
    }
    motionOn = true;
    lastMotionAt = performance.now();
    mGx += (ax / G - mGx) * 0.3;
    mGy += (ay / G - mGy) * 0.3;
  };

  const onPosition = (pos: GeolocationPosition): void => {
    const c = pos.coords;
    const now = performance.now();
    lastGpsAt = now;
    fixAt = now;
    accuracy = c.accuracy;
    lat = c.latitude;
    lng = c.longitude;

    // first fix of the session anchors the local ENU plane
    if (!frame || !kalman) {
      frame = new EnuFrame(c.latitude, c.longitude);
      kalman = new KalmanCA();
      kalman.reset([0, 0, 0, 0, 0, 0]);
      lastKalmanAt = now;
      prevEnu = null;
    }
    const enu = frame.toEnu(c.latitude, c.longitude);
    const dtFix = Math.max(0.2, (now - lastKalmanAt) / 1000);

    // Doppler speed+heading are the primary velocity source (carrier-phase
    // measurement, ~0.1 m/s); position differentials are the fallback only.
    let vE = 0;
    let vN = 0;
    if (c.speed != null && !Number.isNaN(c.speed)) {
      let hdg = c.heading != null && !Number.isNaN(c.heading) ? c.heading * (Math.PI / 180) : null;
      if (hdg == null && c.speed > 1 && prevEnu) {
        hdg = Math.atan2(enu.east - prevEnu.east, enu.north - prevEnu.north);
      }
      if (hdg == null) hdg = gpsHeading;
      vE = c.speed * Math.sin(hdg);
      vN = c.speed * Math.cos(hdg);
      gpsHeading = hdg;
    } else if (prevEnu) {
      vE = (enu.east - prevEnu.east) / dtFix;
      vN = (enu.north - prevEnu.north) / dtFix;
      if (Math.hypot(vE, vN) > 1) gpsHeading = Math.atan2(vE, vN);
    }

    // predict to the fix instant, then correct. R scales with accuracy:
    // degraded fixes (tunnel, trees) fall toward the physics model.
    kalman.predict(Math.min(10, dtFix));
    const posVar = Math.max(1, c.accuracy ** 2);
    const velVar = Math.max(0.1, c.accuracy * 0.03) ** 2;
    kalman.update([enu.east, enu.north, vE, vN], posVar, velVar);

    lastKalmanAt = now;
    prevEnu = enu;
  };

  /** Filter state extrapolated to `now`, projected into the car's body frame. */
  function gpsSample(now: number): { spd: number; hdg: number; gx: number; gy: number } | null {
    if (!kalman) return null;
    const st = kalman.peek(Math.min(PREDICT_CAP_MS, now - lastKalmanAt) / 1000);
    const vE = st[2];
    const vN = st[3];
    const spd = Math.hypot(vE, vN);
    const hdg = spd > 1 ? Math.atan2(vE, vN) : gpsHeading;
    // lon G = a·v̂ (throttle +, braking −), lat G = a·right (right = (uN, −uE))
    let uE: number;
    let uN: number;
    if (spd > 0.5) {
      uE = vE / spd;
      uN = vN / spd;
    } else {
      uE = Math.sin(hdg); // parked: use the last travel direction
      uN = Math.cos(hdg);
    }
    const gy = (st[4] * uE + st[5] * uN) / G;
    const gx = (st[4] * uN - st[5] * uE) / G;
    return { spd, hdg: wrapAngle(hdg), gx, gy };
  }

  const gpsAlive = (): boolean =>
    lastGpsAt > 0 && performance.now() - lastGpsAt < GPS_STALE_MS;
  const motionAlive = (): boolean => motionOn && performance.now() - lastMotionAt < MOTION_STALE_MS;

  function tick(): void {
    const now = performance.now();
    const dt = Math.min(0.5, (now - lastTick) / 1000);
    lastTick = now;

    // trip accounting only runs on real fixes; offline freezes the counters
    if (gpsAlive()) {
      const smp = gpsSample(now);
      const spd = smp ? smp.spd : 0;
      if (spd > MOVE_SPEED) {
        movingSec += dt;
        distanceM += spd * dt;
        sittingSec = 0;
        lastMoveClock = new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
      } else {
        sittingSec += dt;
        sittingTotalSec += dt;
      }
    }
  }

  return {
    read() {
      const now = performance.now();
      const live = gpsAlive();
      const motion = motionAlive();
      const smp = live ? gpsSample(now) : null;
      // G source ladder: accelerometer > GPS-derived > none
      let gx = 0;
      let gy = 0;
      if (motion) {
        gx = mGx;
        gy = mGy;
      } else if (smp) {
        gx = smp.gx;
        gy = smp.gy;
      }
      const source: SensorSource = live
        ? motion
          ? "motion+gps"
          : "gps"
        : motion
          ? "motion"
          : "off";
      return {
        live,
        speed: smp ? smp.spd : 0,
        heading: smp ? smp.hdg : gpsHeading,
        lat,
        lng,
        fixAt,
        sittingSec,
        distanceM,
        movingSec,
        sittingTotalSec,
        gx,
        gy,
        gLive: motion || live,
        accuracy: live ? accuracy : null,
        source,
        lastMoveClock,
      };
    },
    start() {
      if (timer !== undefined) return;
      lastTick = performance.now();
      timer = window.setInterval(tick, 200);
      window.addEventListener("devicemotion", onMotion);
      if (navigator.geolocation) {
        // maximumAge 0: no cached fixes; timeout: fail fast when the signal dies
        watchId = navigator.geolocation.watchPosition(onPosition, () => {
          /* denied/unavailable: readouts stay offline until a real fix lands */
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
      }
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      window.removeEventListener("devicemotion", onMotion);
      if (watchId !== undefined && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
        watchId = undefined;
      }
      // next session re-anchors the ENU plane and re-inits the filter
      frame = null;
      kalman = null;
      prevEnu = null;
    },
  };
}
