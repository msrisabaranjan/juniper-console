import { Marker, Map as MLMap, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource, LineLayerSpecification } from "maplibre-gl";
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { SensorFeed } from "./sensors";

/**
 * DASH map panel — a real map (MapLibre GL + OpenFreeMap vector tiles, no
 * API key) driven by real GPS fixes only.
 *
 * Heading-up camera like the car's native nav: on each fix the map eases to
 * (position, heading, speed-based zoom) while the car arrow stays upright.
 * Where the car has driven paints behind it as a royal-blue polyline — parked
 * jitter and stale/teleport gaps never draw, they just start a new segment.
 * Dragging pauses following; it eases back after a beat. Before the first
 * fix the map parks on a default location with the readouts showing NO
 * SIGNAL. Style: public/mapstyle.json (dark HUD restyle); road colors follow
 * the UI accent via setAccent().
 *
 * maplibre v6 derives its worker URL from the main bundle's URL, which Vite's
 * dep pre-bundling breaks (404 -> tiles never load). Pin the worker to the
 * real self-contained file; ?url keeps it working in dev and in builds.
 */
setWorkerUrl(maplibreWorker);

const DEFAULT_POS: [number, number] = [-122.0742, 37.4029]; // Tesla Factory, until a real fix lands
const PARKED_ZOOM = 15.6; // OpenFreeMap tops out at z14; keep over-zoom mild
const HIGHWAY_ZOOM = 13.4;
const HIGHWAY_SPEED = 36; // m/s (~80 mph) where zoom bottoms out
const FOLLOW_EASE_MS = 1100; // matches ~1 Hz GPS fixes for continuous glide
const DRAG_RESUME_MS = 2200;

const ROAD_LAYERS = ["road_path", "road_minor", "road_major", "road_motorway"] as const;
const ROAD_ALPHA: Record<(typeof ROAD_LAYERS)[number], number> = {
  road_path: 0.25,
  road_minor: 0.45,
  road_major: 0.85,
  road_motorway: 1,
};

// driven-path (track) policy: draw where the car actually went, not GPS noise
const TRACK_RGB = [65, 105, 225] as const; // royal blue — the path keeps its own
// color across accent themes so it always reads apart from the red roads
const TRACK_MIN_SPEED = 0.5; // m/s below this the car is parked — skip the fix
const TRACK_MIN_DIST_M = 3; // min spacing between drawn points, kills jitter
const TRACK_MAX_GAP_MS = 30_000; // stale fixes this long start a new segment
const TRACK_MAX_JUMP_M = 150; // one implausible hop also starts a new segment
const TRACK_MAX_POINTS = 1500; // memory cap; oldest points get trimmed

export interface MapView {
  start(): void;
  stop(): void;
  destroy(): void;
  setAccent(rgb: [number, number, number]): void;
  /** Forget the drawn path (also useful from the __dashmap debug hook). */
  clearTrack(): void;
  /** Debug/console access to the underlying MapLibre map. */
  getMap(): MLMap;
}

function speedZoom(ms: number): number {
  const t = Math.min(1, ms / HIGHWAY_SPEED);
  return PARKED_ZOOM - (PARKED_ZOOM - HIGHWAY_ZOOM) * t;
}

/** Current UI accent as an [r, g, b] triple, read from the --accent token. */
function readAccent(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  const parts = raw.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite)
    ? (parts as [number, number, number])
    : [255, 45, 45];
}

