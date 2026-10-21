import { describe, expect, it } from 'vitest';
import { CubicSpline, estimateFs, gapStats, resampleSpline } from '../../src/dsp/resample';
import { makeGaussian, mulberry32 } from '../../src/dsp/synthetic';

describe('resampling', () => {
  it('natural cubic spline reproduces a 1.5 Hz sine sampled at 30 Hz to within 1e-3 (interior)', () => {
    const fs = 30;
    const n = 300;
    const t = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      y[i] = Math.sin(2 * Math.PI * 1.5 * t[i]);
    }
    const s = new CubicSpline(t, y);
    let maxErr = 0;
    for (let k = 60; k < 540; k++) {
      const tk = k / 60;
      maxErr = Math.max(maxErr, Math.abs(s.at(tk) - Math.sin(2 * Math.PI * 1.5 * tk)));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('estimates fs from a jittered grid and counts dropped frames', () => {
    const rng = mulberry32(5);
    const g = makeGaussian(rng);
    const t: number[] = [];
    for (let k = 0; k < 300; k++) {
      if (k % 50 === 25) continue; // 6 dropped frames
      t.push(k / 30 + 0.002 * g());
    }
    t.sort((a, b) => a - b);
    expect(estimateFs(t)).toBeGreaterThan(29);
    expect(estimateFs(t)).toBeLessThan(31);
    const gs = gapStats(t, 30);
    expect(gs.dropFraction).toBeGreaterThan(0.015);
    expect(gs.dropFraction).toBeLessThan(0.03);
    expect(gs.longestGapS).toBeGreaterThan(0.06);
    expect(gs.longestGapS).toBeLessThan(0.08);
  });

  it('resampleSpline produces a uniform grid covering the input span', () => {
    const t = [0, 0.03, 0.07, 0.1, 0.13, 0.17, 0.2];
    const x = t.map((v) => v * 10);
    const u = resampleSpline(t, x, 60);
    expect(u.t0).toBe(0);
    expect(u.y.length).toBe(13);
    expect(u.y[6]).toBeCloseTo(1, 1);
  });
});
