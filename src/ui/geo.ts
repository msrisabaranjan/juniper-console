/**
 * Geodetic -> local Cartesian transforms: WGS84 LLA -> ECEF -> East-North-Up.
 *
 * Raw lat/lng is useless for vector math (great-circle deltas have no shared
 * x/y axes), so the whole telemetry pipeline runs in metres on a flat tangent
 * plane locked to the first live fix of the session. Haversine is only good
 * for scalar distances; the Kalman filter needs orthogonal E/N components.
 * Vertical is ignored (2D track-plane assumption).
 */

const A = 6378137; // WGS84 semi-major axis, m
const F = 1 / 298.257223563; // WGS84 flattening
const E2 = F * (2 - F); // first eccentricity squared
const DEG = Math.PI / 180;

export interface Enu {
  east: number; // metres east of the origin
  north: number; // metres north of the origin
}

function toEcef(latDeg: number, lngDeg: number): [number, number, number] {
  const φ = latDeg * DEG;
  const λ = lngDeg * DEG;
  const n = A / Math.sqrt(1 - E2 * Math.sin(φ) ** 2); // prime vertical radius
  return [
    n * Math.cos(φ) * Math.cos(λ),
    n * Math.cos(φ) * Math.sin(λ),
    n * (1 - E2) * Math.sin(φ),
  ];
}

/** Local ENU frame anchored at one geodetic reference point. */
export class EnuFrame {
  private readonly origin: [number, number, number];
  private readonly sinLat: number;
  private readonly cosLat: number;
  private readonly sinLng: number;
  private readonly cosLng: number;

  constructor(lat: number, lng: number) {
    this.origin = toEcef(lat, lng);
    this.sinLat = Math.sin(lat * DEG);
    this.cosLat = Math.cos(lat * DEG);
    this.sinLng = Math.sin(lng * DEG);
    this.cosLng = Math.cos(lng * DEG);
  }

  /** Geodetic fix -> metres (east, north) from the anchor. */
  toEnu(lat: number, lng: number): Enu {
    const p = toEcef(lat, lng);
    const dx = p[0] - this.origin[0];
    const dy = p[1] - this.origin[1];
    const dz = p[2] - this.origin[2];
    const east = -this.sinLng * dx + this.cosLng * dy;
    const north =
      -this.sinLat * this.cosLng * dx - this.sinLat * this.sinLng * dy + this.cosLat * dz;
    return { east, north };
  }
}
