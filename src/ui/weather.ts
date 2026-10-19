/**
 * Exterior temperature for the car's current position — Open-Meteo, free and
 * key-free (same spirit as the key-free OpenFreeMap tiles on the map).
 * Only queried when the sensor feed has a real GPS fix; offline the readout
 * stays on dashes. Refreshes are throttled: same spot re-queries every
 * REFRESH_MIN minutes, driving away re-queries once past MOVE_KM.
 */

const REFRESH_MIN = 10;
const MOVE_KM = 2;

export interface WeatherFeed {
  /** Fire-and-forget refresh, throttled by distance + age. */
  maybeUpdate(lat: number | null, lng: number | null): void;
  /** Last fetched temperature (°F); null until the first success. */
  tempF(): number | null;
}

function kmBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dφ = ((lat2 - lat1) * Math.PI) / 180;
  const dλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dφ / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function createWeatherFeed(): WeatherFeed {
  let temp: number | null = null;
  let at: { lat: number; lng: number } | null = null;
  let fetchedAt = 0;
  let inflight = false;

  async function fetchTemp(lat: number, lng: number): Promise<void> {
    inflight = true;
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
        `&current=temperature_2m&temperature_unit=fahrenheit`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as { current?: { temperature_2m?: number } };
      const t = data.current?.temperature_2m;
      if (typeof t === "number" && Number.isFinite(t)) {
        temp = t;
        at = { lat, lng };
        fetchedAt = Date.now();
      }
    } catch {
      /* offline or blocked: keep the last temperature */
    } finally {
      inflight = false;
    }
  }

  return {
    maybeUpdate(lat, lng) {
      if (lat == null || lng == null || inflight) return;
      if (fetchedAt && Date.now() - fetchedAt < REFRESH_MIN * 60_000) {
        if (!at || kmBetween(at.lat, at.lng, lat, lng) < MOVE_KM) return;
      }
      void fetchTemp(lat, lng);
    },
    tempF: () => temp,
  };
}
