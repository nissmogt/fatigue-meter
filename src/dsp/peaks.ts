/**
 * Systolic peak detection: Elgendi's two-moving-average method with the
 * NeuroKit2 parameterisation (peak window 111 ms, beat window 667 ms, offset
 * β = 0.02, refractory 300 ms), followed by parabolic sub-sample refinement.
 * Input must be band-passed with systole positive.
 */
import { mean, movingAverage } from './filters';

export interface PeakDetectOptions {
  fs: number;
  peakWindowS: number;
  beatWindowS: number;
  beatOffset: number;
  minDelayS: number;
}

/** Local maxima of `data` with their prominence (height above the higher of the two flanking minima). */
export function localMaximaWithProminence(data: ArrayLike<number>): Array<{ index: number; prominence: number }> {
  const n = data.length;
  const out: Array<{ index: number; prominence: number }> = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(data[i] > data[i - 1] && data[i] >= data[i + 1])) continue;
    // plateau handling: skip if the next sample is equal and continues up
    let j = i + 1;
    while (j < n && data[j] === data[i]) j++;
    if (j < n && data[j] > data[i]) continue;
    const h = data[i];
    let leftMin = h;
    for (let k = i - 1; k >= 0; k--) {
      if (data[k] > h) break;
      if (data[k] < leftMin) leftMin = data[k];
    }
    let rightMin = h;
    for (let k = i + 1; k < n; k++) {
      if (data[k] > h) break;
      if (data[k] < rightMin) rightMin = data[k];
    }
    out.push({ index: i, prominence: h - Math.max(leftMin, rightMin) });
  }
  return out;
}

/** Elgendi (2013) systolic peak indices on a band-passed, systole-positive signal. */
export function detectSystolicPeaks(y: ArrayLike<number>, o: PeakDetectOptions): Int32Array {
  const n = y.length;
  if (n < 3) return new Int32Array(0);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = y[i] > 0 ? y[i] : 0;
    z[i] = v * v;
  }
  const w1 = Math.max(1, Math.round(o.peakWindowS * o.fs));
  const w2 = Math.max(1, Math.round(o.beatWindowS * o.fs));
  const maPeak = movingAverage(z, w1);
  const maBeat = movingAverage(z, w2);
  const offset = o.beatOffset * mean(z);
  const minLen = w1;
  const minDelay = Math.round(o.minDelayS * o.fs);

  const peaks: number[] = [];
  let lastPeak = 0;
  let inWave = false;
  let beg = 0;
  for (let i = 0; i <= n; i++) {
    const wave = i < n && maPeak[i] > maBeat[i] + offset;
    if (wave && !inWave) {
      inWave = true;
      beg = i;
    } else if (!wave && inWave) {
      inWave = false;
      const end = i;
      if (end - beg < minLen) continue;
      const seg = new Float64Array(end - beg);
      for (let k = 0; k < seg.length; k++) seg[k] = y[beg + k];
      const maxima = localMaximaWithProminence(seg);
      let best = -1;
      let bestProm = -Infinity;
      for (const m of maxima) {
        if (m.prominence > bestProm) {
          bestProm = m.prominence;
          best = m.index;
        }
      }
      if (best < 0) {
        // no interior maximum (monotonic block): take the block argmax
        let bi = 0;
        for (let k = 1; k < seg.length; k++) if (seg[k] > seg[bi]) bi = k;
        best = bi;
      }
      const peak = beg + best;
      if (peak - lastPeak > minDelay) {
        peaks.push(peak);
        lastPeak = peak;
      }
    }
  }
  return Int32Array.from(peaks);
}

/** Parabolic (three-point) refinement of a peak position; returns a fractional index. */
export function refinePeakIndex(y: ArrayLike<number>, k: number): number {
  if (k <= 0 || k >= y.length - 1) return k;
  const a = y[k - 1];
  const b = y[k];
  const c = y[k + 1];
  const denom = a - 2 * b + c;
  if (denom >= 0) return k; // not a maximum of a concave parabola
  let p = (0.5 * (a - c)) / denom;
  if (p > 0.5) p = 0.5;
  if (p < -0.5) p = -0.5;
  return k + p;
}

