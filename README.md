# Juniper Console

A retro-futuristic Tesla Roadster-style in-car UI, cloned as a web app and adapted
for the **Model Y Juniper AWD**. Designed to run full-screen in the Tesla in-car
browser (1920×1200 landscape, touch-first).

> **Unofficial fan project.** Not affiliated with, sponsored by, or endorsed by
> Tesla, Inc. in any way. "Tesla" and "Model Y" are trademarks of Tesla, Inc.,
> used here only to describe what this UI is modeled after.


## Screens (v1)

- **Home** — holographic 3D Model Y Juniper AWD (original in-house GLB, modeled
  in Blender — no third-party/Tesla assets): translucent
  body, amber drivetrain (front + rear motors, battery floor), full-width lightbar
  taillights, volumetric headlight beams, dot-grid floor. Drag to rotate (inertia +
  idle auto-rotate).
- **Vehicle** — drive-mode rail (Comfort / Balance / Sport / Custom) and four
  sub-tabs:
  - *Dynamics* — Acceleration, Ride & Handling, Regen, Steering (segmented controls)
  - *Lights* — headlight beams + lightbar toggles (drive the 3D car live)
  - *Display* — Appearance (Crimson ⇄ Chalk accent switch), Brightness
  - *Charging* — charge-limit slider + live range bar
- **Dash (Track Mode)** — real-data telemetry screen: MapLibre map with GPS
  follow, G-meter with trail, trip stats, exterior temp, brake/accel
  pedals derived from filtered longitudinal G, and a SPEED bar on the
  0..125 mph Juniper AWD ramp with a drive-peak tick. Everything parks at NO SIGNAL
  when there is no real source.
- **Navigate** — full-bleed 3D wireframe nav in the Roadster's idiom: black void,
  line-art streets, extruded ghost building blocks. Two phases, one map:
  - *Plan* — searching (Nominatim) and picking a result drops the camera into a
    flat north-up aerial frame holding every candidate at once: the pick plus
    alternate routes mined by corridor-probing Valhalla (the public endpoint
    ignores `alternates`), ghosted in steel with on-map minute-delta badges
    (`+8 MIN`). Tap any line or badge — or the mirrored chips on the route card —
    to re-select; every estimate re-prices against the new pick.
  - *Drive* — the green GO commits: the planning chrome peels away (search bar,
    quick row and GO step out), the alternates and their badges drop off the
    map (the decision is made), and the camera flies into the heading-up
    50°/z17 close chase POV over the arrow. A big amber maneuver prompt —
    turn glyph + street — floats top-left, chosen amber deliberately so it
    never blends into the red route line. The bottom bar follows the tab:
    on Navigate it's a context strip, not the media player — traffic-light
    green time-to-go + arrival on the left, the trip progress bar in the
    middle, OVERVIEW/RESUME + EXIT on the right (EXIT ends the trip and
    parks the camera). Drive 35 m+ off the route for three GPS fixes in a
    row and it reroutes from where you actually are (labeled `OFF ROUTE ·
    REROUTING`, ETA and progress re-priced); on desktop, ALT+click any spot
    off-route to pin a labeled DEMO fix there and watch the same reroute
    logic run for real. Only real GPS moves the arrow — parked on a
    desktop, the camera just holds the chase frame (no simulated driving).
    OVERVIEW lifts you back out to pan; RESUME drops into the chase again.
  A right-edge rail holds one traffic button whose dot reads grey / amber /
  green (off / no key / live). Live traffic is opt-in: paste a free TomTom
  developer
  key once (stored in localStorage only) and TRAFFIC paints congestion flow
  tiles under the routes while every candidate's ETA is re-priced with live
  traffic. No key ⇒ static, clearly-labelled estimates — never fake "live".
  When Nominatim/Valhalla are unreachable the map still flies on a dashed
  beeline with ROUTE OFFLINE in the HUD.
- **Media** — the Roadster UI's "Listen" tab: Last Listened hero, Recently
  Played + Made For You cover carousels, glitch→type-in entrance and card
  cascade, hover equalizer on the art — clicking a cover makes it the live
  track in the media strip. (Climate remains the `< HI >` pill in chrome.)

Global chrome is bottom-only — there is no top status bar: `< HI >` climate
controls and media bar with fake playlist sit above the bottom nav.

## Stack

Vanilla TypeScript + Vite + Three.js + MapLibre GL. No framework.
Fonts (Chakra Petch, Space Mono) are self-hosted OFL subsets — no CDN needed in the car.

## Telemetry (DASH)

