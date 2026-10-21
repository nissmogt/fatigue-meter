import { describe, expect, it } from 'vitest';
import { classifyFinger, fingerPresent, fingerState, isStable, luminance, redRatio } from '../../src/capture/finger';
import { LOW_FPS_LIMIT, STABLE_MEAN_DELTA_MAX, STABLE_STEP_MAX } from '../../src/capture/config';
import { analyzePPG } from '../../src/dsp/pipeline-impl';
import { generateSynthetic } from '../../src/dsp/synthetic';
import { fromSeries, type Sample } from '../../src/dsp/types';

const mk = (r: number, g: number, b: number, sat = 0, t = 0): Sample => ({ t, r, g, b, sat, frame: 0 });

/** n samples at 30 fps with a constant red level (ambient-neutral g/b). */
function flat(n: number, r: number, t0 = 0): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) out.push(mk(r, 70, 50, 0, t0 + i / 30));
  return out;
}

describe('colour helpers', () => {
  it('computes red ratio and luminance', () => {
    expect(redRatio(mk(180, 70, 50))).toBeCloseTo(0.6, 6);
    expect(redRatio(mk(0, 0, 0))).toBe(0);
    expect(luminance(mk(100, 100, 100))).toBeCloseTo(100, 6);
  });
});

describe('fingerPresent', () => {
  it('torch mode accepts a transilluminated fingertip', () => {
    expect(fingerPresent(mk(180, 70, 50), 'torch')).toBe(true);
    expect(fingerPresent(mk(60, 20, 10), 'torch')).toBe(true); // lower edge of brightness
    expect(fingerPresent(mk(254, 100, 60), 'torch')).toBe(true); // upper edge
  });

  it('torch mode rejects table-top, dark, clipped and weakly red frames', () => {
    expect(fingerPresent(mk(95, 100, 105), 'torch')).toBe(false); // grey table
    expect(fingerPresent(mk(40, 10, 5), 'torch')).toBe(false); // too dark
    expect(fingerPresent(mk(255, 120, 100, 1), 'torch')).toBe(false); // clipped
    expect(fingerPresent(mk(120, 100, 30), 'torch')).toBe(false); // r/g < 1.5
    expect(fingerPresent(mk(100, 90, 80), 'torch')).toBe(false); // red ratio < 0.40
  });

  it('ambient mode needs r > g > b, enough red share and mid luminance', () => {
    expect(fingerPresent(mk(120, 80, 60), 'ambient')).toBe(true);
    expect(fingerPresent(mk(120, 130, 60), 'ambient')).toBe(false); // g > r
    expect(fingerPresent(mk(120, 60, 80), 'ambient')).toBe(false); // b > g
    expect(fingerPresent(mk(20, 5, 3), 'ambient')).toBe(false); // luma ≈ 9
    expect(fingerPresent(mk(250, 245, 240), 'ambient')).toBe(false); // luma > 240
    expect(fingerPresent(mk(120, 80, 60, 0.7), 'ambient')).toBe(false); // mostly clipped pixels
  });
});

describe('classifyFinger', () => {
  it('reports ok / saturated / too-dark / no-finger', () => {
    expect(classifyFinger(mk(180, 70, 50), 'torch')).toEqual({ on: true, reason: 'ok' });
    expect(classifyFinger(mk(255, 120, 100, 1), 'torch')).toEqual({ on: false, reason: 'saturated' });
    expect(classifyFinger(mk(200, 90, 60, 0.6), 'torch')).toEqual({ on: false, reason: 'saturated' });
    expect(classifyFinger(mk(30, 8, 5), 'torch')).toEqual({ on: false, reason: 'too-dark' });
    expect(classifyFinger(mk(95, 100, 105), 'torch')).toEqual({ on: false, reason: 'no-finger' });
    expect(classifyFinger(mk(8, 4, 2), 'ambient')).toEqual({ on: false, reason: 'too-dark' });
    expect(classifyFinger(mk(250, 245, 240), 'ambient')).toEqual({ on: false, reason: 'saturated' });
    expect(classifyFinger(mk(95, 100, 105), 'ambient')).toEqual({ on: false, reason: 'no-finger' });
  });
});

