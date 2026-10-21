/**
 * HRV metrics: time domain over accepted intervals, and a Lomb-Scargle
 * periodogram (Scargle form with τ, Press & Rybicki) for LF/HF without
 * resampling the beat series.
 */
import type { HrvFreq, HrvTime, SpectrumOptions } from './pipeline';
import { detrendLinearXY, mean, variance } from './filters';
import type { NnResult } from './ibi';
import { acceptedIntervals } from './ibi';
import { CubicSpline } from './resample';

export function timeDomain(nn: NnResult): HrvTime | null {
  const acc = acceptedIntervals(nn);
  const n = acc.ms.length;
  if (n < 2) return null;
  const meanNN = mean(acc.ms);
  const sdnn = Math.sqrt(variance(acc.ms));
  // Successive differences only between adjacent accepted intervals.
  let sumSq = 0;
  let m = 0;
  let over50 = 0;
  for (let i = 1; i < nn.ms.length; i++) {
    if (nn.accepted[i] && nn.accepted[i - 1]) {
      const d = nn.ms[i] - nn.ms[i - 1];
      sumSq += d * d;
      m++;
      if (Math.abs(d) > 50) over50++;
    }
  }
  const rmssd = m > 0 ? Math.sqrt(sumSq / m) : 0;
  const sd1 = rmssd / Math.SQRT2;
  const sd2sq = 2 * sdnn * sdnn - sd1 * sd1;
  return {
    nBeats: n,
    meanNN,
    meanHR: meanNN > 0 ? 60000 / meanNN : 0,
    sdnn,
    rmssd,
    lnRmssd: rmssd > 0 ? Math.log(rmssd) : NaN,
    pnn50: m > 0 ? (100 * over50) / m : 0,
    cvnn: meanNN > 0 ? (100 * sdnn) / meanNN : 0,
    sd1,
    sd2: sd2sq > 0 ? Math.sqrt(sd2sq) : 0,
  };
}

/** Unnormalised Lomb-Scargle periodogram P_x(f) of (t, x) with x already mean-free. */
export function lombScargle(t: ArrayLike<number>, x: ArrayLike<number>, freqs: ArrayLike<number>): Float64Array {
  const n = t.length;
  const out = new Float64Array(freqs.length);
  for (let fi = 0; fi < freqs.length; fi++) {
    const w = 2 * Math.PI * freqs[fi];
    if (w === 0) {
      out[fi] = 0;
      continue;
    }
    let ss = 0;
    let cc = 0;
    for (let j = 0; j < n; j++) {
      ss += Math.sin(2 * w * t[j]);
      cc += Math.cos(2 * w * t[j]);
    }
    const tau = Math.atan2(ss, cc) / (2 * w);
    let xc = 0;
    let xs = 0;
    let c2 = 0;
    let s2 = 0;
    for (let j = 0; j < n; j++) {
      const arg = w * (t[j] - tau);
      const c = Math.cos(arg);
      const s = Math.sin(arg);
      xc += x[j] * c;
      xs += x[j] * s;
      c2 += c * c;
      s2 += s * s;
    }
    const pc = c2 > 0 ? (xc * xc) / c2 : 0;
    const ps = s2 > 0 ? (xs * xs) / s2 : 0;
    out[fi] = 0.5 * (pc + ps);
  }
  return out;
}

/** Trapezoid integral of p(f) over [lo, hi] on a (possibly non-uniform) grid. */
export function bandPower(f: ArrayLike<number>, p: ArrayLike<number>, lo: number, hi: number): number {
  let sum = 0;
  for (let i = 1; i < f.length; i++) {
    const a = Math.max(f[i - 1], lo);
    const b = Math.min(f[i], hi);
    if (b <= a) continue;
    // linear interpolation of p at a and b
    const w = f[i] - f[i - 1];
    const pa = p[i - 1] + ((p[i] - p[i - 1]) * (a - f[i - 1])) / w;
    const pb = p[i - 1] + ((p[i] - p[i - 1]) * (b - f[i - 1])) / w;
    sum += 0.5 * (pa + pb) * (b - a);
  }
  return sum;
}

