import { Marker } from "maplibre-gl";
import type { GeoJSONSource, LineLayerSpecification, Map as MLMap } from "maplibre-gl";
import { createMapView } from "./mapView";
import type { SensorFeed } from "./sensors";
import { cumulativeMeters, routeProgress, type LngLat, type RouteResult } from "./routing";

/**
 * NAVIGATE map — the Roadster-style wireframe 3D nav (the 0:48/1:24 beat of
 * the reveal video): black void, line-art streets, extruded ghost blocks,
 * pitched heading-up camera flying the same follow rig as the DASH map.
 *
 * On top of that shared rig this adds the routing overlay: a royal-blue route
 * polyline (dark casing + glow + core, always blue — the Tesla screen never
 * re-tints the route), a gold diamond destination pin, the destination block
 * itself extruded in gold while you drive to it, and two camera modes —
 * FOLLOW (tilted, heading-up, car-centered) and OVERVIEW (fit the whole route,
 * gentle tilt). Progress along the route is computed per GPS fix so the ETA
 * card counts down honestly.
 */

const FOLLOW_PITCH = 55; // street-level 3D tilt, like the video
const IDLE_PITCH = 45; // no destination yet — showcase the extrusions
const OVERVIEW_PITCH = 40; // overview keeps some pitch — wireframes read flat at 0
const FOLLOW_PARKED_ZOOM = 15.8;

// route line is royal blue in every theme — the planned route keeps its own
// color apart from the red roads (matches the DASH driven-path blue)
const ROUTE_RGB = "rgb(65, 105, 225)";
const ROUTE_BLUE = "rgba(65, 105, 225, 0.28)";
// destination highlight — same amber the DASH telemetry bars use (--car-drivetrain)
const GOLD_RGB = "255, 179, 71";

export interface NavMap {
  start(): void;
  stop(): void;
  destroy(): void;
  setAccent(rgb: [number, number, number]): void;
  /** Paint (or clear with null) the routed path + destination pin. */
  setRoute(route: RouteResult | null): void;
  setMode(mode: "follow" | "overview"): void;
  getMode(): "follow" | "overview";
  /** Fraction [0..1] of the current route the car has completed. */
  progress(pos: LngLat): number;
  getMap(): MLMap;
}

