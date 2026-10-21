/**
 * Time-base handling: frame-rate estimation, de-duplication, uniform
 * resampling (linear or natural cubic spline) and gap statistics.
 */
import { median } from './filters';

/** Median instantaneous rate 1/Δt in Hz (0 when fewer than 2 samples). */
export function estimateFs(t: ArrayLike<number>): number {
  const n = t.length;
  if (n < 2) return 0;
  const dt = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) dt[i - 1] = t[i] - t[i - 1];
  const md = median(dt);
  return md > 0 ? 1 / md : 0;
}

/** Keep only strictly increasing timestamps (drops duplicates / reordered frames). */
export function dedupeTimes(t: ArrayLike<number>, x: ArrayLike<number>): { t: Float64Array; x: Float64Array } {
  const n = t.length;
  const tt: number[] = [];
  const xx: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (t[i] > last && Number.isFinite(t[i]) && Number.isFinite(x[i])) {
      tt.push(t[i]);
      xx.push(x[i]);
      last = t[i];
    }
  }
  return { t: Float64Array.from(tt), x: Float64Array.from(xx) };
}

export interface GapStats {
  /** Fraction of nominal frame slots missing (gaps counted as (Δt/dt0 − 1)). */
  dropFraction: number;
  /** Longest interval between consecutive samples, seconds. */
  longestGapS: number;
}

export function gapStats(t: ArrayLike<number>, nominalFs: number): GapStats {
  const n = t.length;
  if (n < 2 || nominalFs <= 0) return { dropFraction: 0, longestGapS: 0 };
  const dt0 = 1 / nominalFs;
  let missing = 0;
  let longest = 0;
  for (let i = 1; i < n; i++) {
    const d = t[i] - t[i - 1];
    if (d > longest) longest = d;
    const slots = Math.round(d / dt0);
    if (slots > 1) missing += slots - 1;
  }
  const expected = Math.round((t[n - 1] - t[0]) / dt0) + 1;
  return { dropFraction: expected > 0 ? missing / expected : 0, longestGapS: longest };
}

export interface Uniform {
  t0: number;
  fs: number;
  y: Float64Array;
}

/** Piecewise-linear resampling onto t0 + k/fs for k while ≤ t1. */
export function resampleLinear(t: ArrayLike<number>, x: ArrayLike<number>, fs: number, t0?: number, t1?: number): Uniform {
  const n = t.length;
  const start = t0 ?? t[0];
  const end = t1 ?? t[n - 1];
  const m = n < 2 || end < start ? 0 : Math.floor((end - start) * fs + 1e-9) + 1;
  const y = new Float64Array(Math.max(0, m));
  let j = 0;
  for (let k = 0; k < m; k++) {
    const tk = start + k / fs;
    while (j + 1 < n - 1 && t[j + 1] < tk) j++;
    const ta = t[j];
    const tb = t[j + 1];
    const w = tb > ta ? (tk - ta) / (tb - ta) : 0;
    const wc = Math.min(1, Math.max(0, w));
    y[k] = x[j] + (x[j + 1] - x[j]) * wc;
  }
  return { t0: start, fs, y };
}

/** Natural cubic spline through (t_i, y_i), strictly increasing t. */
export class CubicSpline {
  private readonly y2: Float64Array;
  constructor(
    private readonly t: Float64Array,
    private readonly y: Float64Array,
  ) {
    const n = t.length;
    const y2 = new Float64Array(n);
    if (n >= 3) {
      const u = new Float64Array(n);
      for (let i = 1; i < n - 1; i++) {
        const sig = (t[i] - t[i - 1]) / (t[i + 1] - t[i - 1]);
        const p = sig * y2[i - 1] + 2;
        y2[i] = (sig - 1) / p;
        const d = (y[i + 1] - y[i]) / (t[i + 1] - t[i]) - (y[i] - y[i - 1]) / (t[i] - t[i - 1]);
        u[i] = ((6 * d) / (t[i + 1] - t[i - 1]) - sig * u[i - 1]) / p;
      }
      y2[n - 1] = 0;
      for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
    }
    this.y2 = y2;
  }

  at(x: number): number {
    const t = this.t;
    const y = this.y;
    const n = t.length;
    if (n === 0) return NaN;
    if (n === 1) return y[0];
    if (x <= t[0]) return y[0] + ((y[1] - y[0]) / (t[1] - t[0])) * (x - t[0]);
    if (x >= t[n - 1]) return y[n - 1] + ((y[n - 1] - y[n - 2]) / (t[n - 1] - t[n - 2])) * (x - t[n - 1]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] > x) hi = mid;
      else lo = mid;
    }
    const h = t[hi] - t[lo];
    const a = (t[hi] - x) / h;
    const b = (x - t[lo]) / h;
    return a * y[lo] + b * y[hi] + ((a * a * a - a) * this.y2[lo] + (b * b * b - b) * this.y2[hi]) * (h * h) / 6;
  }
}

/** Natural-cubic-spline resampling onto t0 + k/fs for k while ≤ t1. */
export function resampleSpline(t: ArrayLike<number>, x: ArrayLike<number>, fs: number, t0?: number, t1?: number): Uniform {
  const n = t.length;
  if (n < 3) return resampleLinear(t, x, fs, t0, t1);
  const start = t0 ?? t[0];
  const end = t1 ?? t[n - 1];
  const m = end < start ? 0 : Math.floor((end - start) * fs + 1e-9) + 1;
  const spline = new CubicSpline(Float64Array.from(t as ArrayLike<number>), Float64Array.from(x as ArrayLike<number>));
  const y = new Float64Array(Math.max(0, m));
  for (let k = 0; k < m; k++) y[k] = spline.at(start + k / fs);
  return { t0: start, fs, y };
}

/** Upsample a uniform series by an integer factor with a natural cubic spline. */
export function upsampleUniform(y: ArrayLike<number>, fs: number, factor: number): Uniform {
  const n = y.length;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / fs;
  return resampleSpline(t, y, fs * factor, 0, (n - 1) / fs);
}
