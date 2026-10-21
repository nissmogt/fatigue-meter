import { describe, expect, it } from 'vitest';
import { generateSynthetic, mulberry32, syntheticPreset } from '../../src/dsp/synthetic';

describe('synthetic generator', () => {
  it('is deterministic for a seed', () => {
    const a = generateSynthetic({ seed: 42, durationS: 20 });
    const b = generateSynthetic({ seed: 42, durationS: 20 });
    expect(Array.from(a.series.r)).toEqual(Array.from(b.series.r));
    expect(Array.from(a.beatTimes)).toEqual(Array.from(b.beatTimes));
    const c = generateSynthetic({ seed: 43, durationS: 20 });
    expect(Array.from(c.series.r)).not.toEqual(Array.from(a.series.r));
  });

  it('produces a plausible frame grid and RR series', () => {
    const s = generateSynthetic({ seed: 1, durationS: 70, fps: 30 });
    expect(s.series.length).toBeGreaterThan(70 * 30 * 0.95);
    expect(s.series.length).toBeLessThanOrEqual(70 * 30);
    for (let i = 1; i < s.series.length; i++) expect(s.series.t[i]).toBeGreaterThan(s.series.t[i - 1]);
    expect(s.actual.meanHR).toBeGreaterThan(60);
    expect(s.actual.meanHR).toBeLessThan(72);
    expect(s.actual.sdnn).toBeGreaterThan(20);
    expect(s.actual.sdnn).toBeLessThan(45);
    expect(s.actual.rmssd).toBeGreaterThan(15);
    // Camera polarity: systole is darker, so the red mean dips at beat times.
    const t0 = s.beatTimes[10];
    const idx = Array.from(s.series.t).findIndex((t) => t >= t0);
    const atBeat = s.series.r[idx];
    const between = s.series.r[idx + 12];
    expect(atBeat).toBeLessThan(between);
    expect(s.expected.lfHf).toBeCloseTo((20 / 30) ** 2, 6);
  });

  it('supports presets and finger-off windows', () => {
    const sat = generateSynthetic(syntheticPreset('saturated', 7));
    expect(sat.series.r[0]).toBe(255);
    expect(sat.series.sat[0]).toBe(1);
    const off = generateSynthetic({ seed: 3, durationS: 10, fingerOffWindows: [[2, 4]] });
    const i = Array.from(off.series.t).findIndex((t) => t >= 3);
    expect(off.series.r[i]).toBeLessThan(120);
    expect(off.series.g[i]).toBeGreaterThan(off.series.r[i] - 10);
  });

  it('mulberry32 is uniform-ish', () => {
    const rng = mulberry32(99);
    let s = 0;
    for (let i = 0; i < 10000; i++) s += rng();
    expect(s / 10000).toBeGreaterThan(0.48);
    expect(s / 10000).toBeLessThan(0.52);
  });
});