const routeData = (route: RouteResult | null) => ({
  type: "Feature" as const,
  properties: null,
  geometry: {
    type: "LineString" as const,
    coordinates: route ? route.coords.map((c) => [c[0], c[1]]) : [],
  },
});

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
  let following = true; // our own mirror of the follow/overview mode
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
    map.jumpTo({ center: dest, zoom: 14.6, pitch: IDLE_PITCH });
    hlTimers.push(
      window.setTimeout(() => {
        if (!hlDone) fallbackRing();
        if (!following && route) fitRoute();
      }, 3000),
    );
  }

  // ------------------------------------------------------------- route layers
  let source: GeoJSONSource | null = null;

  const ROUTE_IDS = ["route_casing", "route_glow", "route_line", "route_dash"] as const;

  function addRouteLayers(): void {
    // royal-blue core + glow over a dark casing; the white centerline dashes
    // only show for beeline fallbacks (real route hides route_dash, and vice versa)
    const paints: [string, LineLayerSpecification["paint"]][] = [
      ["route_casing", { "line-color": "rgba(0, 0, 0, 0.85)", "line-width": 8.5 }],
      [
        "route_glow",
        {
          "line-color": ROUTE_BLUE,
          "line-width": 11,
          // the wide blur is a street-level glow; at overview zoom it would
          // smear the thin route line into haze, so it tapers down with zoom
          "line-blur": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 13.5, 2, 16, 2],
        },
      ],
      ["route_line", { "line-color": ROUTE_RGB, "line-width": 5.5, "line-opacity": 0.95 }],
      [
        "route_dash",
        {
          "line-color": "rgba(240, 244, 250, 0.9)",
          "line-width": 2.4,
          "line-dasharray": [2, 2.2],
        },
      ],
    ];
    for (const [id, paint] of paints) {
      if (map.getLayer(id)) map.removeLayer(id);
      const layer: LineLayerSpecification = {
        id,
        type: "line",
        source: "nav-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint,
      };
      map.addLayer(layer);
    }
  }

  function showRoute(): void {
    // real Valhalla routes draw royal blue; an offline beeline draws white
    // dashes instead; a cleared route leaves everything invisible (no data)
    const real = route !== null && !route.offline;
    for (const id of ROUTE_IDS) {
      if (!map.getLayer(id)) continue;
      const shown = real ? id !== "route_dash" : route !== null && id === "route_dash";
      map.setPaintProperty(id, "line-opacity", shown ? (id === "route_line" ? 0.95 : 1) : 0);
    }
  }

  // fit the whole route with a comfortable margin, keeping some tilt so the
  // wireframe blocks stay legible in overview
  function fitRoute(): void {
    if (!route || route.coords.length < 2) return;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const [lon, lat] of route.coords) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    // guard the degenerate box: fitBounds clips its padding to half the
    // smaller viewport dimension, so a near-zero-span bbox (HOME -> HOME)
    // would crash with "padding exceeds viewport dimensions"
    const padX = (east - west) * 0.25 + 0.004;
    const padY = (north - south) * 0.25 + 0.004;
    map.fitBounds([west - padX, south - padY, east + padX, north + padY], {
      padding: { top: 70, bottom: 70, left: 70, right: 70 },
      duration: 1400,
      maxZoom: 14.5,
    });
  }

  // ---------------------------------------------------------------- lifecycle
  // the style loads asynchronously — the route source/layers have to wait for
  // it (same contract the DASH track layers use); this also re-runs whenever
  // a style reload wipes the overlay
  const initRouteOverlay = (): void => {
    source = null;
    if (!map.getSource("nav-route")) map.addSource("nav-route", { type: "geojson", data: routeData(route) });
    addRouteLayers();
    if (hlDone && hlData && !map.getSource("dest_hl")) {
      map.addSource("dest_hl", { type: "geojson", data: hlData }); // style reload re-seed
    }
    ensureHlLayers();
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
      setPin(null);
      view.destroy();
    },
    setAccent(rgb: [number, number, number]): void {
      view.setAccent(rgb);
    },
    setRoute(next: RouteResult | null): void {
      route = next;
      clearDestHl();
      if (map.isStyleLoaded()) {
        // late enough for the source to exist; early (pre-load) routes are
        // painted by initRouteOverlay the moment the style lands
        if (!source) source = map.getSource("nav-route") as GeoJSONSource | null;
        if (!source) {
          map.addSource("nav-route", { type: "geojson", data: routeData(next) });
          source = map.getSource("nav-route") as GeoJSONSource;
        } else {
          source.setData(routeData(next));
        }
        if (!ROUTE_IDS.every((id) => map.getLayer(id))) addRouteLayers();
        showRoute();
      }
      if (!next) {
        setPin(null);
        setModeInternal("follow");
        return;
      }
      setPin(next.coords[next.coords.length - 1]);
      setModeInternal("overview"); // start in overview so the whole plan reads at a glance
      scheduleDestHl(1500); // after the fitBounds fly, tiles under the pin are loaded
    },
    setMode(mode: "follow" | "overview"): void {
      setModeInternal(mode);
    },
    getMode() {
      return following ? "follow" : "overview";
    },
    progress(pos: LngLat): number {
      if (!route) return 0;
      return routeProgress(route.coords, cumulativeMeters(route.coords), pos);
    },
    getMap(): MLMap {
      return map;
    },
  };

  // shared follow/overview switch so setRoute and setMode agree on one path
  function setModeInternal(mode: "follow" | "overview"): void {
    if (mode === "follow") {
      following = true;
      view.setFollow(true, false);
      view.setCamera(FOLLOW_PITCH, FOLLOW_PARKED_ZOOM); // next fix flies heading-up again
      if (!route) view.setCamera(IDLE_PITCH, FOLLOW_PARKED_ZOOM); // idle showcase tilt
    } else {
      following = false;
      view.setFollow(false, true); // lock: panning an overview must not snap back mid-route
      view.setCamera(OVERVIEW_PITCH, FOLLOW_PARKED_ZOOM);
      fitRoute();
      scheduleDestHl(2600); // re-arm in case the highlight missed while driving
    }
  }
}
