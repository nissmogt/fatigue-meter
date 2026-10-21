/**
 * IIR filtering: RBJ-cookbook biquads (bilinear transform with prewarp),
 * Butterworth cascades, causal and zero-phase (forward-backward) filtering,
 * plus moving-average and linear detrending helpers. Float64 throughout: a
 * 0.5 Hz high-pass at 30–60 Hz has poles near |z| ≈ 0.93–0.97.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ low-pass; Q = 1/√2 gives a 2nd-order Butterworth. */
export function lowpass(fs: number, fc: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cw) / 2 / a0,
    b1: (1 - cw) / a0,
    b2: (1 - cw) / 2 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ high-pass; Q = 1/√2 gives a 2nd-order Butterworth. */
export function highpass(fs: number, fc: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cw) / 2 / a0,
    b1: -(1 + cw) / a0,
    b2: (1 + cw) / 2 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Q values of the biquad sections of an even-order Butterworth filter. */
export function butterworthQs(order: number): number[] {
  if (order % 2 !== 0 || order < 2) throw new Error('order must be an even integer >= 2');
  const qs: number[] = [];
  const n = order / 2;
  for (let k = 0; k < n; k++) {
    qs.push(1 / (2 * Math.sin((Math.PI * (2 * k + 1)) / (2 * order))));
  }
  return qs;
}

/** Butterworth band-pass as a cascade of high-pass and low-pass sections. */
export function butterworthBandpass(fs: number, lo: number, hi: number, order = 2): Biquad[] {
  const qs = butterworthQs(order);
  const out: Biquad[] = [];
  for (const q of qs) out.push(highpass(fs, lo, q));
  for (const q of qs) out.push(lowpass(fs, hi, q));
  return out;
}

export function butterworthLowpass(fs: number, fc: number, order = 2): Biquad[] {
  return butterworthQs(order).map((q) => lowpass(fs, fc, q));
}

export function butterworthHighpass(fs: number, fc: number, order = 2): Biquad[] {
  return butterworthQs(order).map((q) => highpass(fs, fc, q));
}

/** Magnitude response of a cascade at frequency f (Hz). */
export function magnitudeAt(sections: readonly Biquad[], fs: number, f: number): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let mag = 1;
  for (const s of sections) {
    const nr = s.b0 + s.b1 * c1 + s.b2 * c2;
    const ni = -(s.b1 * s1 + s.b2 * s2);
    const dr = 1 + s.a1 * c1 + s.a2 * c2;
    const di = -(s.a1 * s1 + s.a2 * s2);
    mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return mag;
}

/** Direct Form II transposed biquad with explicit state. */
export class BiquadFilter {
  private s1 = 0;
  private s2 = 0;
  constructor(public readonly c: Biquad) {}

  reset(): void {
    this.s1 = 0;
    this.s2 = 0;
  }

  /** Set the state to the steady-state response for a constant input x0. */
  initDC(x0: number): void {
    const c = this.c;
    const denom = 1 + c.a1 + c.a2;
    const y0 = denom !== 0 ? (x0 * (c.b0 + c.b1 + c.b2)) / denom : 0;
    this.s2 = c.b2 * x0 - c.a2 * y0;
    this.s1 = c.b1 * x0 - c.a1 * y0 + this.s2;
  }

  process(x: number): number {
    const c = this.c;
    const y = c.b0 * x + this.s1;
    this.s1 = c.b1 * x - c.a1 * y + this.s2;
    this.s2 = c.b2 * x - c.a2 * y;
    return y;
  }
}

/** Causal cascade filtering; state initialised to the DC of the first sample. */
export function filterCausal(x: ArrayLike<number>, sections: readonly Biquad[], initDC = true): Float64Array {
  const n = x.length;
  const y = new Float64Array(n);
  if (n === 0) return y;
  const filters = sections.map((c) => new BiquadFilter(c));
  if (initDC) {
    let v = x[0];
    for (const f of filters) {
      f.initDC(v);
      // steady-state output of this stage feeds the next stage
      const c = f.c;
      const denom = 1 + c.a1 + c.a2;
      v = denom !== 0 ? (v * (c.b0 + c.b1 + c.b2)) / denom : 0;
    }
  }
  for (let i = 0; i < n; i++) {
    let v = x[i];
    for (const f of filters) v = f.process(v);
    y[i] = v;
  }
  return y;
}

/**
 * Zero-phase filtering (forward, then backward) with odd-reflection padding of
 * `padLen` samples at both ends, as in MATLAB/SciPy filtfilt. Prefer passing
 * real neighbouring samples through the pipeline instead of relying on the
 * padding when they exist.
 */
export function filtfilt(x: ArrayLike<number>, sections: readonly Biquad[], padLen: number): Float64Array {
  const n = x.length;
  if (n === 0) return new Float64Array(0);
  if (n < 4) return Float64Array.from(x as ArrayLike<number>);
  const pad = Math.max(0, Math.min(padLen, n - 1));
  const m = n + 2 * pad;
  const ext = new Float64Array(m);
  const x0 = x[0];
  const xn = x[n - 1];
  for (let i = 0; i < pad; i++) ext[i] = 2 * x0 - x[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * xn - x[n - 2 - i];

  let y = filterCausal(ext, sections, true);
  y.reverse();
  y = filterCausal(y, sections, true);
  y.reverse();
  return y.slice(pad, pad + n);
}

/** Centred moving average of odd window `win` (edges use shrinking windows). */
export function movingAverage(x: ArrayLike<number>, win: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const half = Math.floor(Math.max(1, win) / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

/** Trailing (causal) moving average of `win` samples. */
export function movingAverageCausal(x: ArrayLike<number>, win: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  let sum = 0;
  const w = Math.max(1, win);
  for (let i = 0; i < n; i++) {
    sum += x[i];
    if (i >= w) sum -= x[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

/** Remove the least-squares line y = a + b·i. */
export function detrendLinear(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) return out;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxx += i * i;
    sxy += i * x[i];
  }
  const denom = n * sxx - sx * sx;
  const b = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const a = (sy - b * sx) / n;
  for (let i = 0; i < n; i++) out[i] = x[i] - (a + b * i);
  return out;
}

/** Remove the least-squares line of y against arbitrary abscissae t. */
export function detrendLinearXY(t: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  for (let i = 0; i < n; i++) {
    st += t[i];
    sy += y[i];
    stt += t[i] * t[i];
    sty += t[i] * y[i];
  }
  const denom = n * stt - st * st;
  const b = denom !== 0 ? (n * sty - st * sy) / denom : 0;
  const a = (sy - b * st) / n;
  for (let i = 0; i < n; i++) out[i] = y[i] - (a + b * t[i]);
  return out;
}

export function mean(x: ArrayLike<number>): number {
  const n = x.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  return s / n;
}

/** Sample variance (n − 1). */
export function variance(x: ArrayLike<number>): number {
  const n = x.length;
  if (n < 2) return 0;
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - m) ** 2;
  return s / (n - 1);
}

export function median(x: ArrayLike<number>): number {
  const n = x.length;
  if (n === 0) return NaN;
  const a = Float64Array.from(x as ArrayLike<number>).sort();
  return n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
