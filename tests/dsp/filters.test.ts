import { describe, expect, it } from 'vitest';
import {
  butterworthBandpass,
  detrendLinear,
  filterCausal,
  filtfilt,
  highpass,
  lowpass,
  magnitudeAt,
  movingAverage,
} from '../../src/dsp/filters';

describe('RBJ biquads', () => {
  it('match the verified coefficient table at fs = 30 Hz', () => {
    const hp = highpass(30, 0.5);
    expect(hp.b0).toBeCloseTo(0.928624, 5);
    expect(hp.b1).toBeCloseTo(-1.857248, 5);
    expect(hp.b2).toBeCloseTo(0.928624, 5);
    expect(hp.a1).toBeCloseTo(-1.852146, 5);
    expect(hp.a2).toBeCloseTo(0.862349, 5);
    const lp = lowpass(30, 4);
    expect(lp.b0).toBeCloseTo(0.108447, 5);
    expect(lp.b1).toBeCloseTo(0.216895, 5);
    expect(lp.b2).toBeCloseTo(0.108447, 5);
    expect(lp.a1).toBeCloseTo(-0.877271, 5);
    expect(lp.a2).toBeCloseTo(0.31106, 5);
  });

  it('band-pass 0.5–4 Hz at 60 Hz passes the pulse band and rejects drift and noise', () => {
    const bp = butterworthBandpass(60, 0.5, 4);
    expect(magnitudeAt(bp, 60, 1.5)).toBeGreaterThan(0.9);
    expect(magnitudeAt(bp, 60, 0.5)).toBeCloseTo(Math.SQRT1_2, 1);
    expect(magnitudeAt(bp, 60, 4)).toBeCloseTo(Math.SQRT1_2, 1);
    expect(magnitudeAt(bp, 60, 0.05)).toBeLessThan(0.02);
    expect(magnitudeAt(bp, 60, 20)).toBeLessThan(0.05);
  });
});

describe('filtering', () => {
  it('filtfilt is zero-phase on a pulse-band sine', () => {
    const fs = 60;
    const n = 20 * fs;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1.2 * (i / fs)) + 5;
    const y = filtfilt(x, butterworthBandpass(fs, 0.5, 4), fs);
    // compare peak positions in the middle of the record
    const argmax = (a: ArrayLike<number>, lo: number, hi: number) => {
      let b = lo;
      for (let i = lo; i < hi; i++) if (a[i] > a[b]) b = i;
      return b;
    };
    const px = argmax(x, 10 * fs, 10 * fs + 50);
    const py = argmax(y, 10 * fs, 10 * fs + 50);
    expect(Math.abs(px - py)).toBeLessThanOrEqual(1);
    expect(y[px]).toBeGreaterThan(0.85);
  });

  it('causal high-pass starts without a DC transient when initialised', () => {
    const y = filterCausal(new Float64Array(100).fill(120), [highpass(60, 0.5)], true);
    for (let i = 0; i < 100; i++) expect(Math.abs(y[i])).toBeLessThan(1e-9);
    const yNoInit = filterCausal(new Float64Array(100).fill(120), [highpass(60, 0.5)], false);
    expect(Math.abs(yNoInit[0])).toBeGreaterThan(50);
  });

  it('moving average and linear detrend behave', () => {
    const ma = movingAverage([1, 2, 3, 4, 5], 3);
    expect(Array.from(ma)).toEqual([1.5, 2, 3, 4, 4.5]);
    const d = detrendLinear([1, 3, 5, 7]);
    for (const v of d) expect(Math.abs(v)).toBeLessThan(1e-12);
  });
});
