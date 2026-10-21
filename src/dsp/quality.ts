/**
 * Signal-quality indices: beat-template correlation (Li & Clifford style),
 * Orphanidou per-segment plausibility rules, perfusion, skewness and
 * autocorrelation periodicity.
 */
import type { QualityPolicy } from './pipeline';
import { mean, median } from './filters';

export interface TemplateResult {
  /** Mean absolute correlation of each beat with the mean beat (NaN when < 3 beats). */
  templateCorr: number;
  /** Per-peak correlation (NaN for peaks without a full window). */
  perBeat: Float64Array;
}

export function templateCorrelation(y: ArrayLike<number>, fs: number, peakIdx: ArrayLike<number>): TemplateResult {
  const np = peakIdx.length;
  const perBeat = new Float64Array(np).fill(NaN);
  if (np < 3) return { templateCorr: NaN, perBeat };
  const ibis: number[] = [];
  for (let i = 1; i < np; i++) ibis.push(peakIdx[i] - peakIdx[i - 1]);
  const half = Math.max(2, Math.floor(median(ibis) / 2));
  const len = 2 * half + 1;
  const windows: Array<{ i: number; w: Float64Array }> = [];
  for (let i = 0; i < np; i++) {
    const c = peakIdx[i];
    if (c - half < 0 || c + half >= y.length) continue;
    const w = new Float64Array(len);
    for (let k = 0; k < len; k++) w[k] = y[c - half + k];
    windows.push({ i, w });
  }
  if (windows.length < 3) return { templateCorr: NaN, perBeat };
  const template = new Float64Array(len);
  for (const { w } of windows) for (let k = 0; k < len; k++) template[k] += w[k] / windows.length;
  let sum = 0;
  for (const { i, w } of windows) {
    const r = Math.abs(pearson(w, template));
    perBeat[i] = r;
    sum += r;
  }
  return { templateCorr: sum / windows.length, perBeat };
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const d = Math.sqrt(saa * sbb);
  return d > 0 ? sab / d : NaN;
}

export function skewness(x: ArrayLike<number>): number {
  const n = x.length;
  if (n < 3) return NaN;
  const m = mean(x);
  let s2 = 0;
  let s3 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    s2 += d * d;
    s3 += d * d * d;
  }
  const sd = Math.sqrt(s2 / n);
  return sd > 0 ? s3 / n / (sd * sd * sd) : NaN;
}

/** Max normalised autocorrelation for lags in [minLagS, maxLagS]. */
export function periodicity(y: ArrayLike<number>, fs: number, minLagS = 0.33, maxLagS = 1.5): { r: number; lagS: number } {
  const n = y.length;
  const m = mean(y);
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += (y[i] - m) ** 2;
  if (r0 <= 0 || n < 4) return { r: 0, lagS: 0 };
  const minLag = Math.max(1, Math.round(minLagS * fs));
  const maxLag = Math.min(n - 2, Math.round(maxLagS * fs));
  let best = -1;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (y[i] - m) * (y[i - lag] - m);
    const r = s / r0;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return { r: Math.max(0, best), lagS: bestLag / fs };
}

/** p95 − p5 of x (robust peak-to-peak). */
export function robustRange(x: ArrayLike<number>): number {
  const n = x.length;
  if (n === 0) return 0;
  const a = Float64Array.from(x as ArrayLike<number>).sort();
  const lo = a[Math.floor(0.05 * (n - 1))];
  const hi = a[Math.ceil(0.95 * (n - 1))];
  return hi - lo;
}

/**
 * Orphanidou-style per-segment check over [t0, t1). Each segment passes when
 * its extrapolated HR is plausible, no inter-beat gap exceeds maxGapS, the
 * longest/shortest interval ratio is bounded and the mean template
 * correlation of its beats is high. Returns the time-weighted good fraction.
 */
export function segmentGoodFraction(
  peakTimes: ArrayLike<number>,
  perBeatCorr: ArrayLike<number>,
  t0: number,
  t1: number,
  policy: QualityPolicy,
): number {
  const total = t1 - t0;
  if (total <= 0) return 0;
  let good = 0;
  let covered = 0;
  for (let s = t0; s < t1 - 1e-9; s += policy.segmentS) {
    const e = Math.min(t1, s + policy.segmentS);
    const len = e - s;
    if (len < 3) break;
    covered += len;
    const idx: number[] = [];
    for (let i = 0; i < peakTimes.length; i++) if (peakTimes[i] >= s && peakTimes[i] < e) idx.push(i);
    const count = idx.length;
    const hr = (count * 60) / len;
    if (hr < policy.hrMin || hr > policy.hrMax) continue;
    let ok = true;
    let minI = Infinity;
    let maxI = 0;
    for (let k = 1; k < idx.length; k++) {
      const d = peakTimes[idx[k]] - peakTimes[idx[k - 1]];
      if (d > policy.maxGapS) ok = false;
      if (d < minI) minI = d;
      if (d > maxI) maxI = d;
    }
    if (!ok) continue;
    if (idx.length >= 2 && maxI / minI > policy.maxIntervalRatio) continue;
    let csum = 0;
    let cn = 0;
    for (const i of idx) {
      const c = perBeatCorr[i];
      if (Number.isFinite(c)) {
        csum += c;
        cn++;
      }
    }
    if (cn > 0 && csum / cn < policy.minTemplateCorr) continue;
    good += len;
  }
  return covered > 0 ? good / covered : 0;
}