export function frequencyDomain(nn: NnResult, o: SpectrumOptions): HrvFreq | null {
  const acc = acceptedIntervals(nn);
  const n = acc.ms.length;
  if (n < 8) return null;
  const T = acc.t[n - 1] - acc.t[0];
  if (T < 10) return null;
  const meanNN = mean(acc.ms);
  const x = o.detrend === 'linear' ? detrendLinearXY(acc.t, acc.ms) : subtractMean(acc.ms);
  const varX = variance(x);
  const df = 1 / (o.ofac * T);
  const nyq = meanNN > 0 ? 1000 / (2 * meanNN) : o.fMax;
  const fMax = Math.min(o.fMax, nyq);
  const nf = Math.max(2, Math.floor(fMax / df));
  const f = new Float64Array(nf);
  for (let i = 0; i < nf; i++) f[i] = (i + 1) * df;
  const px = lombScargle(acc.t, x, f);
  // One-sided density in ms²/Hz: 2·P·T/N, then Parseval rescale so ∫PSD df = var.
  const p = new Float64Array(nf);
  for (let i = 0; i < nf; i++) p[i] = (2 * px[i] * T) / n;
  const total = bandPower(f, p, f[0], f[nf - 1]);
  const scale = total > 0 && varX > 0 ? varX / total : 1;
  for (let i = 0; i < nf; i++) p[i] *= scale;

  const lf = bandPower(f, p, o.lf[0], o.lf[1]);
  const hf = bandPower(f, p, o.hf[0], o.hf[1]);
  const tp = lf + hf;
  const lfHf = hf > 0 ? lf / hf : NaN;
  // Respiratory estimate: strongest local maximum of the PSD in 0.1–0.5 Hz.
  // A plain argmax returns the band edge whenever the skirt of an LF peak at
  // or just below 0.1 Hz is taller than the respiratory peak (any LF/HF ≳ 1.5
  // with a 0.1 Hz Mayer wave), which is not a peak at all. Neighbours come
  // from the full grid, so breathing at exactly 0.10 Hz still counts.
  let respHz: number | null = null;
  let best = -Infinity;
  for (let i = 1; i < nf - 1; i++) {
    if (f[i] < 0.1 || f[i] > 0.5) continue;
    if (p[i] > p[i - 1] && p[i] >= p[i + 1] && p[i] > best) {
      best = p[i];
      respHz = f[i];
    }
  }
  return {
    lf,
    hf,
    tp,
    lfHf,
    lfNu: tp > 0 ? (100 * lf) / tp : NaN,
    hfNu: tp > 0 ? (100 * hf) / tp : NaN,
    lnLf: lf > 0 ? Math.log(lf) : NaN,
    lnHf: hf > 0 ? Math.log(hf) : NaN,
    lnLfPlusHf: tp > 0 ? Math.log(tp) : NaN,
    lnLfHf: Number.isFinite(lfHf) && lfHf > 0 ? Math.log(lfHf) : NaN,
    dfHz: df,
    lfBins: T * (o.lf[1] - o.lf[0]),
    respHz,
    psd: { f, p },
  };
}

function subtractMean(x: ArrayLike<number>): Float64Array {
  const m = mean(x);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - m;
  return out;
}

/**
 * Cross-check path for tests: cubic-spline resample the accepted intervals
 * at fsR Hz, Hann window, periodogram in ms²/Hz (one-sided).
 */
export function welchLikePsd(
  t: ArrayLike<number>,
  ms: ArrayLike<number>,
  fsR = 4,
): { f: Float64Array; p: Float64Array } {
  const n = t.length;
  if (n < 4) return { f: new Float64Array(0), p: new Float64Array(0) };
  // Cubic-spline resampling: linear interpolation would attenuate a 0.25 Hz
  // tone sampled at ~1 Hz by sinc^4 (about 30 % of its power).
  const t0 = t[0];
  const t1 = t[n - 1];
  const m = Math.floor((t1 - t0) * fsR) + 1;
  const spline = new CubicSpline(Float64Array.from(t as ArrayLike<number>), Float64Array.from(ms as ArrayLike<number>));
  const y = new Float64Array(m);
  for (let k = 0; k < m; k++) y[k] = spline.at(t0 + k / fsR);
  const yd = detrendLinearXY(Float64Array.from({ length: m }, (_, i) => i), y);
  // Hann window
  let wsum = 0;
  const win = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1));
    wsum += win[i] * win[i];
  }
  const nfft = 1 << Math.ceil(Math.log2(Math.max(256, m)));
  const half = nfft / 2;
  const f = new Float64Array(half);
  const p = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    f[k] = (k * fsR) / nfft;
    let re = 0;
    let im = 0;
    for (let i = 0; i < m; i++) {
      const ang = (-2 * Math.PI * k * i) / nfft;
      const v = yd[i] * win[i];
      re += v * Math.cos(ang);
      im += v * Math.sin(ang);
    }
    const mag2 = re * re + im * im;
    p[k] = ((k === 0 ? 1 : 2) * mag2) / (fsR * wsum);
  }
  // Rescale so the integral equals the variance (same convention as the Lomb-Scargle path).
  const v = variance(yd);
  const total = bandPower(f, p, f[0], f[half - 1]);
  if (total > 0 && v > 0) for (let k = 0; k < half; k++) p[k] *= v / total;
  return { f, p };
}
