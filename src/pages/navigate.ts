import { subscribe } from "../state";
import { cancelFx, glitchIn, hideForType, schedule, stopTyping, typeIn } from "../ui/fx";
import { createNavMap } from "../ui/navMap";
import { createSensorFeed, type SensorSnapshot } from "../ui/sensors";
import {
  beeline,
  fetchRoute,
  searchPlaces,
  type LngLat,
  type Place,
  type RouteResult,
  type StepGlyph,
} from "../ui/routing";

/**
 * NAVIGATE — the Roadster-style 3D nav page (reveal video 0:48 / 1:24):
 * full-bleed wireframe map in tilted heading-up flight, ⌕ Navigate / ⌂ Home /
 * ▣ Work quick actions inside the map, and a route card with the next
 * maneuver, distance, minutes and arrival time.
 *
 * Departure is always the car's real position (live GPS fix, or the parked
 * default like every other map before the first fix); destination comes from
 * a place search (Nominatim) or a preset. The route itself comes from
 * Valhalla — when that's unreachable the page still flies on a dashed
 * beeline and the HUD says ROUTE OFFLINE. No fake telemetry: offline means
 * dashes.
 */

const MPH = 2.23694; // m/s -> mph, for the status ticker
const ETA_TICK_MS = 500; // route card refresh rate

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// presets — the console's parked world, same origin the DASH map defaults to
const PRESETS: Record<string, Place> = {
  HOME: { name: "HOME", detail: "Tesla Factory · Fremont", lat: 37.4029, lon: -122.0742 },
  WORK: { name: "WORK", detail: "Tesla Engineering HQ · Palo Alto", lat: 37.4419, lon: -122.143 },
};
const DEFAULT_FROM: LngLat = [-122.0742, 37.4029]; // until a real fix lands

// turn-card glyphs: same arrow kite for every angle, specials for the rest
const GLYPH_ANGLE: Partial<Record<StepGlyph, number>> = {
  straight: 0,
  "slight-right": 22,
  right: 90,
  "sharp-right": 135,
  uturn: 180,
  "sharp-left": -135,
  left: -90,
  "slight-left": -22,
};

