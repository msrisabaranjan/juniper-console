import { getState, setState, subscribe, FAN_LEVELS, TRACKS, type Gear, type PageId } from "../state";

const GEARS: Gear[] = ["P", "R", "N", "D"];

export function initStatusbar(): void {
  const gear = document.getElementById("gear")!;
  const buttons = new Map<Gear, HTMLButtonElement>();
  for (const g of GEARS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = g;
    b.setAttribute("aria-pressed", String(g === getState().gear));
    b.addEventListener("click", () => setState({ gear: g }));
    buttons.set(g, b);
    gear.appendChild(b);
  }

  const fill = document.getElementById("battery-fill")!;
  const pct = document.getElementById("battery-pct")!;

  subscribe((s, prev) => {
    if (s.gear !== prev.gear) {
      buttons.forEach((b, g) => b.setAttribute("aria-pressed", String(g === s.gear)));
    }
    if (s.battery !== prev.battery) {
      pct.textContent = `${s.battery}%`;
      fill.setAttribute("width", String((22 * s.battery) / 100));
    }
  });

  // initial battery fill
  fill.setAttribute("width", String((22 * getState().battery) / 100));
  pct.textContent = `${getState().battery}%`;

  const clock = document.getElementById("clock")!;
  const tick = () => {
    const now = new Date();
    const d = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const t = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    clock.textContent = `${d} · ${t}`;
  };
  tick();
  setInterval(tick, 1000);
}

const NAV_ITEMS: { id: PageId; label: string }[] = [
  { id: "home", label: "HOME" },
  { id: "vehicle", label: "VEHICLE" },
  { id: "dash", label: "DASH" },
  { id: "climate", label: "CLIMATE" },
  { id: "navigate", label: "NAVIGATE" },
];

export function initNavbar(): void {
  const nav = document.getElementById("navbar")!;
  const buttons = new Map<PageId, HTMLButtonElement>();
  for (const item of NAV_ITEMS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item.label;
    b.dataset.page = item.id;
    b.addEventListener("click", () => setState({ page: item.id }));
    buttons.set(item.id, b);
    nav.appendChild(b);
  }

  const pageEl = document.getElementById("page-soon")!;
  const soonTitle = document.getElementById("soon-title")!;

  subscribe((s, prev) => {
    if (s.page === prev.page) return;
    buttons.forEach((b, id) => {
      if (id === s.page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    document.querySelectorAll<HTMLElement>(".page").forEach((p) => p.classList.remove("active"));
    const target = document.getElementById(`page-${s.page}`);
    if (target) {
      target.classList.add("active");
    } else {
      const label = NAV_ITEMS.find((n) => n.id === s.page)?.label ?? s.page.toUpperCase();
      soonTitle.textContent = label;
      pageEl.classList.add("active");
    }
  });

  document.getElementById("page-home")!.classList.add("active");
  buttons.get("home")!.setAttribute("aria-current", "page");
}

export function initClimate(): void {
  const label = document.getElementById("fan-level")!;
  document.getElementById("fan-down")!.addEventListener("click", () =>
    setState({ fan: Math.max(0, getState().fan - 1) })
  );
  document.getElementById("fan-up")!.addEventListener("click", () =>
    setState({ fan: Math.min(FAN_LEVELS.length - 1, getState().fan + 1) })
  );
  subscribe((s, prev) => {
    if (s.fan !== prev.fan) label.textContent = FAN_LEVELS[s.fan];
  });
  label.textContent = FAN_LEVELS[getState().fan];
}

export function initVolume(): void {
  document.getElementById("vol-down")!.addEventListener("click", () =>
    setState({ volume: Math.max(0, getState().volume - 1) })
  );
  document.getElementById("vol-up")!.addEventListener("click", () =>
    setState({ volume: Math.min(10, getState().volume + 1) })
  );
}

export function initDock(): void {
  document.getElementById("dock-up")!.addEventListener("click", () =>
    setState({ rideHeight: Math.min(2, getState().rideHeight + 1) })
  );
  document.getElementById("dock-down")!.addEventListener("click", () =>
    setState({ rideHeight: Math.max(-2, getState().rideHeight - 1) })
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function initMedia(): void {
  const title = document.getElementById("track-title")!;
  const artist = document.getElementById("track-artist")!;
  const cur = document.getElementById("track-time-cur")!;
  const end = document.getElementById("track-time-end")!;
  const fill = document.getElementById("progress-fill")!;
  const playIcon = document.getElementById("mc-play-icon")!;
  const playBtn = document.getElementById("mc-play")!;

  let position = 267; // seconds into first track (matches the video's 04:27)
  let shuffle = false;

  const renderTrack = () => {
    const t = TRACKS[getState().trackIndex];
    title.textContent = t.title;
    artist.textContent = t.artist;
    end.textContent = fmt(t.dur);
    cur.textContent = fmt(position);
    fill.style.width = `${(position / t.dur) * 100}%`;
  };

  const renderPlay = () => {
    const playing = getState().playing;
    playIcon.setAttribute(
      "d",
      playing
        ? "M3 1 H5 V13 H3 Z M9 1 H11 V13 H9 Z" // pause bars
        : "M3 1 L12 7 L3 13 Z" // play triangle
    );
    playBtn.classList.toggle("on", playing);
  };

  const next = () => {
    const n = TRACKS.length;
    const idx = shuffle
      ? (getState().trackIndex + 1 + Math.floor(Math.random() * (n - 1))) % n
      : (getState().trackIndex + 1) % n;
    position = 0;
    setState({ trackIndex: idx });
    renderTrack();
  };

  document.getElementById("mc-play")!.addEventListener("click", () =>
    setState({ playing: !getState().playing })
  );
  document.getElementById("mc-next")!.addEventListener("click", next);
  document.getElementById("mc-prev")!.addEventListener("click", () => {
    position = 0;
    setState({ trackIndex: (getState().trackIndex - 1 + TRACKS.length) % TRACKS.length });
    renderTrack();
  });
  document.getElementById("mc-stop")!.addEventListener("click", () => {
    position = 0;
    setState({ playing: false });
    renderTrack();
  });
  document.getElementById("mc-shuffle")!.addEventListener("click", (e) => {
    shuffle = !shuffle;
    (e.currentTarget as HTMLElement).classList.toggle("on", shuffle);
  });

  setInterval(() => {
    if (!getState().playing) return;
    position += 1;
    if (position >= TRACKS[getState().trackIndex].dur) {
      next();
      return;
    }
    cur.textContent = fmt(position);
    fill.style.width = `${(position / TRACKS[getState().trackIndex].dur) * 100}%`;
  }, 1000);

  subscribe((s, prev) => {
    if (s.playing !== prev.playing) renderPlay();
    if (s.trackIndex !== prev.trackIndex) renderTrack();
  });

  renderTrack();
  renderPlay();
}
