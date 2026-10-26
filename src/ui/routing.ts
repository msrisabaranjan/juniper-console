/**
 * Destination search + turn-by-turn routing for the NAVIGATE page, on free
 * key-less services (same spirit as OpenFreeMap tiles / Open-Meteo wx):
 *   · Nominatim  (nominatim.openstreetmap.org)  — geocoding / place search
 *   · Valhalla   (valhalla1.openstreetmap.de)   — driving routes, maneuvers
 *
 * Everything degrades instead of dead-ending: unreachable services surface a
 * status string to the UI, and fetchRoute falls back to a straight beeline
 * (dashed on the map, ROUTE OFFLINE in the HUD) so the 3D nav still flies.
 * Time/distance for the remaining route are scaled from the route summary —
 * estimates, labelled as such, never fabricated sensor data.
 */

export interface Place {
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

export type StepGlyph =
  | "straight"
  | "slight-left"
  | "left"
  | "sharp-left"
  | "uturn"
  | "sharp-right"
  | "right"
  | "slight-right"
  | "roundabout"
  | "merge"
  | "arrive"
  | "depart";

export interface RouteStep {
  glyph: StepGlyph;
  label: string; // e.g. "SHARP RIGHT · W MIDDLEFIELD RD"
  lengthMi: number;
}

export interface RouteResult {
  coords: [number, number][]; // lon,lat polyline
  lengthMi: number;
  timeSec: number;
  steps: RouteStep[];
  offline: boolean; // true = beeline fallback, no real route behind it
  /** Live-traffic seconds once TomTom re-prices this geometry; null = the
   * static (time-of-day-free) Valhalla estimate is all we honestly have. */
  liveSec: number | null;
}

export type LngLat = [number, number]; // lon, lat

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const VALHALLA = "https://valhalla1.openstreetmap.de/route";
const FETCH_TIMEOUT_MS = 8000;

export async function fetchTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- search ----

export async function searchPlaces(query: string, near?: LngLat): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];
  let url = `${NOMINATIM}?format=jsonv2&limit=6&addressdetails=0&acceptlanguage=en&q=${encodeURIComponent(q)}`;
  // bias toward the map: Nominatim has no location bias knob, but a wide
  // unbounded viewbox (~33 km around the car) promotes matches near "you"
  // over same-named places across the world
  if (near) {
    const box = `${near[0] - 0.3},${near[1] + 0.3},${near[0] + 0.3},${near[1] - 0.3}`;
    url += `&viewbox=${box}`;
  }
  const res = await fetchTimeout(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const rows = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
  const toPlace = (r: (typeof rows)[number]): Place => {
    const parts = (r.display_name as string).split(", ");
    return {
      name: parts[0],
      detail: parts.slice(1, 4).join(", "),
      lat: Number(r.lat),
      lon: Number(r.lon),
    };
  };
  let places = rows.filter((r) => r.lat && r.lon && r.display_name).map(toPlace);
  // a bare word like "pizza" can still rank some far-flown same-named village
  // above every local match, and one bad pick drifts the bias (and a >1500 km
  // route dies with a 400). If anything sits within ~150 km of the car, show
  // only local hits; the world stays reachable by typing more of the address.
  if (near && places.length) {
    const nearKm = (p: Place): number =>
      Math.hypot((p.lon - near[0]) * 111.32 * localCos(p.lat, near[1]), (p.lat - near[1]) * 111.32);
    const local = places.filter((p) => nearKm(p) <= 150);
    if (local.length) places = local;
  }
  return places;
}

// equirectangular x-scale for a local distance check (good enough at ~km scale)
function localCos(latA: number, latB: number): number {
  return Math.cos((((latA + latB) / 2) * Math.PI) / 180);
}

// ---------------------------------------------------------------- route ----

