import { fetchTimeout, type LngLat } from "./routing";

/**
 * Live traffic for the NAVIGATE map, on TomTom's free developer tier — and
 * entirely optional: without a saved key this module is inert and the page
 * behaves exactly as it always has (Valhalla routes, static estimates, no
 * traffic layer). Same degrade-instead-of-dead-ending spirit as the rest of
 * the console's data sources.
 *
 * Two jobs once a key is pasted into the HUD (stored in localStorage, never
 * in code or git):
 *   · flow tiles — transparent dark-tuned PNG rasters that MapLibre composites
 *     under the route lines, so congestion paints directly over the wireframe
 *     streets (fetch/caching handled by the raster source; the © TomTom
 *     attribution rides with the source and disappears when it is removed)
 *   · live ETAs — TomTom re-prices an EXISTING Valhalla polyline
 *     (reconstructionMode=update), so the free router still draws the roads
 *     and TomTom only adds an honest traffic-priced travel time per candidate
 */

const LS_KEY = "juniper.tomtom.key";
const TILE_STYLE = "relative0-dark"; // TomTom's traffic palette tuned for dark basemaps
const ROUTE_API = "https://api.tomtom.com/routing/1/calculateRoute";
const TILE_API = "https://api.tomtom.com/traffic/map/4/tile/flow";
const LIVE_MAX_POINTS = 400; // payload guard for the polyline being re-priced

export interface TrafficClient {
  hasKey(): boolean;
  /** Pass null/empty to remove the stored key. */
  setKey(key: string | null): void;
  /** MapLibre raster tile template with the key baked in, or null with no key. */
  tileUrl(): string | null;
  /** Live-traffic seconds for an existing polyline, or null on any failure. */
  liveEta(coords: LngLat[]): Promise<number | null>;
}

/** Google-style encoded polyline at 1e-6 precision (TomTom accepts precision 6). */
function encodePolyline6(coords: LngLat[]): string {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * 1e6);
    const iLng = Math.round(lng * 1e6);
    out += encodeDelta(iLat - pLat) + encodeDelta(iLng - pLng);
    pLat = iLat;
    pLng = iLng;
  }
  return out;
}

function encodeDelta(v: number): string {
  let d = v < 0 ? ~(v << 1) : v << 1;
  let out = "";
  while (d >= 0x20) {
    out += String.fromCharCode((0x20 | (d & 0x1f)) + 63);
    d >>>= 5;
  }
  return out + String.fromCharCode(d + 63);
}

export function createTraffic(): TrafficClient {
  let key = localStorage.getItem(LS_KEY)?.trim() || null;

  return {
    hasKey: () => key !== null,

    setKey(next: string | null): void {
      key = next && next.trim() ? next.trim() : null;
      if (key) localStorage.setItem(LS_KEY, key);
      else localStorage.removeItem(LS_KEY);
    },

    tileUrl(): string | null {
      // tileSize=512 asks TomTom for hi-res tiles; MapLibre is told 512 in the source spec.
      return key
        ? `${TILE_API}/${TILE_STYLE}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}&tileSize=512`
        : null;
    },

    async liveEta(coords: LngLat[]): Promise<number | null> {
      if (!key || coords.length < 2) return null;
      // reconstruction only needs the corridor shape — thin long routes down
      const step = Math.max(1, Math.ceil(coords.length / LIVE_MAX_POINTS));
      const sampled = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
      const first = sampled[0];
      const last = sampled[sampled.length - 1];
      // locations are lat,lon on this API; reconstructionMode=update keeps the
      // Valhalla geometry and refreshes only the dynamic (traffic) travel time
      const url =
        `${ROUTE_API}/${first[1]},${first[0]}:${last[1]},${last[0]}/json` +
        "?reconstructionMode=update&routeRepresentation=summaryOnly";
      try {
        const res = await fetchTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            encodedPolyline: encodePolyline6(sampled),
            encodedPolylinePrecision: 6,
          }),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as { routes?: { summary?: { travelTimeInSeconds?: number } }[] };
        const t = j.routes?.[0]?.summary?.travelTimeInSeconds;
        return typeof t === "number" && t > 0 ? t : null;
      } catch {
        return null; // offline / bad key / quota — the static ETA stands, nothing breaks
      }
    },
  };
}
