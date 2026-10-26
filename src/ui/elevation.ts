import {
  cumulativeMeters,
  fetchTimeout,
  getActiveRoute,
  pointAlong,
  routeProgress,
  setActiveRoute,
  type LngLat,
  type RouteResult,
} from "./routing";

/**
 * ELEVATION strip — the DASH tab's bottom-bar profile of whatever route
 * NAVIGATE currently holds (routing.ts active-route handoff).
 *
 * Heights come from the free key-less Open-Meteo elevation endpoint (same
 * service family as the dash exterior temp, CC BY 4.0). The route polyline is
 * resampled to a fixed number of points along cumulative metres, all heights
 * arrive in ONE request, and the answer is cached per RouteResult (a reroute
 * or alt-switch produces a new object -> refetch; revisits never refetch).
 * The car marker rides the same real GPS fix the dash gauges use — no fix,
 * no marker. An unreachable elevation service degrades to an honest status
 * line, never a made-up mountain.
 *
 * Lifecycle follows the dash page: refresh() on entry (fetch on demand),
 * tick() from the render loop for the marker. Routes only change on NAVIGATE,
 * so no polling is needed while DASH is up.
 */

const ELEV_API = "https://api.open-meteo.com/v1/elevation";
const SAMPLES = 40; // resample points — one Open-Meteo call covers the whole route
const M_TO_FT = 3.28084;
const VB_W = 300; // svg viewBox width, stretched by preserveAspectRatio=none;
const BASE_Y = 46; // profile baseline inside the viewBox (height 56)
const TOP_Y = 8;

const elevCache = new WeakMap<RouteResult, number[]>(); // metres, per sampled point
let inflight: Promise<void> | null = null;

/** Resample the route polyline to SAMPLES evenly-spaced (by metres) positions. */
function sampleRoute(route: RouteResult): LngLat[] {
  const cum = cumulativeMeters(route.coords);
  const pts: LngLat[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const p = pointAlong(route.coords, cum, i / (SAMPLES - 1));
    if (p) pts.push(p.pos);
  }
  return pts.length >= 2 ? pts : route.coords.slice(0, SAMPLES);
}

