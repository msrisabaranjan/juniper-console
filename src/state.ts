export type PageId = "home" | "vehicle" | "dash" | "media" | "navigate";
export type Gear = "P" | "R" | "N" | "D";
export type Accent = "red" | "white" | "amber" | "mint" | "cyan" | "cobalt" | "cyber";

/** Single source of truth for accent presets: id keys the tokens.css data-accent
    blocks and carScene's color map; label/rgb drive the picker UI. */
export interface AccentPreset {
  id: Accent;
  label: string;
  rgb: string; // "r g b" — consumed as rgb(var(--accent)) everywhere
}
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "red",    label: "Crimson", rgb: "255 45 45" },
  { id: "amber",  label: "Amber",   rgb: "255 179 71" },
  { id: "mint",   label: "Mint",    rgb: "74 222 128" },
  { id: "cyan",   label: "Cyan",    rgb: "34 211 238" },
  { id: "cobalt", label: "Cobalt",  rgb: "59 130 246" },
  { id: "cyber",  label: "Cyber",   rgb: "176 38 255" },
  { id: "white",  label: "Chalk",   rgb: "242 242 242" },
];

// Persisted across reloads (user request); mirrored by the pre-paint script in index.html
const ACCENT_KEY = "juniper.accent";
export function loadAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (v && ACCENT_PRESETS.some((p) => p.id === v)) return v as Accent;
  } catch { /* private-mode denial -> default */ }
  return "red";
}
export function persistAccent(a: Accent): void {
  try { localStorage.setItem(ACCENT_KEY, a); } catch { /* ignore */ }
}
export type TextMode = "accent" | "chalk";
// Persisted like the accent; mirrored by the pre-paint script in index.html
const TEXT_KEY = "juniper.text";
export function loadText(): TextMode {
  try {
    const v = localStorage.getItem(TEXT_KEY);
    if (v === "chalk" || v === "accent") return v;
  } catch { /* private-mode denial -> default */ }
  return "accent";
}
export function persistText(t: TextMode): void {
  try { localStorage.setItem(TEXT_KEY, t); } catch { /* ignore */ }
}
export type DriveMode = "comfort" | "balance" | "sport" | "custom";
/** off = solid body · x-ray = ghost shell only · hud = ghost shell + edge wireframe */
export type XrayMode = "off" | "x-ray" | "hud";

export interface AppState {
  page: PageId;
  accent: Accent;
  textMode: TextMode;
  gear: Gear;
  battery: number;
  driveMode: DriveMode;
  accel: "chill" | "standard" | "sport";
  ride: "comfort" | "balance" | "sport";
  regen: "low" | "standard" | "high";
  steering: "comfort" | "balance" | "sport";
  beams: boolean;
  taillights: boolean;
  xray: XrayMode;
  chargeLimit: number;
  fan: number; // 0..4
  volume: number; // 0..10
  brightness: number; // 0.6..1.15
  playing: boolean;
  trackIndex: number;
}

type Listener = (next: AppState, prev: AppState) => void;

const initial: AppState = {
  page: "home",
  accent: loadAccent(),
  textMode: loadText(),
  gear: "P",
  battery: 86,
  driveMode: "balance",
  accel: "standard",
  ride: "balance",
  regen: "standard",
  steering: "balance",
  beams: true,
  taillights: true,
  xray: "off",
  chargeLimit: 80,
  fan: 4,
  volume: 6,
  brightness: 1,
  playing: false,
  trackIndex: 0,
};

let state: AppState = { ...initial };
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  const prev = state;
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state, prev);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const FAN_LEVELS = ["LO", "1", "2", "3", "HI"] as const;

export const TRACKS = [
  { title: "Slow Mercury", artist: "Kite Parish", dur: 367 },
  { title: "To The Stars", artist: "Horizon One", dur: 236 },
  { title: "Painted Meridian", artist: "Stable Finch", dur: 254 },
  { title: "Soft Visage", artist: "Juniper Lane", dur: 301 },
  { title: "Linen Hour", artist: "Hollow Radio", dur: 212 },
  { title: "Petal Static", artist: "Orchid Glass", dur: 278 },
  { title: "Window Mileage", artist: "Low Harbor", dur: 245 },
  { title: "Coral Pressing", artist: "Paper Kirin", dur: 289 },
] as const;
