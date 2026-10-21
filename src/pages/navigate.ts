import { subscribe } from "../state";
import { cancelFx, glitchIn, hideForType, schedule, stopTyping, typeIn } from "../ui/fx";
import { createNavMap } from "../ui/navMap";
import { createSensorFeed, type SensorSnapshot } from "../ui/sensors";
import { createTraffic } from "../ui/traffic";
import {
  beeline,
  cumulativeMeters,
  fetchRoute,
  fetchRouteAlternates,
  offRouteMeters,
  pointAlong,
  searchPlaces,
  type LngLat,
  type Place,
  type RouteResult,
  type StepGlyph,
} from "../ui/routing";

/**
 * NAVIGATE — the Roadster-style 3D nav page (reveal video 0:48 / 1:24), run
 * as two phases:
 *
 * PREVIEW — picking a search result routes and drops the map into a flat 2D
 * plan frame holding every candidate at once: royal-blue active route,
 * steel-ghost alternates, minute badges on the map ("+6 MIN" deltas), chips
 * under the ETA, and a green GO button on the card. Tap a line/badge on the
 * map (or a chip) to switch the pick.
 *
 * DRIVE — GO peels the planning chrome away (search bar, quick row and GO
 * step out, alternate routes drop off the map): the big amber maneuver prompt
 * floats top-left, the bottom bar becomes a trip strip (green time-to-go +
 * arrival, progress bar, EXIT), and the camera flies into the close tilted
 * heading-up chase view over the arrow. Drive off the route for a few
 * consecutive fixes and it reroutes from where you actually are (ALT+click
 * off-route pins a labeled DEMO fix to see this on desktop). Motion rides
 * real GPS only: preview parked means the chase cam frames a stationary car.
 *
 * Departure is always the car's real position (live GPS fix, or the parked
 * default like every other map before the first fix); destination comes from
 * a place search (Nominatim). The route itself comes from Valhalla — when
 * that's unreachable the page still flies on a dashed beeline and the HUD
 * says ROUTE OFFLINE. No fake telemetry: offline means dashes.
 *
 * On top of that: alternate routes mined by corridor-probing Valhalla, and
 * optional live traffic via a paste-once free TomTom key (localStorage,
 * never git) behind an icon-only right-edge rail button: flow-tile congestion
 * on the map + traffic-priced ETAs per candidate. No key ⇒ everything still
 * routes, chips just say STATIC. Honesty first.
 */

const MPH = 2.23694; // m/s -> mph, for the status line
const ETA_TICK_MS = 500; // route card refresh rate

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

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
}

