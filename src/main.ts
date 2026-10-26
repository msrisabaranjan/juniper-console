import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/chrome.css";
import "./styles/pages.css";

import { getState, persistAccent, persistText, subscribe } from "./state";
import { initNavbar, initClimate, initVolume, initMedia } from "./ui/chrome";
import { initVehiclePage } from "./pages/vehicle";
import { initDashPage } from "./pages/dash";
import { initNavigatePage } from "./pages/navigate";
import { initMediaPage } from "./pages/media";
import { cancelFx } from "./ui/fx";
import { initCarScene } from "./three/carScene";
import { initTelemetryViz } from "./three/telemetryViz";

// ---------- chrome ----------
initNavbar();
initClimate();
initVolume();
initMedia();
const vehiclePage = initVehiclePage();

const dashPage = initDashPage();
const navPage = initNavigatePage();
const mediaPage = initMediaPage();

// ---------- 3D stage ----------
const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const scene = initCarScene(canvas);

// ---------- home visualizer (replaces the car on HOME; self-subscribes) ----------
initTelemetryViz(document.querySelector<HTMLCanvasElement>("#viz")!);

// ---------- react to state ----------
subscribe((s, prev) => {
  if (s.accent !== prev.accent) {
    document.documentElement.dataset.accent = s.accent;
    persistAccent(s.accent);
    scene.setAccent(s.accent);
  }
  if (s.textMode !== prev.textMode) {
    document.documentElement.dataset.text = s.textMode;
    persistText(s.textMode);
  }
  if (s.beams !== prev.beams || s.taillights !== prev.taillights) {
    scene.setLights(s.beams, s.taillights);
  }
  if (s.xray !== prev.xray) {
    scene.setXray(s.xray);
  }
  if (s.driveMode !== prev.driveMode) {
    scene.setDriveMode(s.driveMode);
  }
  if (s.page !== prev.page) {
    document.documentElement.dataset.page = s.page; // chrome CSS swaps the context strip
    scene.setPage(s.page);
    if (s.page === "vehicle") vehiclePage.playIntro();
    else if (s.page === "dash") dashPage.playIntro();
    else if (s.page === "navigate") navPage.playIntro();
    else if (s.page === "media") mediaPage.playIntro();
    else cancelFx(); // drop any half-typed menu animations
  }
  if (s.brightness !== prev.brightness) {
    document.documentElement.style.setProperty("--brightness", String(s.brightness));
  }
});

// initial scene sync
document.documentElement.dataset.page = getState().page;
document.documentElement.dataset.accent = getState().accent;
document.documentElement.dataset.text = getState().textMode;
scene.setAccent(getState().accent);
scene.setLights(getState().beams, getState().taillights);
scene.setDriveMode(getState().driveMode);
scene.setXray(getState().xray);
scene.setPage(getState().page);

// ---------- boot sequence ----------
const boot = document.getElementById("boot")!;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const bootDelay = reducedMotion ? 350 : 1400;
setTimeout(() => {
  boot.classList.add("done");
  // subtle power-on flicker on the stage canvas
  if (!reducedMotion) {
    canvas.animate(
      [
        { opacity: 0.15 },
        { opacity: 1 },
        { opacity: 0.4 },
        { opacity: 1 },
      ],
      { duration: 700, easing: "ease-out" }
    );
  }
}, bootDelay);