describe('isStable', () => {
  it('is false until the window is filled', () => {
    expect(isStable([])).toBe(false);
    expect(isStable(flat(1, 150))).toBe(false);
    expect(isStable(flat(30, 150))).toBe(false); // 1 s of a 2-s window
    expect(isStable(flat(61, 150))).toBe(true); // 2 s
  });

  it('is true for clean synthetic PPG', () => {
    const samples = fromSeries(generateSynthetic({ seed: 1, durationS: 6 }).series);
    expect(isStable(samples)).toBe(true);
  });

  it('is false across a finger-off step inside the window', () => {
    const all = fromSeries(generateSynthetic({ seed: 3, durationS: 6, fingerOffWindows: [[3, 10]] }).series);
    const upTo4 = all.filter((s) => s.t <= 4); // window [2, 4] straddles the step at 3 s
    expect(isStable(upTo4)).toBe(false);
    const before = all.filter((s) => s.t < 3); // entirely finger-on
    expect(isStable(before)).toBe(true);
  });

  it('is false on a slow drift between the two halves', () => {
    const a = flat(30, 150, 0);
    const b = flat(31, 150, 1);
    // ramp one level per frame so no single step exceeds the limit, yet the
    // second half's mean ends up well above the first's
    const rise = 2 * STABLE_MEAN_DELTA_MAX;
    for (let i = 0; i < b.length; i++) b[i].r = 150 + Math.min(i, rise);
    const meanB = b.reduce((s, x) => s + x.r, 0) / b.length;
    expect(Math.abs(meanB - 150)).toBeGreaterThan(STABLE_MEAN_DELTA_MAX);
    expect(isStable([...a, ...b])).toBe(false);
  });

  it('is false on a single-frame DC step even when the means agree', () => {
    const s = flat(61, 150);
    s[30].r += STABLE_STEP_MAX + 1; // one-frame spike: up and back down
    expect(isStable(s)).toBe(false);
    const ok = flat(61, 150);
    ok[30].r += STABLE_STEP_MAX; // at the limit is still stable
    expect(isStable(ok)).toBe(true);
  });
});

describe('fingerState', () => {
  it('combines presence of the last sample with window stability', () => {
    expect(fingerState([], 'torch')).toEqual({ on: false, reason: 'no-finger' });
    const stable = flat(61, 180);
    expect(fingerState(stable, 'torch')).toEqual({ on: true, reason: 'ok' });
    const moving = flat(61, 180);
    moving[45].r = 200;
    expect(fingerState(moving, 'torch')).toEqual({ on: true, reason: 'moving' });
    const lifted = [...flat(60, 180), mk(95, 100, 105, 0, 2)];
    expect(fingerState(lifted, 'torch')).toEqual({ on: false, reason: 'no-finger' });
  });
});

describe('LOW_FPS_LIMIT (capture/config) is a rate the DSP still scores correctly', () => {
  // The camera source aborts below this delivered rate (Chrome on Android drops
  // to 12-20 fps in a dark torch-less scene); the limit must therefore sit at a
  // rate the pipeline still analyses accurately, not at the nominal 30 fps.
  const START = 3;
  const END = 63;

  function truth(beatTimes: Float64Array) {
    const inside = Array.from(beatTimes).filter((t) => t >= START - 0.05 && t <= END + 0.05);
    const ms: number[] = [];
    for (let i = 1; i < inside.length; i++) ms.push((inside[i] - inside[i - 1]) * 1000);
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    let sq = 0;
    for (let i = 1; i < ms.length; i++) sq += (ms[i] - ms[i - 1]) ** 2;
    return { hr: 60000 / mean, rmssd: Math.sqrt(sq / (ms.length - 1)) };
  }

  it.each([1, 2, 3])('a clean recording at exactly the limit passes the gate (seed %i)', (seed) => {
    const syn = generateSynthetic({ seed, durationS: 70, fps: LOW_FPS_LIMIT });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
    const t = truth(syn.beatTimes);
    expect(res.fsSource).toBeCloseTo(LOW_FPS_LIMIT, 0);
    expect(res.quality.verdict).toBe('full');
    expect(res.time).not.toBeNull();
    expect(Math.abs(res.time!.meanHR - t.hr)).toBeLessThan(0.5);
    expect(Math.abs(res.time!.rmssd - t.rmssd) / t.rmssd).toBeLessThan(0.2);
  });
});
