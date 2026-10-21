/**
 * Seeded synthetic camera-PPG generator with ground truth. Shared by the
 * unit tests, the in-app demo source and the e2e video fixture, so every
 * consumer sees bit-identical data for a given seed.
 *
 * RR model (closed-form expectations):
 *   RR_n = RR0 + A_LF·sin(2π·f_LF·t_n + φ1) + A_HF·sin(2π·f_HF·t_n + φ2) + N(0, σ_w)
 *   → LF ≈ A_LF²/2, HF ≈ A_HF²/2 (ms²), LF/HF ≈ (A_LF/A_HF)²
 * Waveform: two-Gaussian beats (systolic + dicrotic), respiratory amplitude
 * modulation, slow drift, white noise; inverted like a camera (systole =
 * darker); sampled on a jittered frame grid with dropped frames.
 */
import type { SampleSeries } from './types';

export interface SyntheticOptions {
  seed: number;
  durationS?: number;
  fps?: number;
  /** Mean RR interval in ms (HR = 60000/rr0). */
  rr0Ms?: number;
  aLfMs?: number;
  aHfMs?: number;
  fLfHz?: number;
  fHfHz?: number;
  /** White RR noise SD in ms. */
  sigmaWMs?: number;
  /** DC level of the red channel, 0..255. */
  dcR?: number;
  dcG?: number;
  dcB?: number;
  /** Pulse amplitude as a fraction of DC (red / green). */
  acFractionR?: number;
  acFractionG?: number;
  /** Respiratory amplitude modulation depth (0..1) at f_HF. */
  respAmpMod?: number;
  /** Baseline drift amplitude (8-bit units) and frequency. */
  driftAmp?: number;
  driftHz?: number;
  /** White pixel-mean noise SD (8-bit units). */
  noiseSd?: number;
  /** Frame-time jitter SD in ms. */
  jitterMs?: number;
  /** Fraction of frames dropped at random. */
  dropFraction?: number;
  /** Resolution of the stored means (1/16 level ≈ averaging ~1000 pixels). */
  quantStep?: number;
  /** Windows [startS, endS] with the finger off the lens (table-top colour). */
  fingerOffWindows?: Array<[number, number]>;
  /** Indices of beats to perturb as ectopic (early beat + compensatory pause). */
  ectopicBeats?: number[];
  /** Indices of beats to delete (missed detections cannot be simulated upstream, but a dropped pulse can). */
  missedBeats?: number[];
  /** Force red saturation (sat fraction 1, mean 255) to test the channel fallback. */
  saturateRed?: boolean;
  /** Start offset of the first beat, seconds. */
  firstBeatS?: number;
}

export interface SyntheticExpectation {
  lf: number;
  hf: number;
  lfHf: number;
  sdnn: number;
  rmssd: number;
  meanHR: number;
}

export interface SyntheticResult {
  series: SampleSeries;
  /** True systolic-peak times (seconds, series time base). */
  beatTimes: Float64Array;
  /** True RR intervals in ms (beatTimes[i+1] − beatTimes[i]). */
  nnMs: Float64Array;
  /** Closed-form expectations from the RR model parameters. */
  expected: SyntheticExpectation;
  /** Statistics of the actually generated RR series. */
  actual: { sdnn: number; rmssd: number; meanHR: number; meanNN: number };
  fps: number;
  options: Required<Omit<SyntheticOptions, 'fingerOffWindows' | 'ectopicBeats' | 'missedBeats'>> &
    Pick<SyntheticOptions, 'fingerOffWindows' | 'ectopicBeats' | 'missedBeats'>;
}

export const SYNTHETIC_DEFAULTS = {
  durationS: 70,
  fps: 30,
  rr0Ms: 900,
  aLfMs: 20,
  aHfMs: 30,
  fLfHz: 0.1,
  fHfHz: 0.25,
  sigmaWMs: 3,
  dcR: 180,
  dcG: 70,
  dcB: 50,
  acFractionR: 0.02,
  acFractionG: 0.03,
  respAmpMod: 0.15,
  driftAmp: 3,
  driftHz: 0.05,
  noiseSd: 0.3,
  jitterMs: 2,
  dropFraction: 0.02,
  quantStep: 1 / 16,
  saturateRed: false,
  firstBeatS: 0.5,
} as const;