export function initNavigatePage(): NavigatePage {
  const el = {
    page: $("page-navigate"),
    input: $<HTMLInputElement>("nav-q"),
    go: $("nav-go"),
    results: $("nav-results"),
    searchBtn: $("nav-search-btn"),
    card: $("nav-card"),
    glyph: $("nav-step-glyph"),
    stepText: $("nav-step-text"),
    dest: $("nav-dest"),
    dist: $("nav-dist"),
    time: $("nav-time"),
    arrive: $("nav-arrive"),
    start: $("nav-start"),
    overview: $("nav-overview"),
    clear: $("nav-clear"),
    status: $("nav-status"),
    alts: $("nav-alts"),
    traffic: $("nav-traffic"),
    trafficState: $("nav-traffic-state"),
    keyPanel: $("nav-key"),
    keyInput: $<HTMLInputElement>("nav-tt-key"),
    keySave: $("nav-key-save"),
    keyClear: $("nav-key-clear"),
    maneuver: $("nav-maneuver"),
    maneuverGlyph: $("nav-maneuver-glyph"),
    maneuverText: $("nav-maneuver-text"),
    stripEta: $("strip-eta"),
    stripTime: $("strip-time"),
    stripArrive: $("strip-arrive"),
    stripNote: $("strip-note"),
    stripProgress: $("strip-progress"),
    stripActions: $("strip-actions"),
    stripFill: $("strip-fill"),
    stripPct: $("strip-pct"),
    stripOverview: $("strip-overview"),
    stripExit: $("strip-exit"),
  };

  const feed = createSensorFeed();
  const nav = createNavMap($("nav-map-wrap"), feed);
  (window as unknown as Record<string, unknown>).__navmap = nav;
  const traffic = createTraffic();

  let lastFix: LngLat | null = null;
  let dest: Place | null = null;
  let route: RouteResult | null = null;
  let routes: RouteResult[] = []; // [0] is the active route; the rest ghost as alternates
  let phase: "idle" | "preview" | "drive" = "idle"; // plan-the-route vs commit-to-it
  let trafficOn = false;
  let progress = 0;
  let routing = false; // fetch in flight — keeps double-taps from racing
  let searching = false;

  // wrong-turn reroute state: a fix counts when it sits OFF_ROUTE_M beyond the
  // active polyline; a few consecutive ones (not a GPS hiccup) trigger a
  // reroute from where we actually are. Demo fixes (ALT+click preview hook)
  // drive the same path but are always labeled DEMO in the status line.
  const OFF_ROUTE_M = 35;
  const REROUTE_COOLDOWN_MS = 15_000;
  let progressFloor = 0; // progress may only ratchet up from this — reroutes reset it
  let demoFix: LngLat | null = null;
  let seenFixAt = 0;
  let offFixes = 0;
  let rerouting = false;
  let lastRerouteAt = 0;

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
    routes = [next];
    progress = next.coords.length > 1 ? 0 : 1;
    progressFloor = progress;
    offFixes = 0;
    phase = "preview";
    el.page.classList.remove("drive");
    el.overview.textContent = "OVERVIEW";
    nav.setRoutes(routes, labelsFor());
    nav.setMode("plan"); // flat aerial decision frame: every candidate at once
    showCard();
    renderAlts();
    updateStrip();
    setStatus(
      next.offline
        ? `ROUTE OFFLINE · BEELINE TO ${shortName(place.name)}`
        : `PLAN READY · TAP A ROUTE OR PRESS GO`
    );
    // alternates mine themselves in the background — the main route already flies
    if (!next.offline) void enrichAlternates(from, [place.lon, place.lat], next);
  }

  // ---- alternates + live traffic ------------------------------------------
  // Valhalla's public endpoint ships one route, so alternates are corridor-
  // probed in routing.ts. ETAs stay honest static estimates until a TomTom
  // key is saved — then every candidate gets re-priced with live traffic
  // against its own geometry and the chips flip to LIVE. No key, no live.

  async function enrichAlternates(from: LngLat, to: LngLat, main: RouteResult): Promise<void> {
    try {
      const found = await fetchRouteAlternates(from, to, main);
      if (!found.length || routes[0] !== main) return; // destination changed mid-flight
      routes = [main, ...found];
      nav.setRoutes(routes, labelsFor());
      if (phase === "preview") nav.setMode("plan"); // re-frame so the new ghosts are in view
      renderAlts();
      setStatus(
        `${found.length} ALT ROUTE${found.length === 1 ? "" : "S"} · TAP ON MAP${traffic.hasKey() ? "" : " · STATIC ETAS"}`,
        6000,
      );
      if (traffic.hasKey()) void priceLive();
    } catch (e) {
      console.warn("[nav] alternate routes failed:", e);
    }
  }

  let pricing = false;
  async function priceLive(): Promise<void> {
    if (pricing || !routes.length || routes[0].offline) return;
    pricing = true;
    try {
      for (const r of routes) {
        if (!routes.includes(r)) return; // route set swapped under us — drop stale pricing
        const sec = await traffic.liveEta(r.coords);
        if (sec != null) r.liveSec = sec;
      }
      renderAlts();
      if (routes.some((r) => r.liveSec != null)) setStatus("LIVE TRAFFIC ETAS · © TOMTOM", 5000);
    } finally {
      pricing = false;
    }
  }

  /** Best-known seconds for a route: live-traffic price when we have one. */
  function routeSeconds(r: RouteResult): number {
    return r.liveSec ?? r.timeSec;
  }

  // map badges: the pick states its minutes on the flat plan frame, ghosts
  // state the delta against it — same numbers as the chips, same honesty
  function labelsFor(): (string | null)[] {
    if (!routes.length || routes[0].offline) return [];
    const base = routeSeconds(routes[0]);
    return routes.map((r, i) => {
      if (i === 0) return `${Math.ceil(routeSeconds(r) / 60)} MIN`;
      const d = Math.round((routeSeconds(r) - base) / 60);
      const delta = d === 0 ? "±0" : d > 0 ? `+${d}` : `\u2212${-d}`;
      return `${delta} MIN`;
    });
  }

  // chip row under the ETA: [SEL · 11 MIN] [ALT · −3 MIN · LIVE] — tapping an
  // ALT promotes it to the active royal-blue route and ghosts the old one
  function renderAlts(): void {
    el.alts.innerHTML = "";
    if (!route || routes.length < 2) {
      el.alts.hidden = true;
      return;
    }
    const base = routeSeconds(routes[0]);
    routes.forEach((r, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `nav-chip${i === 0 ? " on" : ""}`;
      const d = Math.round((routeSeconds(r) - base) / 60);
      const delta = d === 0 ? "±0" : d > 0 ? `+${d}` : `\u2212${-d}`;
      chip.textContent = `${i === 0 ? "SEL" : `ALT ${i}`} · ${delta} MIN${r.liveSec != null ? " · LIVE" : ""}`;
      if (i > 0) chip.addEventListener("click", () => selectAlt(i));
      el.alts.appendChild(chip);
    });
    el.alts.hidden = false;
  }

  function selectAlt(idx: number): void {
    const picked = routes[idx];
    if (!picked || picked === routes[0]) return;
    routes = [picked, ...routes.filter((r) => r !== picked)];
    route = picked;
    progress = lastFix ? nav.progress(lastFix) : 0; // re-project onto the new geometry
    progressFloor = progress;
    nav.setRoutes(routes, labelsFor());
    if (phase === "preview") nav.setMode("plan"); // keep every candidate framed
    shownStepIdx = -1;
    updateStepCard(true);
    renderAlts();
    updateStrip();
    setStatus(`ALT ROUTE SELECTED · ${Math.ceil(routeSeconds(picked) / 60)} MIN`, 4000);
  }

  function clearRoute(): void {
    dest = null;
    route = null;
    routes = [];
    progress = 0;
    progressFloor = 0;
    phase = "idle";
    demoFix = null;
    offFixes = 0;
    nav.setDemoPos(null);
    el.page.classList.remove("drive");
    nav.setRoutes(null);
    el.alts.hidden = true;
    el.card.hidden = true;
    el.maneuver.hidden = true;
    el.overview.textContent = "OVERVIEW";
    updateStrip();
    setStatus(gpsStatusText(feed.read()));
  }

  // GO — commit to the pick: planning chrome peels away, the alternates are
  // dropped (the decision is made), the amber maneuver prompt floats top-left,
  // the context strip takes over the bottom bar, and the camera flies from the
  // flat plan frame into the 3D chase view over the arrow.
  function startDrive(): void {
    if (!route || !dest) return;
    phase = "drive";
    routes = [route]; // commit: ghosts + badges off the map, chips empty
    offFixes = 0;
    progressFloor = progress;
    el.page.classList.add("drive");
    el.results.hidden = true;
    el.keyPanel.hidden = true;
    el.overview.textContent = "OVERVIEW";
    nav.setRoutes(routes, [null]);
    nav.setMode("follow");
    shownStepIdx = -1;
    updateStepCard(true);
    el.maneuver.hidden = false;
    updateStrip();
    setStatus(`NAVIGATING · ${shortName(dest.name)} · ${Math.ceil(routeSeconds(route) / 60)} MIN`);
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
    const glyph = step ? glyphSvg(step.glyph) : glyphSvg(route.offline ? "straight" : "arrive");
    const text = step
      ? `${step.label} — ${step.lengthMi.toFixed(1)} MI`
      : route.offline
        ? "DIRECT BEARING — NO ROAD DATA"
        : "ARRIVE AT DESTINATION";
    el.glyph.innerHTML = glyph;
    el.stepText.textContent = text;
    // the drive-phase top-left prompt mirrors the same next maneuver, big + amber
    el.maneuverGlyph.innerHTML = glyph;
    el.maneuverText.textContent = text;
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
      setStatus("SEARCH OFFLINE · CHECK NETWORK");
      hideResults();
    }
    searching = false;
  }

  // ---- context strip (bottom bar, navigate tab only) ----------------------
  // drive = green time-to-go + arrival on the left, trip progress bar in the
  // middle, OVERVIEW/EXIT on the right; plan/idle = a plain trip summary so
  // the media player never competes with route picking

  function updateStrip(): void {
    const driving = phase === "drive" && route !== null;
    el.stripEta.hidden = !driving;
    el.stripProgress.hidden = !driving;
    el.stripActions.hidden = !driving;
    el.stripNote.hidden = driving;
    if (driving && route) {
      const timeLeft = Math.max(0, routeSeconds(route) * (1 - progress));
      el.stripTime.textContent = `${Math.ceil(timeLeft / 60)} MIN`;
      el.stripArrive.textContent = `ARR ${fmtArrival(new Date(Date.now() + timeLeft * 1000))}`;
      const pct = Math.round(progress * 100);
      el.stripFill.style.width = `${pct}%`;
      el.stripPct.textContent = `${pct}%`;
    } else if (route) {
      el.stripNote.textContent =
        `TO ${shortName(dest ? dest.name : "").toUpperCase()} · ${route.lengthMi.toFixed(1)} MI` +
        ` · ${Math.ceil(routeSeconds(route) / 60)} MIN${route.offline ? " · OFFLINE BEELINE" : ""}`;
    } else {
      el.stripNote.textContent = "NAVIGATE · SEARCH A DESTINATION TO BEGIN";
    }
  }

  // ---- wrong-turn handling -------------------------------------------------
  // Every fresh real fix asks how far laterally the car sits off the active
  // polyline. A few consecutive misses (not one GPS hiccup) mean a genuine
  // wrong turn: reroute from the actual position to the same destination,
  // swap the geometry in place — chase cam never drops, ETA + progress
  // re-price from where we really are. Cooldown keeps a stuck fix from
  // spamming Valhalla. Offline reroute falls back to a beeline and says so.

  function checkDeviation(pos: LngLat): void {
    if (!route || phase !== "drive" || rerouting) return;
    if (performance.now() - lastRerouteAt < REROUTE_COOLDOWN_MS) return;
    if (route.offline) return; // beeline has no corridor to leave; rerouting needs network
    if (offRouteMeters(route.coords, pos) > OFF_ROUTE_M) offFixes++;
    else offFixes = 0;
    if (offFixes >= 3) void reroute(pos, false);
  }

  async function reroute(pos: LngLat, demo: boolean): Promise<void> {
    if (!route || !dest || rerouting || phase !== "drive") return;
    rerouting = true;
    lastRerouteAt = performance.now();
    offFixes = 0;
    setStatus(demo ? "DEMO OFF-ROUTE · REROUTING" : "OFF ROUTE · REROUTING");
    let next: RouteResult;
    try {
      next = await fetchRoute(pos, [dest.lon, dest.lat]);
    } catch (e) {
      console.warn("[nav] reroute failed:", e);
      next = beeline(pos, [dest.lon, dest.lat]); // keep driving, say so
    }
    route = next;
    routes = [next];
    nav.setRoutes(routes, [null]);
    progress = nav.progress(pos);
    progressFloor = progress;
    shownStepIdx = -1;
    updateStepCard(true);
    renderAlts();
    updateStrip();
    setStatus(
      next.offline
        ? `ROUTE OFFLINE · BEELINE TO ${shortName(dest.name)}`
        : `${demo ? "DEMO " : ""}ROUTE UPDATED · ${Math.ceil(routeSeconds(next) / 60)} MIN`,
      6000,
    );
    if (traffic.hasKey() && !next.offline) void priceLive();
    rerouting = false;
  }

  // ---- live loop ---------------------------------------------------------

  let raf = 0;
  let lastEta = 0;

  function renderEta(): void {
    if (!route || el.card.hidden) return;
    const pos = demoFix ?? lastFix; // a demo fix holds the calculations too
    if (pos) progress = Math.max(progressFloor, nav.progress(pos));
    const left = Math.max(0, route.lengthMi * (1 - progress));
    const timeLeft = Math.max(0, routeSeconds(route) * (1 - progress));
    updateStepCard();
    el.dist.textContent = `${left.toFixed(1)} MI`;
    el.time.textContent = `${Math.ceil(timeLeft / 60) } MIN`;
    el.arrive.textContent = fmtArrival(new Date(Date.now() + timeLeft * 1000));
    updateStrip();
  }

  function frame(): void {
    const s = feed.read();
    if (s.live && s.lat != null && s.lng != null && s.fixAt !== seenFixAt) {
      seenFixAt = s.fixAt;
      lastFix = [s.lng, s.lat];
      // real motion outranks the demo pin — the arrow hands back to the feed
      if (demoFix && s.speed > 1) {
        demoFix = null;
        nav.setDemoPos(null);
      }
      if (!demoFix) checkDeviation(lastFix);
    }
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
    if (phase === "drive" && dest) setStatus(`NAVIGATING · ${shortName(dest.name)}`);
    else if (route && dest) setStatus(`PLAN READY · TAP A ROUTE OR PRESS GO`);
    else setStatus(gpsStatusText(feed.read()));
    raf = requestAnimationFrame(frame);
  }

  function stopAll(): void {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
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
  el.go.addEventListener("click", () => void runSearch());
  el.input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void runSearch();
    if (ev.key === "Escape") hideResults();
  });
  el.start.addEventListener("click", startDrive);
  function toggleOverview(): void {
    if (nav.getMode() === "overview") {
      nav.setMode(phase === "drive" ? "follow" : "plan");
      el.overview.textContent = "OVERVIEW";
      el.stripOverview.textContent = "OVERVIEW";
      setStatus(
        phase === "drive" && dest
          ? `NAVIGATING · ${shortName(dest.name)}`
          : "PLAN READY · TAP A ROUTE OR PRESS GO"
      );
    } else {
      nav.setMode("overview");
      el.overview.textContent = phase === "drive" ? "RESUME" : "PLAN";
      el.stripOverview.textContent = phase === "drive" ? "RESUME" : "PLAN";
      setStatus("ROUTE OVERVIEW · DRAG TO PAN");
    }
  }
  el.overview.addEventListener("click", toggleOverview);
  el.stripOverview.addEventListener("click", toggleOverview);
  el.clear.addEventListener("click", clearRoute);
  // EXIT in the drive strip ends the whole trip: route cleared, camera parks
  el.stripExit.addEventListener("click", () => {
    clearRoute();
    setStatus("TRIP ENDED", 4000);
  });

  // tapping a route line or its badge on the map picks it — same path as the
  // chips; the map never reports taps in follow mode (drive) or without a route
  nav.onRouteTap((idx) => selectAlt(idx));

  // preview-only wrong-turn demo: ALT+click any spot off the route while
  // driving and the arrow is pinned there (labeled DEMO — nothing moves on
  // its own), then the real reroute logic runs from that position
  nav.onMapClick((pos, ev) => {
    if (phase !== "drive" || !ev.altKey || rerouting || !route) return;
    const ahead = pointAlong(
      route.coords,
      cumulativeMeters(route.coords),
      Math.min(1, progress + 0.02)
    );
    demoFix = pos;
    offFixes = 0;
    // aim the pinned arrow down the road it is supposed to be on
    nav.setDemoPos(pos, ahead ? (ahead.bearingDeg * Math.PI) / 180 : undefined);
    void reroute(pos, true);
  });

  updateStrip(); // seed the idle strip note

  // traffic toggle + paste-once TomTom key -----------------------------------
  // icon-only rail button: state lives in the corner dot (off/nokey/live),
  // the words ride aria-label + title so screen readers keep the full story
  function refreshTrafficBtn(): void {
    el.trafficState.dataset.state = trafficOn ? "live" : traffic.hasKey() ? "off" : "nokey";
    const words = trafficOn ? "LIVE" : traffic.hasKey() ? "OFF" : "NO KEY";
    el.traffic.setAttribute("aria-label", `Traffic overlay: ${words.toLowerCase()}`);
    el.traffic.title = `TRAFFIC · ${words}`;
    el.traffic.setAttribute("aria-pressed", String(trafficOn));
  }

  function saveKey(): void {
    const key = el.keyInput.value.trim();
    if (!key) {
      setStatus("KEY EMPTY · ESC TO CANCEL", 3000);
      return;
    }
    traffic.setKey(key);
    el.keyInput.value = "";
    el.keyPanel.hidden = true;
    refreshTrafficBtn();
    setStatus("TRAFFIC KEY SAVED · LIVE ETAS READY", 6000);
    if (routes.length && !routes[0].offline) void priceLive();
  }

  el.traffic.addEventListener("click", () => {
    if (!traffic.hasKey()) {
      el.keyPanel.hidden = false;
      el.keyInput.focus();
      setStatus("FREE KEY AT DEVELOPER DOT TOMTOM DOT COM · PASTE BELOW", 8000);
      return;
    }
    trafficOn = !trafficOn;
    nav.setTraffic(trafficOn ? [traffic.tileUrl() as string] : null);
    refreshTrafficBtn();
    setStatus(trafficOn ? "TRAFFIC LIVE · © TOMTOM" : "TRAFFIC OFF", 5000);
    if (trafficOn) void priceLive();
  });
  el.keySave.addEventListener("click", saveKey);
  el.keyInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") saveKey();
    if (ev.key === "Escape") el.keyPanel.hidden = true;
  });
  el.keyClear.addEventListener("click", () => {
    traffic.setKey(null);
    trafficOn = false;
    nav.setTraffic(null);
    el.keyPanel.hidden = true;
    el.keyInput.value = "";
    for (const r of routes) r.liveSec = null; // live prices belonged to the old key
    renderAlts();
    refreshTrafficBtn();
    setStatus("TRAFFIC OFF · KEY CLEARED", 4000);
  });
  refreshTrafficBtn();

  document.addEventListener("click", (ev) => {
    if (!el.results.hidden && !el.results.contains(ev.target as Node) && ev.target !== el.input) {
      hideResults();
    }
  });

  // ---- glitch -> type-in entrance, same language as the other menus ------
  // (glitch hits the buttons whole; typing hits only text nodes — the traffic
  // rail button is pure SVG, so it gets the glitch but never a type-in)

  const searchLabel = el.searchBtn.querySelector<HTMLElement>("b")!;
  const introTargets: HTMLElement[] = [searchLabel, el.status];

  function playIntro(): void {
    cancelFx();
    introTargets.forEach(hideForType);
    schedule(0, () => glitchIn(el.searchBtn));
    schedule(0, () => glitchIn(el.traffic));
    let t = 150;
    for (const node of introTargets) {
      schedule(t, () => typeIn(node));
      t += 70;
    }
  }

  return {
    playIntro,
  };
}