/** Google-style encoded polyline (precision 1e-6, as Valhalla ships it). */
function decodePolyline6(line: string): LngLat[] {
  const coords: LngLat[] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  const nextVal = (): number => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = line.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~((result >>> 1) as number) : result >>> 1;
  };
  while (i < line.length) {
    lat += nextVal();
    lng += nextVal();
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

// The public Valhalla build ships maneuvers as flat entries with a human
// `instruction` ("Make a sharp right onto West Middlefield Road.") and numeric
// type codes whose enum varies per build — so the glyph comes from the
// instruction text, which is stable. Order matters: specific before general.
const GLYPH_RULES: { re: RegExp; glyph: StepGlyph; label: string }[] = [
  { re: /u-?turn/i, glyph: "uturn", label: "U-TURN" },
  { re: /roundabout|traffic circle/i, glyph: "roundabout", label: "ROUNDABOUT" },
  { re: /merge.{0,24}\bleft\b/i, glyph: "slight-left", label: "MERGE LEFT" },
  { re: /merge.{0,24}\bright\b/i, glyph: "slight-right", label: "MERGE RIGHT" },
  { re: /merge/i, glyph: "merge", label: "MERGE" },
  { re: /fork.{0,24}\bleft\b/i, glyph: "slight-left", label: "FORK LEFT" },
  { re: /fork.{0,24}\bright\b/i, glyph: "slight-right", label: "FORK RIGHT" },
  { re: /sharp right/i, glyph: "sharp-right", label: "SHARP RIGHT" },
  { re: /sharp left/i, glyph: "sharp-left", label: "SHARP LEFT" },
  { re: /slight right/i, glyph: "slight-right", label: "SLIGHT RIGHT" },
  { re: /slight left/i, glyph: "slight-left", label: "SLIGHT LEFT" },
  { re: /\bright\b/i, glyph: "right", label: "RIGHT" },
  { re: /\bleft\b/i, glyph: "left", label: "LEFT" },
];

function abbreviate(name: string): string {
  return name
    .replace(/\broad\b/gi, "RD")
    .replace(/\bstreet\b/gi, "ST")
    .replace(/\bavenue\b/gi, "AV")
    .replace(/\bboulevard\b/gi, "BLVD")
    .replace(/\bhighway\b/gi, "HWY")
    .replace(/\binterstate\b/gi, "I")
    .replace(/\bdrive\b/gi, "DR")
    .replace(/\blane\b/gi, "LN");
}

function stepsFromManeuvers(maneuvers: unknown): RouteStep[] {
  if (!Array.isArray(maneuvers)) return [];
  const steps: RouteStep[] = [];
  for (const raw of maneuvers) {
    const m = raw as { instruction?: string; length?: number; street_names?: string[] };
    const instr = m.instruction;
    if (!instr || m.length == null) continue;
    const rule = GLYPH_RULES.find((g) => g.re.test(instr));
    const glyph = rule?.glyph ?? "straight";
    const label = rule?.label ?? "CONTINUE";
    const streets = (m.street_names ?? []).map(abbreviate).join(" / ");
    steps.push({ glyph, label: streets ? `${label} · ${streets.toUpperCase()}` : label, lengthMi: m.length });
    if (steps.length >= 8) break;
  }
  return steps;
}

/** Straight-line fallback so the nav still flies when Valhalla is unreachable. */
export function beeline(from: LngLat, to: LngLat): RouteResult {
  const STEPS = 24;
  const coords: LngLat[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    coords.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  const dy = (to[1] - from[1]) * 111_320;
  const dx = (to[0] - from[0]) * 111_320 * Math.cos((((to[1] + from[1]) / 2) * Math.PI) / 180);
  return {
    coords,
    lengthMi: Math.hypot(dx, dy) / 1609.34,
    timeSec: (Math.hypot(dx, dy) / 1609.34 / 25) * 3600, // ~25 mph urban guess — an estimate, flagged offline
    steps: [],
    offline: true,
    liveSec: null,
  };
}

/** Waypoint-routed Valhalla call (2+ locations); the shared core for main routes and alternates. */
async function valhallaRoute(locations: { lat: number; lon: number }[]): Promise<RouteResult> {
  const body = { locations, costing: "auto", units: "mi" };
  const res = await fetchTimeout(VALHALLA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`route ${res.status}`);
  const trip = (await res.json())?.trip;
  // Geometry ships per-leg on this endpoint: trip.legs[].shape (polyline6),
  // with a flat maneuvers list per leg — stitch the legs into one polyline.
  // First/last maneuver per leg are depart/arrive noise; drop them.
  const legs: { shape?: string; maneuvers?: unknown[] }[] = Array.isArray(trip?.legs) ? trip.legs : [];
  let coords: LngLat[] = [];
  const maneuvers: unknown[] = [];
  for (const leg of legs) {
    const part = decodePolyline6(leg?.shape ?? "");
    coords = coords.length ? coords.concat(part.slice(1)) : part; // legs share joints
    if (Array.isArray(leg?.maneuvers)) maneuvers.push(...leg.maneuvers.slice(1, -1));
  }
  if (coords.length < 2) throw new Error("route empty");
  return {
    coords,
    lengthMi: trip?.summary?.length ?? 0,
    timeSec: trip?.summary?.time ?? 0,
    steps: stepsFromManeuvers(maneuvers),
    offline: false,
    liveSec: null,
  };
}

export async function fetchRoute(from: LngLat, to: LngLat): Promise<RouteResult> {
  return valhallaRoute([
    { lat: from[1], lon: from[0] },
    { lat: to[1], lon: to[0] },
  ]);
}

// ---------------------------------------------------------- alternates ----
// The public Valhalla endpoint ignores `alternates` (verified live: always
// exactly one leg), so alternates are mined the honest way — corridor probes.
// A via-point set ~perpendicular off a midpoint pulls Valhalla onto a
// genuinely different parallel road if one exists; probes that snap back onto
// the main route get deduped away, and probes that return a huge detour are
// dropped. Every kept alternate is a real drivable route with a real Valhalla
// time — the ETA is just static until traffic prices it.

/** Position + local heading (deg from north) at fraction f along a polyline. */
export function pointAlong(coords: LngLat[], cum: number[], f: number): { pos: LngLat; bearingDeg: number } | null {
  const total = cum[cum.length - 1];
  if (total <= 0) return null;
  const target = total * Math.min(1, Math.max(0, f));
  let i = 0;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const a = coords[Math.max(0, i - 1)];
  const b = coords[Math.min(coords.length - 1, i + 1)];
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 111_320;
  return { pos: coords[i], bearingDeg: (Math.atan2(dx, dy) * 180) / Math.PI };
}

/** Move a point `m` metres along the left (+) / right (−) normal of a heading. */
function offsetPerp(pos: LngLat, bearingDeg: number, m: number): LngLat {
  const a = ((bearingDeg + (m >= 0 ? 90 : -90)) * Math.PI) / 180;
  const d = Math.abs(m);
  const lon = pos[0] + (Math.sin(a) * d) / (111_320 * Math.cos((pos[1] * Math.PI) / 180));
  const lat = pos[1] + (Math.cos(a) * d) / 111_320;
  return [lon, lat];
}

/** Fraction of b's sampled vertices sitting within tolM of a's polyline —
 * ~1 means b is the same road, just re-encoded (a probe that snapped back). */
function coincidentFrac(a: LngLat[], b: LngLat[], tolM = 60): number {
  const aStep = Math.max(1, Math.floor(a.length / 120));
  const bStep = Math.max(1, Math.floor(b.length / 36));
  const tol2 = tolM * tolM;
  let hit = 0;
  let seen = 0;
  for (let j = 0; j < b.length; j += bStep) {
    seen++;
    const p = b[j];
    let found = false;
    for (let i = 0; i < a.length; i += aStep) {
      const dx = (a[i][0] - p[0]) * 111_320 * Math.cos((((a[i][1] + p[1]) / 2) * Math.PI) / 180);
      const dy = (a[i][1] - p[1]) * 111_320;
      if (dx * dx + dy * dy < tol2) {
        found = true;
        break;
      }
    }
    if (found) hit++;
  }
  return seen ? hit / seen : 0;
}

export async function fetchRouteAlternates(
  from: LngLat,
  to: LngLat,
  main: RouteResult,
  max = 2,
): Promise<RouteResult[]> {
  if (main.offline || main.coords.length < 2) return [];
  const cum = cumulativeMeters(main.coords);
  const total = cum[cum.length - 1];
  if (total < 1500) return []; // short hops don't have honest alternates
  const offset = Math.min(1600, Math.max(700, total * 0.15));
  const probes: LngLat[] = [];
  for (const f of [0.5, 0.32, 0.68]) {
    const p = pointAlong(main.coords, cum, f);
    if (!p) continue;
    probes.push(offsetPerp(p.pos, p.bearingDeg, +offset));
    probes.push(offsetPerp(p.pos, p.bearingDeg, -offset));
  }
  const alts: RouteResult[] = [];
  for (const via of probes) {
    if (alts.length >= max) break;
    let r: RouteResult;
    try {
      r = await valhallaRoute([
        { lat: from[1], lon: from[0] },
        { lat: via[1], lon: via[0] },
        { lat: to[1], lon: to[0] },
      ]);
    } catch {
      continue; // one probe failing must not sink the rest
    }
    if (r.coords.length < 2) continue;
    if (r.timeSec > main.timeSec * 2 || r.lengthMi > main.lengthMi * 1.9) continue; // a detour, not an alternate
    if (coincidentFrac(main.coords, r.coords) > 0.8) continue; // snapped back onto the main route
    if (alts.some((o) => coincidentFrac(o.coords, r.coords) > 0.8)) continue; // same as another kept alt
    alts.push(r);
  }
  return alts;
}

// ------------------------------------------------------------- progress ----

/** Cumulative meters along a polyline (same length as coords). */
export function cumulativeMeters(coords: LngLat[]): number[] {
  const acc: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const dy = (b[1] - a[1]) * 111_320;
    const dx = (b[0] - a[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    acc.push(acc[i - 1] + Math.hypot(dx, dy));
  }
  return acc;
}

/**
 * Fraction [0..1] of the route completed, by projecting the car position onto
 * the nearest polyline vertex. Coarse but honest; re-run once per GPS fix.
 */
export function routeProgress(coords: LngLat[], cum: number[], pos: LngLat): number {
  const total = cum[cum.length - 1];
  if (total <= 0) return 1;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const dy = (a[1] - pos[1]) * 111_320;
    const dx = (a[0] - pos[0]) * 111_320 * Math.cos((((a[1] + pos[1]) / 2) * Math.PI) / 180);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return Math.min(1, cum[bestI] / total);
}

/**
 * Meters the position sits off the polyline — true point-to-segment distance
 * (routeProgress only projects onto vertices, which under-reads on long
 * straight legs). Drives the wrong-turn detector; same local-plane math.
 */
export function offRouteMeters(coords: LngLat[], pos: LngLat): number {
  const toXY = (p: LngLat): [number, number] => [
    (p[0] - pos[0]) * 111_320 * Math.cos((pos[1] * Math.PI) / 180),
    (p[1] - pos[1]) * 111_320,
  ];
  // the position itself projects to the origin of this local plane
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = toXY(coords[i - 1]);
    const [bx, by] = toXY(coords[i]);
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, -(ax * ex + ay * ey) / len2));
    const d = Math.hypot(ax + t * ex, ay + t * ey);
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

// --------------------------------------------------------- active route ----
// The NAVIGATE page owns the route; the DASH elevation strip renders the same
// RouteResult without owning it. A plain module store (not AppState) keeps
// multi-KB coordinate arrays out of the state fan-out. `label` is the
// destination name so the strip can say what the profile belongs to.

export interface ActiveRoute {
  route: RouteResult;
  label: string;
}

let activeRoute: ActiveRoute | null = null;
let routeVersion = 0; // bumped on every set/clear — cheap change detector

export function setActiveRoute(route: RouteResult | null, label = ""): void {
  activeRoute = route ? { route, label } : null;
  routeVersion++;
}

export function getActiveRoute(): ActiveRoute | null {
  return activeRoute;
}

export function getRouteVersion(): number {
  return routeVersion;
}

/** Compass heading (rad, clockwise from north) from a to b — for re-aiming the demo fix. */
export function bearingRad(a: LngLat, b: LngLat): number {
  const dy = (b[1] - a[1]) * 111_320;
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return (Math.atan2(dx, dy) + Math.PI * 2) % (Math.PI * 2);
}
