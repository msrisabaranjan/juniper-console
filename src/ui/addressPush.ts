/**
 * ADDRESS PUSH — destinations beamed in from the phone: iPhone Google Maps
 * share sheet -> iOS Shortcut -> POST to an ntfy.sh topic -> SSE subscription
 * here. Key-less (same spirit as Nominatim/Valhalla/Open-Meteo): the topic
 * name is a shared secret, kept in localStorage (never git).
 *
 * Messages are whatever the share sheet carries: long Maps links embed the
 * place pin (!3d/!4d) or an anchor (@lat,lng / ?q=lat,lng); short links
 * (maps.app.goo.gl) can't be resolved from a browser (CORS), so the parser
 * falls back to geocoding the human-readable part of the share text —
 * Google Maps shares "<name> <street address> <short link>".
 */

export interface PushDestination {
  kind: "coords" | "query";
  lat?: number;
  lon?: number;
  label?: string; // human part of the share text, shown as the destination name
  query?: string; // address text to geocode
}

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
const URL_RE = /https?:\/\/\S+/g;
const PIN_RE = new RegExp(`!3d${NUM}!4d${NUM}`); // place pin in long Maps URLs
const Q_RE = new RegExp(`[?&]q=${NUM},${NUM}`); // ?q=lat,lng
const AT_RE = new RegExp(`@${NUM},${NUM}`); // @lat,lng map anchor
const BARE_RE = new RegExp(`^${NUM}\\s*,\\s*${NUM}$`); // bare "lat,lng" message

function finitePair(m: RegExpMatchArray | null): { lat: number; lon: number } | null {
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function parsePushMessage(raw: string): PushDestination | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const urls = text.match(URL_RE) ?? [];
  // the share line minus any URLs is the human part (place name + street)
  const label = text.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  // a pin (!3d/!4d) beats the camera anchor (@ / q=): the anchor may just be
  // where the map view sits, the pin is the actual place
  for (const u of urls) {
    const pair =
      finitePair(u.match(PIN_RE)) ?? finitePair(u.match(Q_RE)) ?? finitePair(u.match(AT_RE));
    if (pair) return { kind: "coords", ...pair, label: label || undefined };
  }
  const bare = finitePair(text.match(BARE_RE));
  if (bare) return { kind: "coords", ...bare };
  if (label) return { kind: "query", query: label };
  return null;
}

export type PushState = "off" | "armed";

const TOPIC_KEY = "juniper.push.topic";
const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/; // ntfy topic charset

export function loadPushTopic(): string {
  try {
    return localStorage.getItem(TOPIC_KEY) ?? "";
  } catch {
    return ""; // private-mode denial -> no topic
  }
}
export function persistPushTopic(topic: string): void {
  try {
    if (topic) localStorage.setItem(TOPIC_KEY, topic);
    else localStorage.removeItem(TOPIC_KEY);
  } catch {
    /* ignore */
  }
}
export function validPushTopic(topic: string): boolean {
  return TOPIC_RE.test(topic);
}

export interface PushClient {
  setTopic(topic: string): void; // "" clears
  getTopic(): string;
  stop(): void;
}

export function createPushClient(handlers: {
  onDestination: (dest: PushDestination, rawMessage: string) => void;
  onState: (state: PushState) => void;
  onUnparsed: (rawMessage: string) => void;
}): PushClient {
  let topic = loadPushTopic();
  let es: EventSource | null = null;

  function open(): void {
    if (es) {
      es.close();
      es = null;
    }
    if (!topic) {
      handlers.onState("off");
      return;
    }
    // since=now: on (re)connect we only act on pushes made after this
    // subscription opened — a stale Maps link sitting in the topic's
    // retention can never hijack the dash when the page (re)loads.
    const since = Math.floor(Date.now() / 1000);
    es = new EventSource(`https://ntfy.sh/${topic}/sse?since=${since}`);
    es.onopen = () => handlers.onState("armed");
    // onerror: EventSource retries on its own; the dot stays lit while it retries
    es.onmessage = (e: MessageEvent) => {
      let obj: { event?: string; time?: number; message?: string };
      try {
        obj = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (obj.event !== "message" || !obj.message) return; // open/keepalive noise
      if (typeof obj.time === "number" && obj.time < since) return; // belt + braces
      const dest = parsePushMessage(obj.message);
      if (dest) handlers.onDestination(dest, obj.message);
      else handlers.onUnparsed(obj.message);
    };
  }
  open(); // seed from localStorage at page init

  return {
    setTopic(next: string): void {
      topic = next.trim();
      persistPushTopic(topic);
      open();
    },
    getTopic: () => topic,
    stop(): void {
      if (es) {
        es.close();
        es = null;
      }
    },
  };
}