function fetchElevations(route: RouteResult): Promise<void> {
  if (elevCache.has(route)) return Promise.resolve();
  if (!inflight) {
    const pts = sampleRoute(route);
    const lats = pts.map((p) => p[1].toFixed(5)).join(",");
    const lons = pts.map((p) => p[0].toFixed(5)).join(",");
    inflight = fetchTimeout(`${ELEV_API}?latitude=${lats}&longitude=${lons}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`elevation ${res.status}`);
        const rows = (await res.json())?.elevation;
        if (!Array.isArray(rows) || rows.length !== pts.length) throw new Error("elevation shape");
        const metres = rows.map((v) => Number(v));
        if (metres.some((v) => !Number.isFinite(v))) throw new Error("elevation NaN");
        elevCache.set(route, metres);
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

const ft = (m: number): string => `${Math.round(m * M_TO_FT)} FT`;
const signedFt = (m: number): string => {
  const v = Math.round(Math.abs(m) * M_TO_FT);
  if (v === 0) return "±0 FT";
  return `${m > 0 ? "+" : "\u2212"}${v} FT`;
};

export interface ElevStrip {
  /** Re-read the active route, fetch heights if needed, repaint everything. */
  refresh(): void;
  /** Move the car marker from a live GPS fix (null hides it). Cheap — no fetch. */
  tick(pos: LngLat | null): void;
}

export function createElevStrip(): ElevStrip {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const el = {
    dest: $("elev-dest"),
    svg: $("elev-svg") as unknown as SVGSVGElement,
    area: $("elev-area") as unknown as SVGPathElement,
    line: $("elev-line") as unknown as SVGPathElement,
    car: $("elev-car") as unknown as SVGLineElement,
    empty: $("elev-empty"),
    gain: $("elev-gain"),
    loss: $("elev-loss"),
    max: $("elev-max"),
    delta: $("elev-delta"),
  };

  let drawnRoute: RouteResult | null = null;
  let drawnCum: number[] | null = null; // cumulative metres of the drawn route

  function setEmpty(text: string): void {
    el.empty.textContent = text;
    el.empty.hidden = false;
    el.svg.style.visibility = "hidden";
    el.car.style.display = "none";
    drawnRoute = null;
    drawnCum = null;
    for (const s of [el.gain, el.loss, el.max, el.delta]) s.textContent = "—";
  }

  function draw(route: RouteResult, label: string, metres: number[]): void {
    el.empty.hidden = true;
    el.svg.style.visibility = "visible";

    let lo = Infinity;
    let hi = -Infinity;
    let gain = 0;
    let loss = 0;
    for (let i = 0; i < metres.length; i++) {
      const m = metres[i];
      if (m < lo) lo = m;
      if (m > hi) hi = m;
      if (i > 0) {
        const d = m - metres[i - 1];
        if (d > 0) gain += d;
        else loss -= d;
      }
    }
    const span = Math.max(hi - lo, 1); // a dead-flat route still draws a straight line
    const x = (i: number): number => 2 + (i / (metres.length - 1)) * (VB_W - 4);
    const y = (m: number): number => BASE_Y - ((m - lo) / span) * (BASE_Y - TOP_Y);

    const pts = metres.map((m, i) => `${x(i).toFixed(1)},${y(m).toFixed(1)}`).join(" ");
    el.line.setAttribute("d", `M ${pts}`);
    el.area.setAttribute(
      "d",
      `M ${x(0).toFixed(1)},${BASE_Y} L ${pts} L ${x(metres.length - 1).toFixed(1)},${BASE_Y} Z`
    );

    drawnCum = cumulativeMeters(route.coords);
    const miles = drawnCum[drawnCum.length - 1] / 1609.34;
    el.dest.textContent = `TO ${(label || "ROUTE").toUpperCase()} · ${miles.toFixed(1)} MI`;
    el.gain.textContent = ft(gain);
    el.loss.textContent = ft(loss);
    el.max.textContent = ft(hi);
    el.delta.textContent = signedFt(metres[metres.length - 1] - metres[0]);
    drawnRoute = route;
  }

  function refresh(): void {
    const active = getActiveRoute();
    if (!active) {
      el.dest.textContent = "NO ACTIVE ROUTE";
      setEmpty("NO ACTIVE ROUTE — SET ONE ON NAVIGATE");
      return;
    }
    const { route, label } = active;
    const cached = elevCache.get(route);
    if (cached) {
      draw(route, label, cached);
      return;
    }
    setEmpty("ELEV DATA — FETCHING…");
    fetchElevations(route).then(
      () => {
        // the route may have changed under the fetch — only paint if it hasn't
        const now = getActiveRoute();
        if (!now || now.route !== route) refresh();
        else draw(route, label, elevCache.get(route)!);
      },
      () => {
        // still the same route? tell the truth about the service; a stale
        // rejection for a route that moved on stays silent
        if (getActiveRoute()?.route === route)
          setEmpty("ELEV DATA OFFLINE — RE-ENTER DASH TO RETRY");
      }
    );
  }

  function tick(pos: LngLat | null): void {
    if (!drawnRoute || !drawnCum || !pos) {
      el.car.style.display = "none";
      return;
    }
    const prog = routeProgress(drawnRoute.coords, drawnCum, pos);
    const cx = (2 + prog * (VB_W - 4)).toFixed(1);
    el.car.style.display = "";
    el.car.setAttribute("x1", cx);
    el.car.setAttribute("x2", cx);
  }

  // debug hook (same spirit as __dashfeed / __navmap): inject a fake route in
  // the console to see the strip without routing through NAVIGATE — the real
  // Open-Meteo fetch then runs against those coordinates.
  (window as unknown as Record<string, unknown>).__elev = {
    inject(coords: LngLat[], lengthMi: number, label = "DEBUG ROUTE"): void {
      setActiveRoute(
        { coords, lengthMi, timeSec: lengthMi * 100, steps: [], offline: false, liveSec: null },
        label
      );
      refresh();
    },
    refresh,
  };

  return { refresh, tick };
}