export function createMapView(container: HTMLElement, feed: SensorFeed): MapView {
  let accent = readAccent();

  const map = new MLMap({
    container,
    style: "mapstyle.json",
    center: DEFAULT_POS,
    zoom: PARKED_ZOOM,
    pixelRatio: Math.min(1.5, window.devicePixelRatio || 1), // in-car SoC guard
    renderWorldCopies: false,
    dragRotate: false, // rotation is ours alone (heading-up follow)
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();

  map.on("style.load", () => {
    applyAccent();
    addTrackLayers();
  });

  function applyAccent(): void {
    const [r, g, b] = accent;
    for (const id of ROAD_LAYERS) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "line-color", `rgba(${r}, ${g}, ${b}, ${ROAD_ALPHA[id]})`);
    }
  }

  // ---- car marker: upright arrow + parked pulse ring ----
  const markerEl = document.createElement("div");
  markerEl.className = "map-marker";
  markerEl.innerHTML = `<svg viewBox="-20 -20 40 40" aria-hidden="true">
    <circle class="parkring" r="16" fill="none" stroke-width="2"></circle>
    <path class="carmark" d="M0 -13 L9 11 L0 6.5 L-9 11 Z"></path>
  </svg>`;
  const marker = new Marker({ element: markerEl, rotationAlignment: "viewport", pitchAlignment: "map" })
    .setLngLat(DEFAULT_POS)
    .addTo(map);

  // ---- driven path: GPS history as a royal-blue polyline under the car ----
  let trackSegments: [number, number][][] = [];
  let trackCount = 0;
  let lastTrackAt = 0;

  const trackData = () => ({
    type: "Feature" as const,
    properties: null,
    geometry: { type: "MultiLineString" as const, coordinates: trackSegments },
  });

  function distM(a: [number, number], b: [number, number]): number {
    const dy = (a[1] - b[1]) * 111_320;
    const dx = (a[0] - b[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    return Math.hypot(dx, dy);
  }

  function pushTrack(): void {
    (map.getSource("track") as GeoJSONSource | undefined)?.setData(trackData());
  }

  function addTrackLayers(): void {
    if (!map.getSource("track")) {
      map.addSource("track", { type: "geojson", data: trackData() });
    }
    if (map.getLayer("track_line")) return; // style reloaded under us, layers re-add
    const [r, g, b] = TRACK_RGB;
    const glow: LineLayerSpecification = {
      id: "track_glow",
      type: "line",
      source: "track",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": `rgba(${r}, ${g}, ${b}, 0.16)`,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 7, 16, 15],
        "line-blur": 3,
      },
    };
    const line: LineLayerSpecification = {
      id: "track_line",
      type: "line",
      source: "track",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": `rgba(${r}, ${g}, ${b}, 0.85)`,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.5, 16, 4],
      },
    };
    map.addLayer(glow);
    map.addLayer(line);
  }

  function appendTrack(pos: [number, number], speedMs: number): void {
    if (speedMs < TRACK_MIN_SPEED) return; // parked: filtered jitter isn't a path
    const now = performance.now();
    const seg = trackSegments[trackSegments.length - 1];
    const stale = !seg || now - lastTrackAt > TRACK_MAX_GAP_MS || distM(seg[seg.length - 1], pos) > TRACK_MAX_JUMP_M;
    let added = false;
    if (stale) {
      trackSegments.push([pos]); // first fix or a signal gap: start a new segment
      added = true;
    } else if (distM(seg[seg.length - 1], pos) >= TRACK_MIN_DIST_M) {
      seg.push(pos);
      added = true;
    }
    lastTrackAt = now;
    if (!added) return;
    trackCount++;
    while (trackCount > TRACK_MAX_POINTS) {
      const head = trackSegments[0];
      head.shift();
      trackCount--;
      if (head.length === 0) trackSegments.shift();
    }
    pushTrack();
  }

  // ---- follow / drag state ----
  let following = true;
  let lastDragEnd = 0;
  map.on("dragstart", () => {
    following = false;
  });
  map.on("dragend", () => {
    lastDragEnd = performance.now();
  });

  let raf: number | undefined;
  let seenFixAt = 0;

  function frame(): void {
    const s = feed.read();
    markerEl.classList.toggle("parked", s.live && s.speed < 0.5);

    if (s.lat != null && s.lng != null) {
      const pos: [number, number] = [s.lng, s.lat];
      marker.setLngLat(pos);
      // one easeTo per fresh fix; chained ~1s eases read as continuous glide
      if (s.live && s.fixAt !== seenFixAt) {
        seenFixAt = s.fixAt;
        appendTrack(pos, s.speed);
        if (following) {
          map.easeTo({
            center: pos,
            bearing: (s.heading * 180) / Math.PI, // heading-up: travel direction points up
            zoom: speedZoom(s.speed),
            duration: FOLLOW_EASE_MS,
          });
        }
      }
    }

    if (!following && performance.now() - lastDragEnd > DRAG_RESUME_MS) following = true;

    raf = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (raf === undefined) {
        map.resize(); // panel was display:none until DASH opened
        raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      if (raf !== undefined) {
        cancelAnimationFrame(raf);
        raf = undefined;
      }
    },
    destroy() {
      this.stop();
      map.remove();
    },
    setAccent(rgb) {
      accent = rgb;
      applyAccent();
    },
    clearTrack() {
      trackSegments = [];
      trackCount = 0;
      lastTrackAt = 0;
      pushTrack();
    },
    getMap() {
      return map;
    },
  };
}
