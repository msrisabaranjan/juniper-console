import { Marker } from "maplibre-gl";
import type {
  GeoJSONSource,
  LineLayerSpecification,
  Map as MLMap,
  RasterLayerSpecification,
} from "maplibre-gl";
import { createMapView } from "./mapView";
import type { SensorFeed } from "./sensors";
import { cumulativeMeters, pointAlong, routeProgress, type LngLat, type RouteResult } from "./routing";

/**
 * NAVIGATE map — the Roadster-style wireframe 3D nav (the 0:48/1:24 beat of
 * the reveal video): black void, line-art streets, extruded ghost blocks,
 * pitched heading-up camera flying the same follow rig as the DASH map.
 *
 * On top of that shared rig this adds the routing overlay: a royal-blue route
 * polyline (dark casing + glow + core, always blue — the Tesla screen never
 * re-tints the route), a gold diamond destination pin, the destination block
 * itself extruded in gold while you drive to it, and three camera modes —
 * PLAN (flat 2D aerial showing the whole decision: active route + ghosted
 * alternates + on-map minute labels), FOLLOW (tilted heading-up chase cam at
 * the arrow) and OVERVIEW (fit the route, gentle tilt). Progress along the
 * route is computed per GPS fix so the ETA card counts down honestly.
 *
 * Alternates ride in the same geojson source, flagged `alt`: they ghost in
 * under the active royal-blue route as thin dashed steel lines, and selecting
 * one just reorders the list (the page owns selection; this map only paints).
 * Every candidate carries a `idx` property so plan-mode taps on lines or
 * labels can be routed back to the page via onRouteTap. The optional traffic
 * layer is a transparent raster (TomTom dark-tuned flow tiles, key-gated by
 * the page) inserted under the route lines, refreshed on a 5-minute tile
 * bucket so congestion colors keep pace while driving.
 */

const FOLLOW_PITCH = 50; // street-level 3D chase tilt, like the video
const IDLE_PITCH = 45; // no destination yet — showcase the extrusions
const OVERVIEW_PITCH = 40; // overview keeps some pitch — wireframes read flat at 0
const PLAN_PITCH = 0; // plan view is a flat north-up map, not a flyover
const FOLLOW_PARKED_ZOOM = 16.9; // close enough to read the street ahead, not just the block

// route line is royal blue in every theme — the planned route keeps its own
// color apart from the red roads (matches the DASH driven-path blue)
const ROUTE_RGB = "rgb(65, 105, 225)";
const ROUTE_BLUE = "rgba(65, 105, 225, 0.28)";
// destination highlight — same amber the DASH telemetry bars use (--car-drivetrain)
const GOLD_RGB = "255, 179, 71";

export type NavMode = "follow" | "overview" | "plan";

export interface NavMap {
  start(): void;
  stop(): void;
  destroy(): void;
  setAccent(rgb: [number, number, number]): void;
  /**
   * Paint (or clear with null/[]) the routed paths + destination pin.
   * routes[0] is the ACTIVE route (royal blue); the rest are ghosted alternates.
   * labels aligns with routes and puts a minute badge at each path's midpoint
   * in plan mode ("12 MIN" for the pick, "+3 MIN" deltas for the ghosts).
   */
  setRoutes(routes: RouteResult[] | null, labels?: (string | null)[]): void;
  /**
   * Enable the traffic raster with the given tile template(s), or disable it
   * with null. Attribution travels with the source; templates get a cache-
   * busting bucket param appended automatically on each 5-minute refresh.
   */
  setTraffic(tiles: string[] | null): void;
  setMode(mode: NavMode): void;
  getMode(): NavMode;
  /** Report taps on a route line/label (plan + overview modes) by index. */
  onRouteTap(cb: (idx: number) => void): void;
  /** Any map click, any mode — raw position + original mouse event (demo hook). */
  onMapClick(cb: (pos: LngLat, ev: MouseEvent) => void): void;
  /** Preview-only demo fix: park the arrow/chase cam at an off-route spot. */
  setDemoPos(pos: LngLat | null, headingRad?: number): void;
  /** Fraction [0..1] of the current route the car has completed. */
  progress(pos: LngLat): number;
  getMap(): MLMap;
}

