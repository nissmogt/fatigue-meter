/**
 * Inter-beat intervals from beat times, with physiological bounds and a
 * local-median artifact rule. Rejected intervals are kept (masked) so the
 * spectral analysis can skip them without interpolation.
 */
import type { NnOptions } from './pipeline';
import { median } from './filters';

export interface NnResult {
  /** Time of the terminating beat of each interval (seconds). */
  t: Float64Array;
  /** Interval length in ms. */
  ms: Float64Array;
  /** 1 = accepted. */
  accepted: Uint8Array;
  acceptedCount: number;
  /** Longest stretch of time not covered by accepted intervals (seconds). */
  longestGapS: number;
}

export function intervalsFromPeaks(peakTimes: ArrayLike<number>): { t: Float64Array; ms: Float64Array } {
  const n = Math.max(0, peakTimes.length - 1);
  const t = new Float64Array(n);
  const ms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = peakTimes[i + 1];
    ms[i] = (peakTimes[i + 1] - peakTimes[i]) * 1000;
  }
  return { t, ms };
}

/**
 * Remove false extra detections: two consecutive short intervals whose sum
 * matches the typical interval are merged back into one beat (Lipponen &
 * Tarvainen "extra beat" rule). Returns the cleaned beat times.
 */
export function mergeExtraBeats(peakTimes: ArrayLike<number>, o: NnOptions): Float64Array {
  const beats = Array.from(peakTimes);
  if (beats.length < 4) return Float64Array.from(beats);
  const ms: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const d = (beats[i] - beats[i - 1]) * 1000;
    if (d >= o.minMs && d <= o.maxMs) ms.push(d);
  }
  if (ms.length < 3) return Float64Array.from(beats);
  const med = median(ms);
  let i = 1;
  while (i + 1 < beats.length) {
    const a = (beats[i] - beats[i - 1]) * 1000;
    const b = (beats[i + 1] - beats[i]) * 1000;
    if (a < 0.75 * med && b < 0.75 * med && Math.abs(a + b - med) < o.tolerance * med) {
      beats.splice(i, 1); // drop the false peak between the two short intervals
      continue;
    }
    i++;
  }
  return Float64Array.from(beats);
}

export function cleanIntervals(rawPeakTimes: ArrayLike<number>, o: NnOptions): NnResult {
  const peakTimes = mergeExtraBeats(rawPeakTimes, o);
  const { t, ms } = intervalsFromPeaks(peakTimes);
  const n = ms.length;
  const accepted = new Uint8Array(n);
  // Stage 1: physiological bounds.
  const inBounds = new Uint8Array(n);
  for (let i = 0; i < n; i++) inBounds[i] = ms[i] >= o.minMs && ms[i] <= o.maxMs ? 1 : 0;
  // Stage 2: local median of in-bounds neighbours.
  const boundedValues: number[] = [];
  for (let i = 0; i < n; i++) if (inBounds[i]) boundedValues.push(ms[i]);
  const globalMed = boundedValues.length ? median(boundedValues) : NaN;
  const h = Math.max(1, o.medianHalfWindow);
  for (let i = 0; i < n; i++) {
    if (!inBounds[i]) continue;
    const neigh: number[] = [];
    for (let k = i - h; k <= i + h; k++) {
      if (k === i || k < 0 || k >= n) continue;
      if (inBounds[k]) neigh.push(ms[k]);
    }
    const med = neigh.length >= 2 ? median(neigh) : globalMed;
    if (!Number.isFinite(med)) {
      accepted[i] = 1;
      continue;
    }
    accepted[i] = Math.abs(ms[i] - med) <= o.tolerance * med ? 1 : 0;
  }
  let acceptedCount = 0;
  let longest = 0;
  let gap = 0;
  for (let i = 0; i < n; i++) {
    if (accepted[i]) {
      acceptedCount++;
      if (gap > longest) longest = gap;
      gap = 0;
    } else {
      gap += ms[i] / 1000;
    }
  }
  if (gap > longest) longest = gap;
  return { t, ms, accepted, acceptedCount, longestGapS: longest };
}

/** Accepted intervals only, in order, with their terminating beat times. */
export function acceptedIntervals(nn: NnResult): { t: Float64Array; ms: Float64Array } {
  const t: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < nn.ms.length; i++) {
    if (nn.accepted[i]) {
      t.push(nn.t[i]);
      ms.push(nn.ms[i]);
    }
  }
  return { t: Float64Array.from(t), ms: Float64Array.from(ms) };
}
