export type PageId = "home" | "vehicle" | "dash" | "climate" | "navigate";
export type Gear = "P" | "R" | "N" | "D";
export type Accent = "red" | "white";
export type DriveMode = "comfort" | "balance" | "sport" | "custom";
/** off = solid body · x-ray = ghost shell only · hud = ghost shell + edge wireframe */
export type XrayMode = "off" | "x-ray" | "hud";

export interface AppState {
  page: PageId;
  accent: Accent;
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
  accent: "red",
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
  { title: "Soft Vision", artist: "Juniper Lane", dur: 301 },
  { title: "Lion Hour", artist: "Hollow Radio", dur: 212 },
  { title: "Petal Static", artist: "Orchid Glass", dur: 278 },
] as const;
