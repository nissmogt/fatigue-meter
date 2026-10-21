/**
 * Core sample types shared by the capture layer, the DSP pipeline, storage
 * and tests. One sample = the spatial mean of the centre crop of one camera
 * frame.
 */

export interface Sample {
  /** Seconds, on one time base chosen per session (never mixed). */
  t: number;
  /** Mean red of the crop, 0..255 (fractional: averaged over ~1000 pixels). */
  r: number;
  /** Mean green of the crop, 0..255. */
  g: number;
  /** Mean blue of the crop, 0..255. */
  b: number;
  /** Fraction (0..1) of crop pixels whose red channel is >= 250 (saturation). */
  sat: number;
  /** Presented-frame counter from the source; gaps mean dropped frames. */
  frame: number;
}

/** Struct-of-arrays form of a sample run; cheap to slice, store and clone. */
export interface SampleSeries {
  t: Float64Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  sat: Float32Array;
  frame: Uint32Array;
  length: number;
}

export type Channel = 'r' | 'g' | 'b';

export function emptySeries(): SampleSeries {
  return {
    t: new Float64Array(0),
    r: new Float32Array(0),
    g: new Float32Array(0),
    b: new Float32Array(0),
    sat: new Float32Array(0),
    frame: new Uint32Array(0),
    length: 0,
  };
}

export function toSeries(samples: readonly Sample[]): SampleSeries {
  const n = samples.length;
  const s: SampleSeries = {
    t: new Float64Array(n),
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    sat: new Float32Array(n),
    frame: new Uint32Array(n),
    length: n,
  };
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    s.t[i] = x.t;
    s.r[i] = x.r;
    s.g[i] = x.g;
    s.b[i] = x.b;
    s.sat[i] = x.sat;
    s.frame[i] = x.frame;
  }
  return s;
}

export function fromSeries(s: SampleSeries): Sample[] {
  const out: Sample[] = new Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = { t: s.t[i], r: s.r[i], g: s.g[i], b: s.b[i], sat: s.sat[i], frame: s.frame[i] };
  }
  return out;
}

/** Sub-range [from, to) by index. */
export function sliceSeries(s: SampleSeries, from: number, to: number): SampleSeries {
  from = Math.max(0, from);
  to = Math.min(s.length, to);
  if (to < from) to = from;
  return {
    t: s.t.slice(from, to),
    r: s.r.slice(from, to),
    g: s.g.slice(from, to),
    b: s.b.slice(from, to),
    sat: s.sat.slice(from, to),
    frame: s.frame.slice(from, to),
    length: to - from,
  };
}

/** Sub-range by time [t0, t1) in series seconds. */
export function sliceSeriesByTime(s: SampleSeries, t0: number, t1: number): SampleSeries {
  let from = 0;
  while (from < s.length && s.t[from] < t0) from++;
  let to = from;
  while (to < s.length && s.t[to] < t1) to++;
  return sliceSeries(s, from, to);
}

export function channelOf(s: SampleSeries, c: Channel): Float32Array {
  return c === 'r' ? s.r : c === 'g' ? s.g : s.b;
}

/** Plain-JSON form (typed arrays do not survive JSON.stringify). */
export interface SampleSeriesJSON {
  t: number[];
  r: number[];
  g: number[];
  b: number[];
  sat: number[];
  frame: number[];
}

export function seriesToJSON(s: SampleSeries): SampleSeriesJSON {
  return {
    t: Array.from(s.t),
    r: Array.from(s.r),
    g: Array.from(s.g),
    b: Array.from(s.b),
    sat: Array.from(s.sat),
    frame: Array.from(s.frame),
  };
}

export function seriesFromJSON(j: SampleSeriesJSON): SampleSeries {
  const n = j.t.length;
  return {
    t: Float64Array.from(j.t),
    r: Float32Array.from(j.r),
    g: Float32Array.from(j.g),
    b: Float32Array.from(j.b),
    sat: Float32Array.from(j.sat),
    frame: Uint32Array.from(j.frame ?? new Array(n).fill(0)),
    length: n,
  };
}