Real sources only — no simulated fallbacks. Each GPS fix is projected onto a
local ENU tangent plane (`ui/geo.ts`) and fused in a 6-state constant-
acceleration Kalman filter (`ui/kalman.ts`) that prefers Doppler speed/heading
over position differentials and weights every fix by its `accuracy` field, so
degraded fixes (tunnels, tree cover) coast through on the physics model.
Body-frame G is the filtered acceleration projected onto the travel direction;
readers extrapolate the filter (`peek`) on `requestAnimationFrame`, so the
gauges run at 60 FPS between ~1 Hz fixes. devicemotion outranks GPS-derived G
where the platform offers it (rare in-car). BRAKE/ACCEL pedals are derived
from filtered longitudinal G while live; the SPEED bar follows filtered GPS
ground speed (0..125 mph, Juniper AWD top speed) and ticks the fastest speed
reached since the fix last went out.

Not wired (future pipelines): Tesla Fleet Telemetry API (needs a small
server-side WebSocket proxy + auth — the browser can't hold the private key),
CAN/ESP32 bridge (hardware), AERO BALANCE (no sensor source yet — parked).

## Run

```bash
npm install
npm run dev      # dev server (host: true — reachable from the car on your LAN)
npm run dev:https # https dev server (self-signed cert) — required by the car
npm run build    # typecheck + production build
npm run preview  # serve the production build
```

To run it in the car: `npm run dev:https` on the PC, then in the Tesla
browser (parked, same Wi-Fi) open `https://<your-lan-ip>:5173`. The cert is
throwaway, so tap through the warning once. https is not optional there:
geolocation is a secure-context API, and `https://localhost` only counts as
secure on the dev machine itself. Tap "Allow" when the car asks for location —
the DASH gauges run off it.

Once deployed (push to `master` runs the Pages workflow, or `gh workflow run deploy.yml`):
the car can just open `https://msrisabaranjan.github.io/juniper-console/` —
real HTTPS, no dev server or cert warnings.

## Credits & licenses

- **Code** — MIT (see `LICENSE`).
- **3D car (`public/models/car.glb`)** — original Juniper-adjacent model built
  from scratch in Blender for this project (parametric loft, no traced or
  extracted geometry, no Tesla marks). An earlier revision of this repo used a
  mesh extracted from a Tesla app; that asset has been removed and replaced.
- **Fonts** — Chakra Petch & Space Mono, self-hosted OFL subsets; license texts
  in `public/fonts/OFL-*.txt`.
- **Libraries** — three.js (MIT), MapLibre GL JS (BSD-3), Vite + TypeScript (MIT).
- **Maps** — OpenFreeMap vector tiles (free non-commercial tier):
  © [OpenFreeMap](https://openfreemap.org) · © OpenMapTiles · © OpenStreetMap contributors (ODbL).
  Shown on the DASH map via the style's attribution control.
- **Weather** — Open-Meteo.com (free non-commercial tier, data licensed CC BY 4.0);
  credited in the DASH exterior-temp panel.
- **Traffic (optional)** — TomTom Maps/Traffic APIs free developer tier (~2,500
  requests/day), used only when you paste your own key into the Navigate page
  (kept in localStorage, never in the repo): dark-tuned flow tiles + live-traffic
  ETA re-pricing. © TomTom rides with the tile layer's attribution control. Get a
  free key at developer.tomtom.com → Maps API + Routing API + Traffic API.

## In-car hardening

- Device-pixel-ratio capped at 1.5, rAF paused when the tab is hidden, no shadows
  or post-processing — tuned for the in-car SoC.
- ≥40px touch targets, no hover-only affordances, focus-visible outlines.
- `prefers-reduced-motion` respected (boot flicker, auto-rotate, transitions).
- Both accent themes keep ≥4.5:1 contrast on black.

## Layout

```
src/
  state.ts          tiny pub/sub app store
  styles/           tokens.css (design layer) · base · chrome · pages
  ui/               chrome.ts (navbar/climate/volume/media) · segmented.ts · fx.ts
                    sensors.ts (GPS -> ENU -> Kalman feed) · geo.ts · kalman.ts ·
                    mapView.ts (MapLibre follow) · navMap.ts (routing overlay +
                    alternates + traffic layer) · routing.ts (Nominatim/Valhalla) ·
                    traffic.ts (optional TomTom) · weather.ts (Open-Meteo)
  pages/            vehicle.ts (mode rail + sub-tabs) · dash.ts (track telemetry)
                    · navigate.ts (map + routing) · media.ts (Listen-style browse)
  three/            carScene.ts (Juniper stage: original GLB + dot grid + interaction)
public/fonts/       self-hosted woff2 subsets + fonts.css + OFL license texts
public/models/      car.glb (in-house Blender model) · mapstyle.json (OpenFreeMap HUD restyle)
```