// lines carry {alt, idx}, labels are extra Point features carrying {alt, idx,
// label} — line layers ignore point geometry, the symbol layer reads `has label`
const routeData = (
  route: RouteResult | null,
  alts: RouteResult[],
  labels: (string | null)[]
) => {
  const lineFeature = (r: RouteResult, idx: number, alt: boolean) => ({
    type: "Feature" as const,
    properties: { alt, idx },
    geometry: { type: "LineString" as const, coordinates: r.coords.map((c) => [c[0], c[1]]) },
  });
  // badge sits mid-path; alternates sample off-center so co-linear stretches
  // don't stack two labels on the same pixel
  const labelFeature = (r: RouteResult, idx: number, alt: boolean) => {
    const text = labels[idx];
    if (!text) return null;
    const f = alt ? (idx % 2 === 1 ? 0.62 : 0.38) : 0.5;
    const mid = pointAlong(r.coords, cumulativeMeters(r.coords), f);
    if (!mid) return null;
    return {
      type: "Feature" as const,
      properties: { alt, idx, label: text },
      geometry: { type: "Point" as const, coordinates: mid.pos },
    };
  };
  const feats: GeoJSON.Feature[] = [
    ...(route ? [lineFeature(route, 0, false)] : []),
    ...alts.map((a, i) => lineFeature(a, i + 1, true)),
  ];
  const badge = (r: RouteResult, idx: number, alt: boolean): void => {
    const p = labelFeature(r, idx, alt);
    if (p) feats.push(p);
  };
  if (route) badge(route, 0, false);
  alts.forEach((a, i) => badge(a, i + 1, true));
  return { type: "FeatureCollection" as const, features: feats };
};

