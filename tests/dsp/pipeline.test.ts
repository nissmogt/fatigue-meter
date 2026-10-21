import { describe, expect, it } from 'vitest';
import { analyzePPG, liveSnapshot } from '../../src/dsp/pipeline-impl';
import { generateSynthetic, syntheticPreset } from '../../src/dsp/synthetic';
import { sliceSeriesByTime } from '../../src/dsp/types';

const START = 3;
const END = 63;

function stats(ms: number[]) {
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const sdnn = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1));
  let sq = 0;
  for (let i = 1; i < ms.length; i++) sq += (ms[i] - ms[i - 1]) ** 2;
  return { mean, sdnn, rmssd: Math.sqrt(sq / (ms.length - 1)), hr: 60000 / mean };
}

function truthInWindow(beatTimes: Float64Array) {
  const inside = Array.from(beatTimes).filter((t) => t >= START - 0.05 && t <= END + 0.05);
  const ms: number[] = [];
  for (let i = 1; i < inside.length; i++) ms.push((inside[i] - inside[i - 1]) * 1000);
  return { beats: inside, ...stats(ms) };
}

function quantisedTruth(beats: number[], stepS: number) {
  const q = beats.map((b) => Math.round(b / stepS) * stepS);
  const ms: number[] = [];
  for (let i = 1; i < q.length; i++) ms.push((q[i] - q[i - 1]) * 1000);
  return stats(ms);
}

describe('analyzePPG on synthetic camera PPG (30 fps)', () => {
  const syn = generateSynthetic({ seed: 42, durationS: 70 });
  const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
  const truth = truthInWindow(syn.beatTimes);

  it('passes the quality gate on a clean recording', () => {
    expect(res.quality.reasons).toEqual([]);
    expect(res.quality.verdict).toBe('full');
    expect(['r', 'g']).toContain(res.channel);
    expect(res.fsSource).toBeGreaterThan(28);
    expect(res.fsSource).toBeLessThan(32);
    expect(res.quality.acceptedFraction).toBeGreaterThanOrEqual(0.95);
    expect(res.quality.goodFraction).toBeGreaterThanOrEqual(50 / 60);
    expect(res.quality.templateCorr).toBeGreaterThan(0.9);
  });

  it('finds every beat with sub-frame timing (jitter < 8 ms, bias < 10 ms)', () => {
    expect(Math.abs(res.peaks.length - truth.beats.length)).toBeLessThanOrEqual(1);
    const errs: number[] = [];
    for (const p of res.peaks) {
      let best = Infinity;
      for (const b of truth.beats) if (Math.abs(p - b) < Math.abs(best)) best = p - b;
      if (Math.abs(best) < 0.15) errs.push(best * 1000);
    }
    expect(errs.length).toBeGreaterThanOrEqual(truth.beats.length - 1);
    const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
    const sd = Math.sqrt(errs.reduce((a, b) => a + (b - bias) ** 2, 0) / errs.length);
    // A constant offset does not change intervals; the jitter is what matters for HRV.
    expect(Math.abs(bias)).toBeLessThan(10);
    expect(sd).toBeLessThan(8);
  });

  it('matches ground-truth HR, RMSSD and SDNN and removes the 33 ms quantisation floor', () => {
    const td = res.time!;
    expect(Math.abs(td.meanHR - truth.hr)).toBeLessThan(0.5);
    expect(Math.abs(td.rmssd - truth.rmssd) / truth.rmssd).toBeLessThan(0.1);
    expect(Math.abs(td.sdnn - truth.sdnn) / truth.sdnn).toBeLessThan(0.1);
    const q = quantisedTruth(truth.beats, 1 / 30);
    // Raw 30 fps quantisation would inflate RMSSD noticeably; the pipeline must do better.
    expect(Math.abs(q.rmssd - truth.rmssd) / truth.rmssd).toBeGreaterThan(0.15);
  });

  it('recovers LF, HF and LF/HF within tolerance', () => {
    const fd = res.freq!;
    expect(Math.abs(fd.hf - syn.expected.hf) / syn.expected.hf).toBeLessThan(0.2);
    expect(Math.abs(fd.lf - syn.expected.lf) / syn.expected.lf).toBeLessThan(0.3);
    expect(Math.abs(fd.lfHf - syn.expected.lfHf) / syn.expected.lfHf).toBeLessThan(0.3);
    expect(fd.lfBins).toBeGreaterThan(6);
    expect(fd.lfBins).toBeLessThan(7);
    expect(Number.isFinite(fd.lnLfPlusHf)).toBe(true);
  });

  it('stores a display waveform over the window at 60 Hz', () => {
    expect(res.waveform.length).toBe(60 * 60 + 1);
    expect(res.fsUniform).toBe(60);
  });
});

