import { ACCENT_PRESETS, getState, setState, subscribe, type Accent, type DriveMode, type XrayMode } from "../state";
import { createSegmented, type Segmented } from "../ui/segmented";
import { createSwatches, type Swatches } from "../ui/swatches";
import { cancelFx, glitchIn, hideForType, schedule, typeIn } from "../ui/fx";

type SubTab = "dynamics" | "lights" | "display" | "charging";

const MODES: { id: DriveMode; label: string; name: string }[] = [
  { id: "comfort", label: "SELECT", name: "Comfort" },
  { id: "balance", label: "SELECT", name: "Balance" },
  { id: "sport", label: "SELECT", name: "Sport" },
  { id: "custom", label: "SELECT", name: "Custom" },
];

const DEFAULTS: Record<Exclude<DriveMode, "custom">, { accel: string; ride: string; regen: string; steering: string }> = {
  comfort: { accel: "chill", ride: "comfort", regen: "low", steering: "comfort" },
  balance: { accel: "standard", ride: "balance", regen: "standard", steering: "balance" },
  sport: { accel: "sport", ride: "sport", regen: "high", steering: "sport" },
};

export function initVehiclePage(): { playIntro(): void } {
  // ---------- mode rail ----------
  const rail = document.getElementById("mode-rail")!;
  const modeButtons = new Map<DriveMode, HTMLButtonElement>();
  const modeNames = new Map<DriveMode, HTMLSpanElement>();
  for (const m of MODES) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(m.id === getState().driveMode));
    const label = document.createElement("span");
    label.className = "mode-label";
    label.textContent = m.id === getState().driveMode ? "ACTIVE" : "SELECT";
    const name = document.createElement("span");
    name.className = "mode-name";
    name.textContent = m.name;
    b.append(label, name);
    b.addEventListener("click", () => {
      if (m.id === "custom") {
        setState({ driveMode: "custom" });
        return;
      }
      const d = DEFAULTS[m.id];
      setState({
        driveMode: m.id,
        accel: d.accel as "chill" | "standard" | "sport",
        ride: d.ride as "comfort" | "balance" | "sport",
        regen: d.regen as "low" | "standard" | "high",
        steering: d.steering as "comfort" | "balance" | "sport",
      });
    });
    modeButtons.set(m.id, b);
    modeNames.set(m.id, name);
    rail.appendChild(b);
  }

  // ---------- sub tabs ----------
  const tabsEl = document.getElementById("veh-subtabs")!;
  const bodyEl = document.getElementById("veh-body")!;
  const tabs: { id: SubTab; label: string }[] = [
    { id: "dynamics", label: "DYNAMICS" },
    { id: "lights", label: "LIGHTS" },
    { id: "display", label: "DISPLAY" },
    { id: "charging", label: "CHARGING" },
  ];
  let activeTab: SubTab = "dynamics";
  const tabButtons = new Map<SubTab, HTMLButtonElement>();
  for (const t of tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.id === activeTab));
    b.addEventListener("click", () => {
      if (t.id === activeTab) return;
      activeTab = t.id;
      tabButtons.forEach((btn, id) => btn.setAttribute("aria-selected", String(id === activeTab)));
      renderBody();
      animateMenu();
    });
    tabButtons.set(t.id, b);
    tabsEl.appendChild(b);
  }

  // ---------- glitch -> type-in menu entrance ----------
  const STAGGER = 70; // ms between items starting their entrance
  const GLITCH_LEAD = 150; // glitch burst runs this long before typing starts

  /** Blank every label the upcoming animation will type back in. */
  function armMenu(): void {
    for (const btn of tabButtons.values()) hideForType(btn);
    for (const l of bodyEl.querySelectorAll<HTMLElement>(".setting-label")) hideForType(l);
  }

  /** Re-type the 4 tab labels, then stagger the rows of the active tab. */
  function animateMenu(): void {
    armMenu();
    let t = 0;
    for (const btn of tabButtons.values()) {
      schedule(t, () => {
        glitchIn(btn);
        schedule(GLITCH_LEAD, () => typeIn(btn));
      });
      t += 60;
    }
    schedule(t + 40, animateRows);
  }

  function animateRows(): void {
    let t = 0;
    for (const r of bodyEl.querySelectorAll<HTMLElement>(".setting-row")) {
      schedule(t, () => {
        glitchIn(r);
        const l = r.querySelector<HTMLElement>(".setting-label");
        if (l) schedule(GLITCH_LEAD, () => typeIn(l));
      });
      t += STAGGER;
    }
  }

  /** Full entrance: mode rail, then tabs, then rows. Called on VEHICLE press. */
  function playIntro(): void {
    cancelFx();
    // letters start invisible: every item enters as an empty frame, then
    // glitches and types its text in on its turn
    const s = getState();
    for (const m of MODES) {
      const label = modeButtons.get(m.id)!.querySelector<HTMLElement>(".mode-label")!;
      label.dataset.fxText = m.id === s.driveMode ? "ACTIVE" : "SELECT";
      hideForType(label);
      hideForType(modeNames.get(m.id)!);
    }
    armMenu();
    let t = 0;
    for (const m of MODES) {
      const btn = modeButtons.get(m.id)!;
      const label = btn.querySelector<HTMLElement>(".mode-label")!;
      const name = modeNames.get(m.id)!;
      schedule(t, () => {
        glitchIn(btn);
        schedule(GLITCH_LEAD, () => {
          typeIn(label);
          typeIn(name);
        });
      });
      t += STAGGER;
    }
    schedule(t + 40, animateMenu);
  }

  // ---------- row builders ----------
  function row(label: string, control: HTMLElement): HTMLElement {
    const r = document.createElement("div");
    r.className = "setting-row";
    const l = document.createElement("span");
    l.className = "setting-label";
    l.textContent = label;
    r.append(l, control);
    return r;
  }

  function markCustom(): void {
    const s = getState();
    for (const [mode, d] of Object.entries(DEFAULTS)) {
      if (
        s.accel === d.accel &&
        s.ride === d.ride &&
        s.regen === d.regen &&
        s.steering === d.steering
      ) {
        setState({ driveMode: mode as DriveMode });
        return;
      }
    }
    setState({ driveMode: "custom" });
  }

  // live control references for the currently rendered tab (so state changes
  // animate the existing widgets instead of rebuilding the DOM)
  let dynSegs: Segmented[] | null = null; // [accel, ride, regen, steering]
  let accentSeg: Segmented | null = null;
  let accentSw: Swatches | null = null;
  let textSeg: Segmented | null = null;
  let beamsToggle: HTMLButtonElement | null = null;
  let tailsToggle: HTMLButtonElement | null = null;
  let xraySeg: Segmented | null = null;

  function renderBody(): void {
    dynSegs = null;
    accentSeg = null;
    accentSw = null;
    textSeg = null;
    beamsToggle = null;
    tailsToggle = null;
    xraySeg = null;
    bodyEl.textContent = "";
    const s = getState();

    if (activeTab === "dynamics") {
      const accel = createSegmented(["chill", "standard", "sport"], s.accel, (v) => {
        setState({ accel: v as "chill" | "standard" | "sport" });
        markCustom();
      }, "Acceleration");
      const ride = createSegmented(["comfort", "balance", "sport"], s.ride, (v) => {
        setState({ ride: v as "comfort" | "balance" | "sport" });
        markCustom();
      }, "Ride and handling");
      const regen = createSegmented(["low", "standard", "high"], s.regen, (v) => {
        setState({ regen: v as "low" | "standard" | "high" });
        markCustom();
      }, "Regen braking");
      const steering = createSegmented(["comfort", "balance", "sport"], s.steering, (v) => {
        setState({ steering: v as "comfort" | "balance" | "sport" });
        markCustom();
      }, "Steering feel");
      dynSegs = [accel, ride, regen, steering];
      bodyEl.append(
        row("Acceleration", accel.el),
        row("Ride & Handling", ride.el),
        row("Regen Braking", regen.el),
        row("Steering Feel", steering.el)
      );
    } else if (activeTab === "lights") {
      beamsToggle = document.createElement("button");
      beamsToggle.type = "button";
      beamsToggle.className = "toggle";
      beamsToggle.setAttribute("aria-pressed", String(s.beams));
      beamsToggle.setAttribute("aria-label", "Headlight beams");
      beamsToggle.addEventListener("click", () => setState({ beams: !getState().beams }));

      tailsToggle = document.createElement("button");
      tailsToggle.type = "button";
      tailsToggle.className = "toggle";
      tailsToggle.setAttribute("aria-pressed", String(s.taillights));
      tailsToggle.setAttribute("aria-label", "Lightbar taillights");
      tailsToggle.addEventListener("click", () => setState({ taillights: !getState().taillights }));

      bodyEl.append(row("Headlight Beams", beamsToggle), row("Lightbar Taillights", tailsToggle));
    } else if (activeTab === "display") {
      accentSeg = createSegmented(["Crimson", "Chalk"], s.accent === "red" ? "Crimson" : s.accent === "white" ? "Chalk" : "none", (v) => {
        setState({ accent: v === "Crimson" ? "red" : "white" });
      }, "Appearance accent");
      accentSw = createSwatches(ACCENT_PRESETS, s.accent, (v) => {
        setState({ accent: v as Accent });
      }, "Accent color presets");
      textSeg = createSegmented(
        ["Accent", "Chalk"],
        s.textMode === "chalk" ? "Chalk" : "Accent",
        (v) => setState({ textMode: v === "Chalk" ? "chalk" : "accent" }),
        "HUD text color"
      );

      const brightWrap = document.createElement("div");
      brightWrap.className = "slider";
      const bright = document.createElement("input");
      bright.type = "range";
      bright.min = "60";
      bright.max = "115";
      bright.value = String(Math.round(s.brightness * 100));
      bright.setAttribute("aria-label", "Screen brightness");
      const brightVal = document.createElement("span");
      brightVal.className = "setting-value";
      brightVal.textContent = `${bright.value}%`;
      bright.addEventListener("input", () => {
        brightVal.textContent = `${bright.value}%`;
        setState({ brightness: Number(bright.value) / 100 });
      });
      brightWrap.append(bright, brightVal);

      xraySeg = createSegmented(
        ["off", "x-ray", "hud"],
        s.xray,
        (v) => setState({ xray: v as XrayMode }),
        "X-ray body view"
      );

      bodyEl.append(
        row("Appearance", accentSeg.el),
        row("Accent Colors", accentSw.el),
        row("HUD Text", textSeg.el),
        row("Brightness", brightWrap),
        row("X-Ray Body", xraySeg.el)
      );
    } else {
      const limitWrap = document.createElement("div");
      limitWrap.className = "slider";
      const limit = document.createElement("input");
      limit.type = "range";
      limit.min = "50";
      limit.max = "100";
      limit.step = "5";
      limit.value = String(s.chargeLimit);
      limit.setAttribute("aria-label", "Charge limit");
      const limitVal = document.createElement("span");
      limitVal.className = "setting-value";
      limitVal.textContent = `${limit.value}%`;
      limit.addEventListener("input", () => {
        limitVal.textContent = `${limit.value}%`;
        setState({ chargeLimit: Number(limit.value) });
        updateChargeBar();
      });
      limitWrap.append(limit, limitVal);

      const bar = document.createElement("div");
      bar.className = "charge-bar";
      bar.innerHTML =
        '<div class="fill" id="charge-fill"></div><div class="label"><span>CHARGING · 72 KW</span><span id="charge-range"></span></div>';

      bodyEl.append(row("Charge Limit", limitWrap), bar);
      updateChargeBar();
    }
  }

  function updateChargeBar(): void {
    const s = getState();
    const fill = document.getElementById("charge-fill");
    const range = document.getElementById("charge-range");
    if (!fill || !range) return;
    fill.style.width = `${s.chargeLimit}%`;
    range.textContent = `RANGE ${Math.round((s.chargeLimit / 100) * 275)} MI`;
  }

  // ---------- sync rail + live controls with state ----------
  subscribe((s, prev) => {
    if (s.driveMode !== prev.driveMode) {
      const onVehicle = document.getElementById("page-vehicle")?.classList.contains("active");
      modeButtons.forEach((b, id) => {
        b.setAttribute("aria-pressed", String(id === s.driveMode));
        const label = b.querySelector<HTMLElement>(".mode-label");
        if (!label) return;
        const text = id === s.driveMode ? "ACTIVE" : "SELECT";
        if (label.textContent === text) return;
        label.textContent = text;
        if (onVehicle) {
          glitchIn(label, 200);
          typeIn(label, text, 40);
        }
      });
      if (dynSegs) {
        dynSegs[0].set(s.accel);
        dynSegs[1].set(s.ride);
        dynSegs[2].set(s.regen);
        dynSegs[3].set(s.steering);
      }
    }
    if (s.accent !== prev.accent) {
      if (accentSeg) accentSeg.set(s.accent === "red" ? "Crimson" : s.accent === "white" ? "Chalk" : "none");
      if (accentSw) accentSw.set(s.accent);
    }
    if (s.textMode !== prev.textMode) {
      if (textSeg) textSeg.set(s.textMode === "chalk" ? "Chalk" : "Accent");
    }
    if ((s.beams !== prev.beams || s.taillights !== prev.taillights) && beamsToggle && tailsToggle) {
      beamsToggle.setAttribute("aria-pressed", String(s.beams));
      tailsToggle.setAttribute("aria-pressed", String(s.taillights));
    }
    if (s.xray !== prev.xray && xraySeg) {
      xraySeg.set(s.xray);
    }
  });

  renderBody();

  return { playIntro };
}