export function createNavMap(container: HTMLElement, feed: SensorFeed): NavMap {
  const view = createMapView(container, feed, {
    style: "mapstyle-nav.json",
    pitch: IDLE_PITCH,
    parkedZoom: FOLLOW_PARKED_ZOOM,
    track: false, // the route polyline is the trail here, not a fading accent trace
    markerVariant: "nav", // glowing paper-plane kite instead of the dash arrow
    accentRoads: ["road_major", "road_motorway"], // only major roads take the accent; minor/path stay neutral line-art
  });
  const map = view.getMap();

  let route: RouteResult | null = null;
  let alts: RouteResult[] = []; // ghosted alternates; routes[0] on the page side is `route`
  let routeLabels: (string | null)[] = []; // plan-mode badges, aligned to [route, ...alts]
  let following = true; // our own mirror of the follow/overview mode
  let curMode: NavMode = "follow"; // last camera mode commanded (drives label/tap gating)
  let tapCb: ((idx: number) => void) | null = null;
  let clickCb: ((pos: LngLat, ev: MouseEvent) => void) | null = null;
  let sweepTimer: number | undefined;
  let hlTimers: number[] = [];
  let hlDone = false; // gold building highlight already resolved for this route
  let destRingFallback = false; // no extruded building found — pin pulses a gold ring
  let hlPulseTimer: number | undefined; // slow breathing glow on the gold block
  let hlData: GeoJSON.FeatureCollection | null = null; // last resolved footprints
  // radial ground ripple state: rings expand outward from the destination
  let pulseCx = 0;
  let pulseCy = 0;
  let pulseR0 = 12;
  let pulseRMax = 42;

  // ---------------------------------------------------------------- pin
  let pin: Marker | null = null;
  let pinEl: HTMLElement | null = null;

  function setPin(dest: LngLat | null): void {
    if (!dest) {
      if (pin) pin.remove();
      pin = null;
      pinEl = null;
      return;
    }
    if (!pin) {
      pinEl = document.createElement("div");
      pinEl.className = "nav-pin";
      pin = new Marker({ element: pinEl, anchor: "bottom" }).setLngLat(dest);
      pin.addTo(map);
    } else {
      pin.setLngLat(dest);
    }
    paintPin();
  }

  // pin is gold for the whole drive — the destination's color on the map
  function paintPin(): void {
    if (pinEl) pinEl.style.color = `rgb(${GOLD_RGB})`;
  }

  // -------------------------------------------------- destination highlight
  // Query the already-loaded line-art building footprints around the
  // destination and re-extrude them in gold, so the place you are heading to
  // physically lights up on the map. Footprints only resolve once the map is
  // at tile zoom, so the tries are scheduled after the overview fly, retried
  // on map idle, and end with a short zoom-probe onto the destination; if
  // that still finds no building, the pin pulses a gold ring.
  function clearDestHl(): void {
    for (const t of hlTimers) window.clearTimeout(t);
    hlTimers = [];
    hlDone = false;
    destRingFallback = false;
    hlData = null;
    stopHlPulse();
    for (const id of ["dest_hl_ext", "dest_hl_outline", "dest_pulse_ring"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ["dest_hl", "dest_pulse"]) {
      if (map.getSource(id)) map.removeSource(id);
    }
    if (pinEl) pinEl.classList.remove("nogeo");
  }

  // Score a single polygon (outer ring + holes) against the destination point,
  // in a tiny local metric frame (degrees are fine at this scale once
  // longitude is compressed by cos(lat)). Returns containment, distance, and
  // the polygon's area so we can prefer the most specific footprint.
  function polyScore(
    rings: [number, number][][],
    cx: number,
    cy: number,
    sx: number,
    sy: number,
  ): { inside: boolean; distM: number; areaM2: number } {
    let inside = false;
    let dist = Infinity;
    const ring = (pts: [number, number][], checkInside: boolean): void => {
      if (checkInside) {
        let inRing = false; // classic ray-cross point-in-polygon
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > cy !== yj > cy && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) {
            inRing = !inRing;
          }
        }
        if (inRing) inside = true;
      }
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const ax = (pts[j][0] - cx) * sx;
        const ay = (pts[j][1] - cy) * sy;
        const bx = (pts[i][0] - cx) * sx;
        const by = (pts[i][1] - cy) * sy;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2)) : 0;
        dist = Math.min(dist, Math.hypot(ax + t * dx, ay + t * dy));
      }
    };
    rings.forEach((r, i) => ring(r, i === 0));
    // shoelace area of the outer ring, in metres^2 — small = specific building
    let areaM2 = 0;
    const outer = rings[0];
    if (outer && outer.length >= 3) {
      let a = 0;
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const xi = (outer[i][0] - cx) * sx;
        const yi = (outer[i][1] - cy) * sy;
        const xj = (outer[j][0] - cx) * sx;
        const yj = (outer[j][1] - cy) * sy;
        a += xj * yi - xi * yj;
      }
      areaM2 = Math.abs(a / 2);
    }
    return { inside, distM: dist, areaM2 };
  }

  // Break any building feature into individual polygons (a MultiPolygon at low
  // zoom bundles many separate blocks into one feature, so scoring the whole
  // feature would light up the entire merged cluster).
  function polyParts(geom: GeoJSON.Geometry): [number, number][][][] {
    if (geom.type === "Polygon") return [geom.coordinates as [number, number][][]];
    if (geom.type === "MultiPolygon") return geom.coordinates as [number, number][][][];
    return [];
  }

  function tryDestHl(): boolean {
    if (hlDone || !route) return hlDone;
    const dest = route.coords[route.coords.length - 1];
    const sx = 111320 * Math.cos((dest[1] * Math.PI) / 180); // deg lon -> metres
    const sy = 111320; // deg lat -> metres
    // querySourceFeatures (not queryRenderedFeatures): the nav camera often
    // runs above the tile maxzoom (overscaled), where rendered-feature
    // queries come back empty even though the footprints are on screen.
    let feats: ReturnType<MLMap["querySourceFeatures"]> = [];
    try {
      feats = map.querySourceFeatures("openmaptiles", { sourceLayer: "building" });
    } catch {
      return false; // source not in this style — no buildings to highlight
    }
    // Score every INDIVIDUAL polygon part across all features. Low-zoom tiles
    // merge neighbouring buildings into one giant MultiPolygon, so we must
    // filter at the part level, then keep only the specific footprint(s) the
    // destination sits on — never the surrounding merged cluster.
    type Part = {
      rings: [number, number][][];
      height: number | null;
      inside: boolean;
      distM: number;
      areaM2: number;
    };
    const parts: Part[] = [];
    for (const f of feats) {
      const h = f.properties?.render_height ?? null;
      for (const rings of polyParts(f.geometry)) {
        const s = polyScore(rings, dest[0], dest[1], sx, sy);
        if (s.distM <= 120) parts.push({ rings, height: h, ...s });
      }
    }
    if (!parts.length) return false;
    // Containing footprints win; among them the SMALLEST is the most specific
    // building (a merged low-zoom super-polygon also happens to enclose the
    // point, but it dwarfs the real footprint). One polygon only: tile-clipped
    // duplicates of the same building would z-fight if layered. Arrival at a
    // plaza/road falls back to the single nearest building within 40 m.
    const containing = parts.filter((p) => p.inside).sort((a, b) => a.areaM2 - b.areaM2);
    let chosen: Part[];
    if (containing.length) {
      chosen = [containing[0]];
    } else {
      const nearest = parts.sort((a, b) => a.distM - b.distM)[0];
      chosen = nearest.distM <= 40 ? [nearest] : [];
    }
    if (!chosen.length) return false;
    // Ripple launch geometry: rings start at the footprint's corner radius and
    // travel outward across the ground — the building "broadcasts" its arrival
    // spot instead of sitting on a static pad.
    const outer = chosen[0].rings[0];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    pulseCx = (minX + maxX) / 2;
    pulseCy = (minY + maxY) / 2;
    const hw = ((maxX - minX) / 2) * sx;
    const hh = ((maxY - minY) / 2) * sy;
    pulseR0 = Math.min(45, Math.max(10, Math.hypot(hw, hh) + 2));
    pulseRMax = pulseR0 + 30;
    const data = {
      type: "FeatureCollection" as const,
      features: chosen.map((p) => ({
        type: "Feature" as const,
        properties: { render_height: p.height },
        geometry: { type: "Polygon" as const, coordinates: p.rings },
      })),
    };
    const existing = map.getSource("dest_hl") as GeoJSONSource | undefined;
    if (existing) existing.setData(data);
    else map.addSource("dest_hl", { type: "geojson", data });
    hlData = data; // kept so a style reload can re-seed the highlight
    ensureHlLayers();
    // At overview zoom only coarse tiles are loaded and the match carries a
    // placeholder height (flat slab). Show the gold footprint immediately as
    // feedback, but report "not done" so the zoom-probe still runs and the
    // real building extrusion replaces it once z13+ tiles load.
    const flat = chosen[0].height == null || chosen[0].height <= 6;
    if (flat && map.getZoom() < 13.5) return false;
    hlDone = true;
    return true;
  }

  function ensureHlLayers(): void {
    if (map.getLayer("dest_hl_ext") || !map.getSource("dest_hl")) return;
    map.addLayer({
      id: "dest_hl_ext",
      type: "fill-extrusion",
      source: "dest_hl",
      paint: {
        // buildings never extrude below 12 m, so a 5 m hut still reads as a
        // lit block at street zoom
        "fill-extrusion-color": `rgba(${GOLD_RGB}, 0.34)`,
        "fill-extrusion-height": ["max", ["coalesce", ["get", "render_height"], 9], 12],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.95,
      },
    });
    map.addLayer({
      id: "dest_hl_outline",
      type: "line",
      source: "dest_hl",
      paint: { "line-color": `rgba(${GOLD_RGB}, 0.95)`, "line-width": 1.5 },
    });
    if (!map.getSource("dest_pulse")) {
      map.addSource("dest_pulse", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    map.addLayer({
      id: "dest_pulse_ring",
      type: "line",
      source: "dest_pulse",
      paint: {
        "line-color": `rgba(${GOLD_RGB}, 1)`,
        "line-width": 2,
        "line-opacity": ["get", "fade"],
      },
    });
    startHlPulse();
  }

  // Two gold rings chase each other outward from the footprint — sonar on the
  // target, opacity fading as they travel. Same lazy 9 Hz driver as the block
  // pulse; at ~1 m/px street zoom, 110 ms steps move the ring ~1 px.
  function ripples(ms: number): GeoJSON.FeatureCollection {
    const CYCLE = 1600;
    const sx = 111320 * Math.cos((pulseCy * Math.PI) / 180);
    const ring = (phase: number): GeoJSON.Feature => {
      const t = (ms / CYCLE + phase) % 1;
      const r = pulseR0 + (pulseRMax - pulseR0) * t;
      const coords: [number, number][] = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        coords.push([pulseCx + (r * Math.cos(a)) / sx, pulseCy + (r * Math.sin(a)) / 111320]);
      }
      return {
        type: "Feature",
        properties: { fade: 0.75 * (1 - t) },
        geometry: { type: "LineString", coordinates: coords },
      };
    };
    return { type: "FeatureCollection", features: [ring(0), ring(0.5)] };
  }

  function startHlPulse(): void {
    if (hlPulseTimer !== undefined) return;
    const t0 = performance.now();
    hlPulseTimer = window.setInterval(() => {
      if (!map.getLayer("dest_hl_ext")) {
        stopHlPulse();
        return;
      }
      const now = performance.now() - t0;
      const k = 0.5 + 0.5 * Math.sin((now / 2200) * Math.PI * 2);
      map.setPaintProperty("dest_hl_ext", "fill-extrusion-opacity", 0.55 + 0.45 * k);
      map.setPaintProperty("dest_hl_outline", "line-opacity", 0.45 + 0.55 * k);
      const src = map.getSource("dest_pulse") as GeoJSONSource | undefined;
      if (src) src.setData(ripples(now));
    }, 110);
  }

  function stopHlPulse(): void {
    if (hlPulseTimer !== undefined) {
      window.clearInterval(hlPulseTimer);
      hlPulseTimer = undefined;
    }
  }

  function fallbackRing(): void {
    if (hlDone || destRingFallback) return;
    destRingFallback = true;
    if (pinEl) pinEl.classList.add("nogeo");
  }

  function scheduleDestHl(delay: number): void {
    hlTimers.push(
      window.setTimeout(() => {
        if (!tryDestHl()) hlTimers.push(window.setTimeout(probeOrRing, 2500));
      }, delay),
    );
  }

  // Overview zoom (often < 13) means building tiles aren't even loaded, so
  // the footprint query can't succeed. Land on the destination for a beat to
  // resolve the footprints and light them gold, then fly back — it reads as
  // the map locking onto the target. Mid-drive (follow) we never yank the
  // camera: the highlight waits for the approach or for the next OVERVIEW.
  function probeOrRing(): void {
    if (hlDone || destRingFallback || !route || following) return;
    const dest = route.coords[route.coords.length - 1];
    const pitch = curMode === "plan" ? PLAN_PITCH : IDLE_PITCH; // fly back the way we came
    map.jumpTo({ center: dest, zoom: 14.6, pitch });
    hlTimers.push(
      window.setTimeout(() => {
        if (!hlDone) fallbackRing();
        if (!following && route) fitRoute(curMode === "plan");
      }, 3000),
    );
  }

  // ------------------------------------------------------------- route layers
  let source: GeoJSONSource | null = null;
  // NOTE: map.isStyleLoaded() is a flaky gate — it flickers to false while the
  // style fetches glyphs/tilejson mid-camera-move. overlayReady flips true once
  // the route source+layers actually exist; initRouteOverlay re-runs on every
  // style load and re-paints from the route/alts closure, so setRoutes can
  // safely paint whenever overlayReady is true, ignoring transient fetch state.
  let overlayReady = false;

  const ROUTE_IDS = ["route_casing", "route_glow", "route_line", "route_dash"] as const;
  const ALT_IDS = ["route_alt_casing", "route_alt_line"] as const;
  const LABEL_ID = "route_labels";
  const TAPPABLE_IDS = ["route_labels", "route_alt_line", "route_line"] as const;

  function addRouteLayers(): void {
    // royal-blue core + glow over a dark casing; the white centerline dashes
    // only show for beeline fallbacks (real route hides route_dash, and vice versa).
    // Alternate routes share the source but carry alt=true: thin dashed steel
    // ghosts, painted first so the active blue always stacks over them.
    const paints: [string, LineLayerSpecification["paint"], boolean][] = [
      [
        "route_alt_casing",
        { "line-color": "rgba(0, 0, 0, 0.7)", "line-width": 5.5 },
        true,
      ],
      [
        "route_alt_line",
        { "line-color": "rgba(150, 163, 184, 0.62)", "line-width": 3, "line-dasharray": [2.4, 1.8] },
        true,
      ],
      ["route_casing", { "line-color": "rgba(0, 0, 0, 0.85)", "line-width": 8.5 }, false],
      [
        "route_glow",
        {
          "line-color": ROUTE_BLUE,
          "line-width": 11,
          // the wide blur is a street-level glow; at overview zoom it would
          // smear the thin route line into haze, so it tapers down with zoom
          "line-blur": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 13.5, 2, 16, 2],
        },
        false,
      ],
      ["route_line", { "line-color": ROUTE_RGB, "line-width": 5.5, "line-opacity": 0.95 }, false],
      [
        "route_dash",
        {
          "line-color": "rgba(240, 244, 250, 0.9)",
          "line-width": 2.4,
          "line-dasharray": [2, 2.2],
        },
        false,
      ],
    ];
    for (const [id, paint, isAlt] of paints) {
      if (map.getLayer(id)) map.removeLayer(id);
      const layer: LineLayerSpecification = {
        id,
        type: "line",
        source: "nav-route",
        layout: { "line-cap": "round", "line-join": "round" },
        filter: isAlt ? ["==", ["get", "alt"], true] : ["==", ["get", "alt"], false],
        paint,
      };
      map.addLayer(layer);
    }
    // plan-mode badges: minute deltas floating on each path (glyphs come from
    // the style's OpenFreeMap font stack); opacity is mode-gated in showRoute
    if (map.getLayer(LABEL_ID)) map.removeLayer(LABEL_ID);
    map.addLayer({
      id: LABEL_ID,
      type: "symbol",
      source: "nav-route",
      filter: ["has", "label"],
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        "text-offset": [0, -0.9],
        "text-allow-overlap": true, // the whole point is seeing every option at once
      },
      paint: {
        "text-color": ["case", ["==", ["get", "alt"], false], "#ffffff", "rgb(186, 197, 214)"],
        "text-halo-color": "rgba(0, 0, 0, 0.95)",
        "text-halo-width": 2.5,
        "text-opacity": 0,
      },
    });
  }

  function showRoute(): void {
    // real Valhalla routes draw royal blue; an offline beeline draws white
    // dashes instead; a cleared route leaves everything invisible (no data).
    // Alternates only ghost for real routes (a beeline has no alternates).
    const real = route !== null && !route.offline;
    for (const id of ROUTE_IDS) {
      if (!map.getLayer(id)) continue;
      const shown = real ? id !== "route_dash" : route !== null && id === "route_dash";
      map.setPaintProperty(id, "line-opacity", shown ? (id === "route_line" ? 0.95 : 1) : 0);
    }
    for (const id of ALT_IDS) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "line-opacity", real && alts.length > 0 ? 1 : 0);
    }
    // badges only belong to the flat plan view — no labels over a chase cam
    if (map.getLayer(LABEL_ID)) {
      map.setPaintProperty(LABEL_ID, "text-opacity", curMode === "plan" && real ? 1 : 0);
    }
  }

  // ---------------------------------------------------------------- traffic
  // TomTom flow tiles (key-gated by the page): transparent dark-tuned PNGs
  // composited under the route lines. MapLibre handles fetch/cache; we only
  // re-bucket the URL every 5 minutes so the live colors keep pace, and the
  // source's attribution string rides the © TomTom credit in/out with the layer.
  let trafficTiles: string[] | null = null;
  let trafficBucket = 0;
  let trafficTimer: number | undefined;

  const bucketedTiles = (): string[] => (trafficTiles ?? []).map((t) => `${t}&t=${trafficBucket}`);

  function applyTraffic(): void {
    if (!trafficTiles) return;
    const url = bucketedTiles();
    const src = map.getSource("traffic_flow") as { setTiles?: (t: string[]) => void } | undefined;
    if (src?.setTiles) src.setTiles(url);
    else if (!src) {
      map.addSource("traffic_flow", {
        type: "raster",
        tiles: url,
        tileSize: 512,
        maxzoom: 16,
        attribution: "© TomTom",
      });
    }
    if (!map.getLayer("traffic_flow")) {
      const layer: RasterLayerSpecification = {
        id: "traffic_flow",
        type: "raster",
        source: "traffic_flow",
        paint: { "raster-opacity": 0.92 },
      };
      // slip under the whole route overlay (alt ghosts first, then casing) so
      // congestion never hides the plan; during style (re)init the route
      // layers land after the traffic and stack above it naturally
      const below = map.getLayer("route_alt_casing")
        ? "route_alt_casing"
        : map.getLayer("route_casing")
          ? "route_casing"
          : undefined;
      map.addLayer(layer, below);
    }
  }

  function setTrafficInternal(tiles: string[] | null): void {
    trafficTiles = tiles && tiles.length ? tiles : null;
    if (trafficTimer !== undefined) {
      window.clearInterval(trafficTimer);
      trafficTimer = undefined;
    }
    if (map.getLayer("traffic_flow")) map.removeLayer("traffic_flow");
    if (map.getSource("traffic_flow")) map.removeSource("traffic_flow");
    if (!trafficTiles) return;
    trafficBucket = Math.floor(Date.now() / 300_000);
    if (overlayReady) applyTraffic();
    trafficTimer = window.setInterval(() => {
      const b = Math.floor(Date.now() / 300_000);
      if (b !== trafficBucket) {
        trafficBucket = b;
        applyTraffic(); // fresh bucket = fresh traffic state for the visible tiles
      }
    }, 30_000);
  }

  // fit the whole decision with a comfortable margin. Plan mode frames every
  // candidate (active + ghosts) flat and north-up; overview keeps some tilt and
  // only cares about the active route
  function fitRoute(plan: boolean): void {
    if (!route || route.coords.length < 2) return;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    const sweep = (coords: LngLat[]): void => {
      for (const [lon, lat] of coords) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    };
    sweep(route.coords);
    if (plan) for (const a of alts) sweep(a.coords);
    // guard the degenerate box: fitBounds clips its padding to half the
    // smaller viewport dimension, so a near-zero-span bbox (HOME -> HOME)
    // would crash with "padding exceeds viewport dimensions"
    const padX = (east - west) * 0.25 + 0.004;
    const padY = (north - south) * 0.25 + 0.004;
    const narrow = window.innerWidth <= 900; // card docks bottom-left down there too
    map.fitBounds([west - padX, south - padY, east + padX, north + padY], {
      // the frame dodges our own chrome: route card on the left, traffic rail
      // on the right, search bar up top, quick row + status line at the bottom
      padding: narrow
        ? { top: 70, bottom: 150, left: 340, right: 50 }
        : { top: 80, bottom: 110, left: 350, right: 130 },
      duration: 1400,
      maxZoom: plan ? 13.8 : 14.5,
      ...(plan ? { pitch: PLAN_PITCH, bearing: 0 } : {}),
    });
  }

  // ---------------------------------------------------------------- lifecycle
  // the style loads asynchronously — the route source/layers have to wait for
  // it (same contract the DASH track layers use); this also re-runs whenever
  // a style reload wipes the overlay
  const initRouteOverlay = (): void => {
    source = null;
    if (trafficTiles) applyTraffic(); // re-add first, so route layers stack above it
    if (!map.getSource("nav-route"))
      map.addSource("nav-route", { type: "geojson", data: routeData(route, alts, routeLabels), tolerance: 8 });
    addRouteLayers();
    if (hlDone && hlData && !map.getSource("dest_hl")) {
      map.addSource("dest_hl", { type: "geojson", data: hlData }); // style reload re-seed
    }
    ensureHlLayers();
    overlayReady = true;
    showRoute();
  };
  if (map.isStyleLoaded()) initRouteOverlay();
  else map.on("style.load", initRouteOverlay);

  // tiles under the destination load during/after the overview fly — re-try
  // the building query every time the map goes idle until a block resolves
  // (the final scheduled try zooms in, see scheduleDestHl)
  map.on("idle", () => {
    if (route && !hlDone && !destRingFallback) tryDestHl();
  });

  // plan-mode taps: pick a candidate by tapping its line or badge on the map
  // (hit tolerance comes from the source's `tolerance: 8`). Only armed while
  // a flat frame is up — a click during a chase-cam drive is a stray click.
  map.on("click", (ev) => {
    if (!tapCb || curMode === "follow" || !route) return;
    const layers = TAPPABLE_IDS.filter((id) => map.getLayer(id));
    if (!layers.length) return;
    for (const f of map.queryRenderedFeatures(ev.point, { layers })) {
      const idx = f.properties?.idx;
      if (typeof idx === "number") {
        tapCb(idx);
        return;
      }
    }
  });
  // raw click feed for the page (mode-agnostic; the ALT+click demo hook uses it)
  map.on("click", (ev) => {
    clickCb?.([ev.lngLat.lng, ev.lngLat.lat], ev.originalEvent as MouseEvent);
  });
  for (const id of TAPPABLE_IDS) {
    map.on("mouseenter", id, () => {
      if (curMode !== "follow") map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", id, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  // idle showcase sweep: with no live GPS, slowly yaw the pitched camera so
  // the wireframe blocks read as 3D instead of a flat frozen frame
  function armSweep(): void {
    if (sweepTimer) window.clearTimeout(sweepTimer);
    sweepTimer = window.setTimeout(() => {
      if (following && !route && !feed.read().live) {
        const start = map.getBearing();
        map.easeTo({ bearing: start + 18, duration: 5200, easing: (t) => t });
        sweepTimer = window.setTimeout(() => {
          map.easeTo({ bearing: start, duration: 5200, easing: (t) => t });
          armSweep();
        }, 5400);
      } else {
        armSweep();
      }
    }, 9000);
  }

  return {
    start() {
      view.start();
      armSweep();
      if (hlDone) startHlPulse(); // resume breathing after a page revisit
    },
    stop() {
      view.stop();
      stopHlPulse(); // no timers ticking for a hidden page
      if (sweepTimer) window.clearTimeout(sweepTimer);
    },
    destroy() {
      for (const t of hlTimers) window.clearTimeout(t);
      stopHlPulse();
      if (sweepTimer) window.clearTimeout(sweepTimer);
      if (trafficTimer !== undefined) window.clearInterval(trafficTimer);
      setPin(null);
      view.destroy();
    },
    setAccent(rgb: [number, number, number]): void {
      view.setAccent(rgb);
    },
    setRoutes(next: RouteResult[] | null, labels?: (string | null)[]): void {
      route = next && next.length ? next[0] : null;
      alts = next ? next.slice(1) : [];
      routeLabels = labels ?? [];
      clearDestHl();
      if (overlayReady) {
        // overlay exists (source+layers) — paint immediately; a route set
        // before the first style load is painted by initRouteOverlay instead
        if (!source) source = map.getSource("nav-route") as GeoJSONSource | null;
        if (!source) {
          map.addSource("nav-route", { type: "geojson", data: routeData(route, alts, routeLabels), tolerance: 8 });
          source = map.getSource("nav-route") as GeoJSONSource;
        } else {
          source.setData(routeData(route, alts, routeLabels));
        }
        if (!ROUTE_IDS.every((id) => map.getLayer(id))) addRouteLayers();
        showRoute();
      }
      if (!next || !route) {
        setPin(null);
        setModeInternal("follow"); // route cleared — back to the idle showcase rig
        return;
      }
      // the page owns plan/overview/follow transitions now (preview → GO →
      // drive); painting never yanks the camera — mid-drive ALT switches in
      // particular must not drop the chase cam out from under the driver
      setPin(route.coords[route.coords.length - 1]);
      scheduleDestHl(1500); // after the fit, tiles under the pin are loaded
    },
    setTraffic(tiles: string[] | null): void {
      setTrafficInternal(tiles);
    },
    setMode(mode: NavMode): void {
      setModeInternal(mode);
    },
    getMode() {
      return curMode;
    },
    onRouteTap(cb: (idx: number) => void): void {
      tapCb = cb;
    },
    onMapClick(cb: (pos: LngLat, ev: MouseEvent) => void): void {
      clickCb = cb;
    },
    setDemoPos(pos: LngLat | null, headingRad?: number): void {
      view.setOverridePos(pos ? [pos[0], pos[1]] : null, headingRad);
    },
    progress(pos: LngLat): number {
      if (!route) return 0;
      return routeProgress(route.coords, cumulativeMeters(route.coords), pos);
    },
    getMap(): MLMap {
      return map;
    },
  };

  // shared follow/overview/plan switch so setMode and the page agree on one path
  function setModeInternal(mode: NavMode): void {
    curMode = mode;
    if (mode === "follow") {
      following = true;
      view.setFollow(true, false);
      const pitch = route ? FOLLOW_PITCH : IDLE_PITCH;
      view.setCamera(pitch, FOLLOW_PARKED_ZOOM); // next fix flies heading-up again
      if (route) {
        // explicit fly into the chase POV: with live GPS the next fix re-eases
        // anyway, but a parked/stale fix (desktop preview, GPS OFFLINE) needs
        // the move commanded here or the camera would sit in the plan frame
        const s = feed.read();
        const pos: LngLat = s.lat != null && s.lng != null ? [s.lng, s.lat] : route.coords[0];
        map.easeTo({
          center: pos,
          bearing: s.live ? (s.heading * 180) / Math.PI : startBearingDeg(route),
          zoom: FOLLOW_PARKED_ZOOM,
          pitch,
          duration: 1700,
        });
      }
    } else if (mode === "plan") {
      following = false;
      view.setFollow(false, true); // lock: panning the plan must not snap back
      view.setCamera(PLAN_PITCH, FOLLOW_PARKED_ZOOM);
      fitRoute(true); // every candidate in frame at once
      scheduleDestHl(2600); // re-arm in case the highlight missed while driving
    } else {
      following = false;
      view.setFollow(false, true); // lock: panning an overview must not snap back mid-route
      view.setCamera(OVERVIEW_PITCH, FOLLOW_PARKED_ZOOM);
      fitRoute(false);
      scheduleDestHl(2600); // re-arm in case the highlight missed while driving
    }
    showRoute(); // plan-mode badge opacity rides the mode
  }

  // heading of the route's first real segment, for framing a parked chase cam
  function startBearingDeg(r: RouteResult): number {
    for (let i = 1; i < r.coords.length; i++) {
      const dx = (r.coords[i][0] - r.coords[i - 1][0]) * Math.cos((r.coords[i][1] * Math.PI) / 180);
      const dy = r.coords[i][1] - r.coords[i - 1][1];
      if (dx || dy) return (Math.atan2(dx, dy) * 180) / Math.PI;
    }
    return map.getBearing();
  }
}