describe('analyzePPG edge cases', () => {
  it('fails a poor recording with reasons', () => {
    const syn = generateSynthetic({ ...syntheticPreset('poor', 9), durationS: 70 });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
    expect(res.quality.verdict).toBe('fail');
    expect(res.quality.reasons.length).toBeGreaterThan(0);
  });

  it('falls back to green when red is saturated and never throws on tiny input', () => {
    const syn = generateSynthetic({ ...syntheticPreset('saturated', 3), durationS: 70 });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
    expect(res.channel).toBe('g');
    expect(res.quality.verdict).toBe('full');
    const tiny = analyzePPG(sliceSeriesByTime(syn.series, 0, 1));
    expect(tiny.quality.verdict).toBe('fail');
    expect(tiny.quality.reasons).toContain('too-short');
  });

  it('rejects the two intervals around each injected ectopic beat and downgrades to time-only', () => {
    const syn = generateSynthetic({ seed: 11, durationS: 70, ectopicBeats: [20, 40, 55] });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
    const rejected = res.nn.accepted.length - res.quality.acceptedBeats;
    expect(rejected).toBeGreaterThanOrEqual(5);
    expect(rejected).toBeLessThanOrEqual(8);
    expect(res.quality.verdict).toBe('time-only');
    expect(res.time!.rmssd).toBeLessThan(40);
  });

  it('merges a false extra peak instead of rejecting four intervals', () => {
    const syn = generateSynthetic({ seed: 42, durationS: 70, noiseSd: 0.3 });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END }, channel: 'g' });
    expect(res.quality.acceptedFraction).toBeGreaterThanOrEqual(0.97);
    expect(res.quality.verdict).toBe('full');
  });

  it('tolerates a dropped pulse (missed beat) by rejecting the long interval', () => {
    const syn = generateSynthetic({ seed: 11, durationS: 70, missedBeats: [20, 40] });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
    const rejected = res.nn.accepted.length - res.quality.acceptedBeats;
    expect(rejected).toBe(2);
    expect(res.quality.verdict).toBe('full');
  });

  it('reports a long gap when the finger leaves the lens', () => {
    const syn = generateSynthetic({ seed: 12, durationS: 70, fingerOffWindows: [[30, 36]] });
    const res = analyzePPG(syn.series, { window: { startS: START, endS: END } });
    expect(res.quality.longestGapS).toBeGreaterThan(3);
    expect(res.quality.reasons).toContain('long-gap');
  });
});

describe('liveSnapshot', () => {
  it('reports a good signal with a plausible heart rate on clean data', () => {
    const syn = generateSynthetic({ seed: 42, durationS: 20 });
    const snap = liveSnapshot(syn.series, 8);
    expect(snap.fingerOn).toBe(true);
    expect(snap.fingerReason).toBe('ok');
    expect(snap.quality).toBe('good');
    expect(snap.hrBpm).toBeGreaterThan(62);
    expect(snap.hrBpm).toBeLessThan(72);
    expect(snap.wave.length).toBeGreaterThan(400);
  });

  it('detects no finger and a step change', () => {
    const off = generateSynthetic({ seed: 2, durationS: 12, fingerOffWindows: [[6, 12]] });
    const snap = liveSnapshot(off.series, 8);
    expect(snap.fingerOn).toBe(false);
    expect(snap.fingerReason).toBe('no-finger');
    expect(snap.quality).toBe('none');
    const brief = generateSynthetic({ seed: 2, durationS: 12, fingerOffWindows: [[10.5, 11.2]] });
    const snap2 = liveSnapshot(brief.series, 8);
    expect(snap2.quality).not.toBe('good');
  });
});