function glyphSvg(glyph: StepGlyph): string {
  const head = `<svg viewBox="-12 -12 24 24" aria-hidden="true">`;
  const angle = GLYPH_ANGLE[glyph];
  if (angle !== undefined) {
    return `${head}<path d="M0 -9 L6.5 7.5 L0 3.5 L-6.5 7.5 Z" fill="currentColor" transform="rotate(${angle})"/></svg>`;
  }
  switch (glyph) {
    case "arrive":
      return `${head}<path d="M0 -9 L9 0 L0 9 L-9 0 Z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
    case "depart":
      return `${head}<circle r="3.5" fill="currentColor"/><circle r="9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
    case "roundabout":
      return `${head}<circle r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="26 8"/><path d="M3.2 -7 L8.5 -4.5 L5.5 -0.8 Z" fill="currentColor"/></svg>`;
    case "merge":
      return `${head}<path d="M-3 -9 L3.5 7.5 L-3 3.5 L-9.5 7.5 Z" fill="currentColor" transform="rotate(30)"/><path d="M7 -9 V1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
    default:
      return `${head}<path d="M0 -9 L6.5 7.5 L0 3.5 L-6.5 7.5 Z" fill="currentColor"/></svg>`;
  }
}

function fmtArrival(date: Date): string {
  const h24 = date.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m} ${h24 < 12 ? "AM" : "PM"}`;
}

export interface NavigatePage {
  playIntro(): void;
  /** Status-center ticker text for the navigate page. */
  ticker(): string;
}

export function initNavigatePage(onStatus: () => void): NavigatePage {
  const el = {
    input: $<HTMLInputElement>("nav-q"),
    go: $("nav-go"),
    results: $("nav-results"),
    searchBtn: $("nav-search-btn"),
    home: $("nav-home"),
    work: $("nav-work"),
    card: $("nav-card"),
    glyph: $("nav-step-glyph"),
    stepText: $("nav-step-text"),
    dest: $("nav-dest"),
    dist: $("nav-dist"),
    time: $("nav-time"),
    arrive: $("nav-arrive"),
    overview: $("nav-overview"),
    clear: $("nav-clear"),
    status: $("nav-status"),
  };

  const feed = createSensorFeed();
  const nav = createNavMap($("nav-map-wrap"), feed);
  (window as unknown as Record<string, unknown>).__navmap = nav;

  let lastFix: LngLat | null = null;
  let dest: Place | null = null;
  let route: RouteResult | null = null;
  let progress = 0;
  let routing = false; // fetch in flight — keeps double-taps from racing
  let searching = false;

  let statusHold = 0;

  // long geocoded names get truncated for the HUD slots
  function shortName(name: string): string {
    return name.length > 24 ? `${name.slice(0, 23)}…` : name;
  }

  function setStatus(text: string, holdMs = 0): void {
    // the status line is an intro typeIn target — kill any still-typing chain
    // and keep the fx cache honest, so a stale typewriter can't overwrite us
    stopTyping(el.status);
    el.status.dataset.fxText = text;
    el.status.textContent = text;
    statusHold = performance.now() + holdMs; // hold one-shot messages over the GPS loop
  }

  // ---- route lifecycle --------------------------------------------------

  async function routeTo(place: Place): Promise<void> {
    if (routing) return;
    routing = true;
    dest = place;
    el.results.hidden = true;
    setStatus(`ROUTING · ${place.name}`, 3000);
    const from = lastFix ?? DEFAULT_FROM;
    const startDistM = Math.hypot(
      (place.lon - from[0]) * 111_320 * Math.cos((((place.lat + from[1]) / 2) * Math.PI) / 180),
      (place.lat - from[1]) * 111_320
    );
    if (startDistM < 80) {
      routing = false; // we're standing on it — no route to draw
      setStatus(`ALREADY AT ${place.name}`, 5000);
      return;
    }
    let next: RouteResult;
    try {
      next = await fetchRoute(from, [place.lon, place.lat]);
    } catch (e) {
      console.warn("[nav] route fetch failed:", e);
      next = beeline(from, [place.lon, place.lat]); // keep flying, say so
    }
    routing = false;
    route = next;
    progress = next.coords.length > 1 ? 0 : 1;
    nav.setRoute(next);
    showCard();
    setStatus(
      next.offline
        ? `ROUTE OFFLINE · BEELINE TO ${shortName(place.name)}`
        : `EN ROUTE · ${shortName(place.name)}`
    );
    onStatus();
  }

  function clearRoute(): void {
    dest = null;
    route = null;
    progress = 0;
    nav.setRoute(null);
    el.card.hidden = true;
    el.overview.textContent = "OVERVIEW";
    setStatus(gpsStatusText(feed.read()));
  }

  // the card shows the NEXT maneuver for how far we have actually driven
  let shownStepIdx = -1;

  function currentStepIdx(): number {
    if (!route || route.steps.length === 0) return -1;
    const traveled = route.lengthMi * progress;
    let acc = 0;
    for (let i = 0; i < route.steps.length; i++) {
      if (acc >= traveled - 0.01) return i;
      acc += route.steps[i].lengthMi;
    }
    return route.steps.length - 1;
  }

  function updateStepCard(force = false): void {
    if (!route || el.card.hidden) return;
    const idx = currentStepIdx();
    if (!force && idx === shownStepIdx) return;
    shownStepIdx = idx;
    const step = idx >= 0 ? route.steps[idx] : undefined;
    el.glyph.innerHTML = step ? glyphSvg(step.glyph) : glyphSvg(route.offline ? "straight" : "arrive");
    el.stepText.textContent = step
      ? `${step.label} — ${step.lengthMi.toFixed(1)} MI`
      : route.offline
        ? "DIRECT BEARING — NO ROAD DATA"
        : "ARRIVE AT DESTINATION";
  }

  function showCard(): void {
    if (!route) return;
    el.card.hidden = false;
    shownStepIdx = -1;
    updateStepCard(true);
    el.dest.textContent = dest ? shortName(dest.name) : "DESTINATION";
  }

  // ---- search ------------------------------------------------------------

  function hideResults(): void {
    el.results.hidden = true;
  }

  async function runSearch(): Promise<void> {
    const q = el.input.value.trim();
    if (!q || searching) return;
    searching = true;
    setStatus("SEARCHING…");
    try {
      // bias results to what is around "you": the live GPS fix if we have
      // one, otherwise wherever the nav map is currently looking
      const center = nav.getMap().getCenter();
      const places = await searchPlaces(q, lastFix ?? [center.lng, center.lat]);
      el.results.innerHTML = "";
      if (places.length === 0) {
        setStatus(`NO RESULTS · ${q.toUpperCase()}`, 4000);
        hideResults();
      } else {
        for (const p of places) {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = p.name;
          const s = document.createElement("span");
          s.textContent = p.detail;
          li.append(b, s);
          li.addEventListener("click", () => void routeTo(p));
          el.results.appendChild(li);
        }
        el.results.hidden = false;
        setStatus(`${places.length} RESULT${places.length === 1 ? "" : "S"} · PICK ONE`, 5000);
      }
    } catch {
      setStatus("SEARCH OFFLINE · TRY HOME/WORK");
      hideResults();
    }
    searching = false;
  }

  // ---- live loop ---------------------------------------------------------

  let raf = 0;
  let lastEta = 0;
  let statusTimer: number | undefined;

  function renderEta(): void {
    if (!route || el.card.hidden) return;
    if (lastFix) progress = Math.max(progress, nav.progress(lastFix));
    const left = Math.max(0, route.lengthMi * (1 - progress));
    const timeLeft = Math.max(0, route.timeSec * (1 - progress));
    updateStepCard();
    el.dist.textContent = `${left.toFixed(1)} MI`;
    el.time.textContent = `${Math.ceil(timeLeft / 60)} MIN`;
    el.arrive.textContent = fmtArrival(new Date(Date.now() + timeLeft * 1000));
  }

  function frame(): void {
    const s = feed.read();
    if (s.live && s.lat != null && s.lng != null) lastFix = [s.lng, s.lat];
    const now = performance.now();
    if (now - lastEta > ETA_TICK_MS) {
      lastEta = now;
      renderEta();
      if (!route && performance.now() > statusHold) setStatus(gpsStatusText(s));
    }
    raf = requestAnimationFrame(frame);
  }

  function gpsStatusText(s: SensorSnapshot): string {
    if (!s.live) return "GPS OFFLINE · MAP PARKED AT TESLA FACTORY";
    return `HOLDING ${Math.round(s.speed * MPH)} MPH · HEADING ${Math.round(((s.heading * 180) / Math.PI + 360) % 360)}°`;
  }

  function startAll(): void {
    if (raf) return;
    feed.start();
    nav.start();
    setStatus(route && dest ? `EN ROUTE · ${shortName(dest.name)}` : gpsStatusText(feed.read()));
    // status ticker at 0.25 Hz while the page is up
    statusTimer = window.setInterval(onStatus, 4000);
    raf = requestAnimationFrame(frame);
  }

  function stopAll(): void {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (statusTimer !== undefined) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    feed.stop();
    nav.stop();
  }

  subscribe((s, prev) => {
    if (s.page === "navigate" && prev.page !== "navigate") startAll();
    else if (s.page !== "navigate" && prev.page === "navigate") stopAll();
  });

  // map colors follow the accent theme (Crimson <-> Chalk)
  subscribe((s, prev) => {
    if (s.accent !== prev.accent) {
      nav.setAccent(s.accent === "red" ? [255, 45, 45] : [242, 242, 242]);
    }
  });

  // ---- wiring ------------------------------------------------------------

  el.searchBtn.addEventListener("click", () => {
    el.input.focus();
    setStatus("AWAITING QUERY");
  });
  el.home.addEventListener("click", () => void routeTo(PRESETS.HOME));
  el.work.addEventListener("click", () => void routeTo(PRESETS.WORK));
  el.go.addEventListener("click", () => void runSearch());
  el.input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void runSearch();
    if (ev.key === "Escape") hideResults();
  });
  el.overview.addEventListener("click", () => {
    if (nav.getMode() === "overview") {
      nav.setMode("follow");
      el.overview.textContent = "OVERVIEW";
      setStatus(dest ? `EN ROUTE · ${shortName(dest.name)}` : "NO DESTINATION");
    } else {
      nav.setMode("overview");
      el.overview.textContent = "RESUME";
      setStatus("ROUTE OVERVIEW · DRAG TO PAN");
    }
  });
  el.clear.addEventListener("click", clearRoute);
  document.addEventListener("click", (ev) => {
    if (!el.results.hidden && !el.results.contains(ev.target as Node) && ev.target !== el.input) {
      hideResults();
    }
  });

  // ---- glitch -> type-in entrance, same language as the other menus ------
  // (glitch hits the whole button, typing hits the label so icon SVGs stay)

  const quickEls = [el.searchBtn, el.home, el.work];
  const quickLabels = quickEls
    .map((b) => b.querySelector("b"))
    .filter((b): b is HTMLElement => b !== null);
  const introTargets: HTMLElement[] = [...quickLabels, el.status];

  function playIntro(): void {
    cancelFx();
    introTargets.forEach(hideForType);
    let t = 0;
    for (const node of introTargets) {
      schedule(t, () => glitchIn(node));
      schedule(t + 150, () => typeIn(node));
      t += 70;
    }
  }

  return {
    playIntro,
    ticker() {
      if (routing) return "ROUTING…";
      if (route && dest) {
        const left = Math.max(0, route.lengthMi * (1 - progress));
        const min = Math.max(0, Math.ceil((route.timeSec * (1 - progress)) / 60));
        return `EN ROUTE ${shortName(dest.name)} · ${left.toFixed(1)} MI · ${min} MIN${route.offline ? " · ROUTE OFFLINE" : ""}`;
      }
      return "NAVIGATE · SET A DESTINATION TO ROUTE";
    },
  };
}