/** Named presets used by the demo source and tests. */
export function syntheticPreset(name: 'clean' | 'poor' | 'saturated', seed: number): SyntheticOptions {
  switch (name) {
    case 'poor':
      return { seed, noiseSd: 6, dropFraction: 0.2, acFractionR: 0.006, acFractionG: 0.008, driftAmp: 12, jitterMs: 6 };
    case 'saturated':
      return { seed, saturateRed: true };
    default:
      return { seed };
  }
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller on a uniform generator. */
export function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

export function generateSynthetic(opts: SyntheticOptions): SyntheticResult {
  const o = { ...SYNTHETIC_DEFAULTS, ...stripUndefined(opts) } as SyntheticResult['options'];
  const rng = mulberry32(o.seed);
  const gauss = makeGaussian(rng);
  const phi1 = rng() * 2 * Math.PI;
  const phi2 = rng() * 2 * Math.PI;

  // --- RR series -----------------------------------------------------------
  const beats: number[] = [];
  let t = o.firstBeatS;
  const tEnd = o.durationS + 1.5;
  let n = 0;
  while (t < tEnd && n < 10000) {
    beats.push(t);
    const rr =
      o.rr0Ms +
      o.aLfMs * Math.sin(2 * Math.PI * o.fLfHz * t + phi1) +
      o.aHfMs * Math.sin(2 * Math.PI * o.fHfHz * t + phi2) +
      o.sigmaWMs * gauss();
    t += Math.max(300, rr) / 1000;
    n++;
  }
  // Ectopic beats: move beat k earlier by 30 % of the preceding interval
  // (the following interval becomes a compensatory pause).
  if (o.ectopicBeats) {
    for (const k of o.ectopicBeats) {
      if (k > 0 && k < beats.length) {
        beats[k] -= 0.3 * (beats[k] - beats[k - 1]);
      }
    }
  }
  if (o.missedBeats) {
    const drop = new Set(o.missedBeats);
    for (let i = beats.length - 1; i >= 0; i--) if (drop.has(i)) beats.splice(i, 1);
  }
  const beatTimes = Float64Array.from(beats);
  const nnMs = new Float64Array(Math.max(0, beats.length - 1));
  for (let i = 0; i + 1 < beats.length; i++) nnMs[i] = (beats[i + 1] - beats[i]) * 1000;

  // --- Frame grid ----------------------------------------------------------
  const nominal = Math.round(o.durationS * o.fps);
  const ts: number[] = [];
  const frames: number[] = [];
  for (let k = 0; k < nominal; k++) {
    if (rng() < o.dropFraction) continue; // dropped frame
    const tk = k / o.fps + (o.jitterMs / 1000) * gauss();
    ts.push(Math.max(0, tk));
    frames.push(k);
  }
  // keep strictly increasing time after jitter
  for (let i = 1; i < ts.length; i++) if (ts[i] <= ts[i - 1]) ts[i] = ts[i - 1] + 1e-4;

  // --- Waveform ------------------------------------------------------------
  const sysSigma = 0.06;
  const dicDelay = 0.3;
  const dicSigma = 0.09;
  const dicAmp = 0.35;
  const pulseAt = (time: number): number => {
    // Sum nearby beats (±1.2 s); beats are sorted.
    let lo = lowerBound(beats, time - 1.2);
    let v = 0;
    for (let i = lo; i < beats.length && beats[i] < time + 1.2; i++) {
      const d = time - beats[i];
      v += Math.exp((-d * d) / (2 * sysSigma * sysSigma));
      const d2 = d - dicDelay;
      v += dicAmp * Math.exp((-d2 * d2) / (2 * dicSigma * dicSigma));
    }
    return v;
  };

  const N = ts.length;
  const series: SampleSeries = {
    t: new Float64Array(N),
    r: new Float32Array(N),
    g: new Float32Array(N),
    b: new Float32Array(N),
    sat: new Float32Array(N),
    frame: new Uint32Array(N),
    length: N,
  };
  const q = o.quantStep;
  const quant = (x: number) => (q > 0 ? Math.round(x / q) * q : x);
  const clamp255 = (x: number) => Math.min(255, Math.max(0, x));
  for (let i = 0; i < N; i++) {
    const time = ts[i];
    series.t[i] = time;
    series.frame[i] = frames[i];
    const off = o.fingerOffWindows?.some(([a, b]) => time >= a && time < b) ?? false;
    if (off) {
      // Table-top: greyish, no pulse.
      series.r[i] = quant(clamp255(95 + o.noiseSd * gauss()));
      series.g[i] = quant(clamp255(100 + o.noiseSd * gauss()));
      series.b[i] = quant(clamp255(105 + o.noiseSd * gauss()));
      series.sat[i] = 0;
      continue;
    }
    const p = pulseAt(time) * (1 + o.respAmpMod * Math.sin(2 * Math.PI * o.fHfHz * time + phi2));
    const drift = o.driftAmp * Math.sin(2 * Math.PI * o.driftHz * time + phi1);
    const r = o.dcR - o.acFractionR * o.dcR * p + drift + o.noiseSd * gauss();
    const g = o.dcG - o.acFractionG * o.dcG * p + 0.5 * drift + o.noiseSd * gauss();
    const b = o.dcB + 0.3 * drift + o.noiseSd * gauss();
    if (o.saturateRed) {
      series.r[i] = 255;
      series.sat[i] = 1;
    } else {
      series.r[i] = quant(clamp255(r));
      series.sat[i] = r >= 250 ? 1 : 0;
    }
    series.g[i] = quant(clamp255(g));
    series.b[i] = quant(clamp255(b));
  }

  // --- Expectations --------------------------------------------------------
  const rr0s = o.rr0Ms / 1000;
  const lf = (o.aLfMs * o.aLfMs) / 2;
  const hf = (o.aHfMs * o.aHfMs) / 2;
  const expected: SyntheticExpectation = {
    lf,
    hf,
    lfHf: lf / hf,
    sdnn: Math.sqrt(lf + hf + o.sigmaWMs * o.sigmaWMs),
    rmssd: Math.sqrt(
      2 * o.aHfMs * o.aHfMs * Math.sin(Math.PI * o.fHfHz * rr0s) ** 2 +
        2 * o.aLfMs * o.aLfMs * Math.sin(Math.PI * o.fLfHz * rr0s) ** 2 +
        2 * o.sigmaWMs * o.sigmaWMs,
    ),
    meanHR: 60000 / o.rr0Ms,
  };

  // Actual statistics of the generated RR series inside the recording.
  const inside: number[] = [];
  for (let i = 0; i + 1 < beats.length; i++) if (beats[i + 1] <= o.durationS) inside.push(nnMs[i]);
  const meanNN = mean(inside);
  let ss = 0;
  for (const v of inside) ss += (v - meanNN) ** 2;
  const sdnn = inside.length > 1 ? Math.sqrt(ss / (inside.length - 1)) : 0;
  let sd = 0;
  for (let i = 1; i < inside.length; i++) sd += (inside[i] - inside[i - 1]) ** 2;
  const rmssd = inside.length > 1 ? Math.sqrt(sd / (inside.length - 1)) : 0;

  return {
    series,
    beatTimes,
    nnMs,
    expected,
    actual: { sdnn, rmssd, meanHR: meanNN > 0 ? 60000 / meanNN : 0, meanNN },
    fps: o.fps,
    options: o,
  };
}

/** Evaluate the clean (noise-free, drift-free) pulse shape p(t) for fixture rendering. */
export function pulseShape(beatTimes: ArrayLike<number>, time: number): number {
  const sysSigma = 0.06;
  const dicDelay = 0.3;
  const dicSigma = 0.09;
  const dicAmp = 0.35;
  const arr = Array.from(beatTimes);
  let v = 0;
  for (let i = lowerBound(arr, time - 1.2); i < arr.length && arr[i] < time + 1.2; i++) {
    const d = time - arr[i];
    v += Math.exp((-d * d) / (2 * sysSigma * sysSigma));
    const d2 = d - dicDelay;
    v += dicAmp * Math.exp((-d2 * d2) / (2 * dicSigma * dicSigma));
  }
  return v;
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mean(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
