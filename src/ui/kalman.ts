/**
 * 6-state constant-acceleration Kalman filter on the local ENU plane.
 * State: [east, north, vEast, vNorth, aEast, aNorth].
 *
 * GPS fixes land at ~1 Hz and differentiating them twice explodes the noise
 * (a 3 m wander fakes ~0.3 G of "acceleration"). The filter fuses the noisier
 * ENU position with the very accurate Doppler speed/heading and keeps a
 * physics model in between fixes, so position, velocity and acceleration all
 * come out smooth and usable (CA model per kalmanfilter.net).
 *
 * Tuning:
 *  - Q (process noise: q = acceleration jerk variance, m²/s³): too low and
 *    the G-meter flattens sudden hard braking; too high and it re-amplifies
 *    GPS noise. q=8 is tuned for track driving.
 *  - R (observation noise): callers scale it live with geolocation's
 *    `accuracy` field — when accuracy spikes (tunnel, tree cover) the gain
 *    drops and the internal Newtonian model coasts through the blind spot.
 */

const N = 6; // states
const M = 4; // measurements: [east, north, vEast, vNorth]

type Vec = number[];
type Mat = number[][];

function zeros(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

function mul(A: Mat, B: Mat): Mat {
  const out = zeros(A.length, B[0].length);
  for (let i = 0; i < A.length; i++) {
    for (let k = 0; k < B.length; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < B[0].length; j++) out[i][j] += a * B[k][j];
    }
  }
  return out;
}

function transpose(A: Mat): Mat {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

function addMat(A: Mat, B: Mat): Mat {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

/** Average with the transpose — kills float drift so P stays symmetric. */
function symmetrize(A: Mat): Mat {
  const T = transpose(A);
  return A.map((row, i) => row.map((v, j) => (v + T[i][j]) / 2));
}

/** Gauss-Jordan with partial pivoting; inverting 4x4 once per fix is cheap. */
function invert(A: Mat): Mat {
  const n = A.length;
  const aug = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[piv][col])) piv = r;
    if (Math.abs(aug[piv][col]) < 1e-12) return zeros(n, n); // degenerate: skip correction
    [aug[col], aug[piv]] = [aug[piv], aug[col]];
    const d = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  return aug.map((row) => row.slice(n));
}

/** State transition over dt seconds under the constant-acceleration model. */
function transition(dt: number): Mat {
  const F = zeros(N, N);
  for (let i = 0; i < N; i++) F[i][i] = 1;
  const h2 = (dt * dt) / 2;
  F[0][2] = dt;
  F[1][3] = dt;
  F[0][4] = h2;
  F[1][5] = h2;
  F[2][4] = dt;
  F[3][5] = dt;
  return F;
}

/**
 * Discrete process noise for white acceleration jerk of density q per axis
 * (piecewise-constant noise: Q = G Qc Gᵀ, G rows [dt²/2, dt, 1] per axis).
 */
function processNoise(dt: number, q: number): Mat {
  const Q = zeros(N, N);
  // per-axis [pos, vel, acc] block, scattered into interleaved east/north indices
  const idx = [0, 2, 4];
  const block = [
    [(dt ** 4) / 4, (dt ** 3) / 2, (dt * dt) / 2],
    [(dt ** 3) / 2, dt * dt, dt],
    [(dt * dt) / 2, dt, 1],
  ];
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        Q[idx[i] + axis][idx[j] + axis] = q * block[i][j];
      }
    }
  }
  return Q;
}

export class KalmanCA {
  private x: Vec = new Array<number>(N).fill(0);
  private P: Mat = zeros(N, N);
  private readonly q: number;

  /** q: acceleration process-noise density (m²/s³). */
  constructor(q = 8) {
    this.q = q;
  }

  /** Re-anchor the filter (state in ENU metres / m/s / m/s²). */
  reset(x0: Vec, posVar = 100, velVar = 4, accVar = 25): void {
    this.x = [...x0];
    this.P = zeros(N, N);
    [posVar, posVar, velVar, velVar, accVar, accVar].forEach((v, i) => (this.P[i][i] = v));
  }

  /** Advance the model dt seconds (prediction step). */
  predict(dt: number): void {
    if (dt <= 0) return;
    const F = transition(dt);
    this.P = symmetrize(addMat(mul(mul(F, this.P), transpose(F)), processNoise(dt, this.q)));
    this.x = F.map((row) => row.reduce((s, v, j) => s + v * this.x[j], 0));
  }

  /**
   * Correct with [east, north, vEast, vNorth] observed at the filter's
   * current time. Scale posVar by geolocation accuracy² so degraded fixes
   * drop the Kalman gain and the physics model coasts through blind spots.
   */
  update(z: Vec, posVar: number, velVar: number): void {
    // H selects states 0..3, so S = H P Hᵀ is the top-left 4x4 block of P (+R)
    const S: Mat = Array.from({ length: M }, (_, i) =>
      Array.from({ length: M }, (_, j) => this.P[i][j] + (i === j ? (i < 2 ? posVar : velVar) : 0))
    );
    const Sinv = invert(S);
    const y = z.map((v, i) => v - this.x[i]);
    // K = P Hᵀ S⁻¹, and P Hᵀ is just the first M columns of P
    const K: Mat = Array.from({ length: N }, (_, i) =>
      Array.from({ length: M }, (_, j) =>
        Array.from({ length: M }, (_, k) => this.P[i][k] * Sinv[k][j]).reduce((s, v) => s + v, 0)
      )
    );
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) this.x[i] += K[i][j] * y[j];
    // Joseph-form covariance update: P = (I-KH) P (I-KH)ᵀ + K R Kᵀ
    const IKH: Mat = Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => (i === j ? 1 : 0) - (j < M ? K[i][j] : 0))
    );
    const R = zeros(M, M);
    R[0][0] = R[1][1] = posVar;
    R[2][2] = R[3][3] = velVar;
    const KR = mul(K, R);
    this.P = symmetrize(addMat(mul(mul(IKH, this.P), transpose(IKH)), mul(KR, transpose(K))));
  }

  /** Extrapolate the state dt seconds ahead WITHOUT mutating the filter. */
  peek(dt: number): Vec {
    if (dt <= 0) return [...this.x];
    const F = transition(dt);
    return F.map((row) => row.reduce((s, v, j) => s + v * this.x[j], 0));
  }

  state(): Vec {
    return [...this.x];
  }
}