/** Refined peak times in seconds for a uniform series starting at t0. */
export function refinedPeakTimes(y: ArrayLike<number>, peaks: Int32Array, fs: number, t0: number): Float64Array {
  const out = new Float64Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) out[i] = t0 + refinePeakIndex(y, peaks[i]) / fs;
  return out;
}

export interface AlignOptions {
  /** Half-width of the template window in seconds (clipped to 0.45 × median IBI). */
  halfWindowS?: number;
  /** Maximum shift searched around each detected peak, seconds. */
  maxShiftS?: number;
  /** Template rebuild iterations. */
  iterations?: number;
}

/**
 * Re-time each detected beat by cross-correlating the mean beat template with
 * the signal around it (matched filter) and refining the best lag with a
 * parabola. Timing noise drops roughly with the square root of the number
 * of template samples, so this is far more robust than a three-point fit on
 * noisy 30 fps data. Returns fractional sample indices (same order as `peaks`).
 */
export function alignPeaksToTemplate(y: ArrayLike<number>, peaks: Int32Array, fs: number, o: AlignOptions = {}): Float64Array {
  const np = peaks.length;
  const n = y.length;
  const pos = new Float64Array(np);
  for (let i = 0; i < np; i++) pos[i] = refinePeakIndex(y, peaks[i]);
  if (np < 3) return pos;
  const ibis: number[] = [];
  for (let i = 1; i < np; i++) ibis.push(peaks[i] - peaks[i - 1]);
  ibis.sort((a, b) => a - b);
  const medIbi = ibis[Math.floor(ibis.length / 2)];
  const half = Math.max(2, Math.round(Math.min((o.halfWindowS ?? 0.35) * fs, 0.45 * medIbi)));
  const len = 2 * half + 1;
  const maxShift = Math.max(1, Math.round((o.maxShiftS ?? 0.12) * fs));
  const iterations = o.iterations ?? 2;

  let centers = Int32Array.from(peaks);
  for (let it = 0; it < iterations; it++) {
    // Build the template from beats with a full window.
    const template = new Float64Array(len);
    let count = 0;
    for (let i = 0; i < np; i++) {
      const c = centers[i];
      if (c - half < 0 || c + half >= n) continue;
      for (let k = 0; k < len; k++) template[k] += y[c - half + k];
      count++;
    }
    if (count < 3) return pos;
    for (let k = 0; k < len; k++) template[k] /= count;

    const next = new Int32Array(np);
    for (let i = 0; i < np; i++) {
      const c = centers[i];
      const lo = -maxShift;
      const hi = maxShift;
      const scores = new Float64Array(hi - lo + 1);
      let best = -Infinity;
      let bestLag = 0;
      for (let lag = lo; lag <= hi; lag++) {
        const start = c + lag - half;
        if (start < 0 || start + len > n) {
          scores[lag - lo] = -Infinity;
          continue;
        }
        let s = 0;
        for (let k = 0; k < len; k++) s += template[k] * y[start + k];
        scores[lag - lo] = s;
        if (s > best) {
          best = s;
          bestLag = lag;
        }
      }
      if (best === -Infinity) {
        next[i] = c;
        continue;
      }
      const bi = bestLag - lo;
      let delta = 0;
      if (bi > 0 && bi < scores.length - 1 && Number.isFinite(scores[bi - 1]) && Number.isFinite(scores[bi + 1])) {
        const a = scores[bi - 1];
        const b = scores[bi];
        const cc = scores[bi + 1];
        const denom = a - 2 * b + cc;
        if (denom < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / denom));
      }
      pos[i] = c + bestLag + delta;
      next[i] = Math.round(pos[i]);
    }
    centers = next;
  }
  return pos;
}
