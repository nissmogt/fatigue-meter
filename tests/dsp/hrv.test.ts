import { describe, expect, it } from 'vitest';
import { bandPower, frequencyDomain, lombScargle, timeDomain, welchLikePsd } from '../../src/dsp/hrv';
import { cleanIntervals } from '../../src/dsp/ibi';
import { DEFAULT_ANALYSIS_OPTIONS } from '../../src/dsp/pipeline';

function sinusoidBeats(durationS: number, rr0 = 0.9, aLf = 20, aHf = 30, fHf = 0.25): Float64Array {
  const beats: number[] = [];
  let t = 0.3;
  while (t < durationS) {
    beats.push(t);
    const rr = rr0 * 1000 + aLf * Math.sin(2 * Math.PI * 0.1 * t + 0.4) + aHf * Math.sin(2 * Math.PI * fHf * t + 1.1);
    t += rr / 1000;
  }
  return Float64Array.from(beats);
}

describe('interval cleaning', () => {
  it('rejects an ectopic couplet instead of merging it into a fabricated interval', () => {
    // 60 beats at 1 s; beats 21 and 22 come early: intervals 600, 600, 1800 ms.
    // Their sum (1200) is 20 % off the rhythm, so this is not a false extra
    // peak; all three intervals must be rejected and RMSSD stay 0.
    const beats = Array.from({ length: 60 }, (_, i) => i);
    beats[21] = 20.6;
    beats[22] = 21.2;
    const nn = cleanIntervals(beats, DEFAULT_ANALYSIS_OPTIONS.nn);
    expect(nn.ms.length).toBe(59);
    const rejected: number[] = [];
    for (let i = 0; i < nn.ms.length; i++) if (!nn.accepted[i]) rejected.push(i);
    expect(rejected).toEqual([20, 21, 22]);
    expect(Array.from(nn.ms.subarray(20, 23)).map(Math.round)).toEqual([600, 600, 1800]);
    expect(timeDomain(nn)!.rmssd).toBe(0);
    // A genuine false extra peak (350 + 650 = 1000 ms) is still merged away with zero rejections.
    const extra = Array.from({ length: 60 }, (_, i) => i);
    extra.splice(21, 0, 20.35);
    const nn2 = cleanIntervals(extra, DEFAULT_ANALYSIS_OPTIONS.nn);
    expect(nn2.ms.length).toBe(59);
    expect(nn2.acceptedCount).toBe(59);
    expect(timeDomain(nn2)!.rmssd).toBe(0);
  });

  it('rejects out-of-range and outlying intervals', () => {
    const beats = [0, 0.9, 1.8, 2.7, 3.3, 4.5, 5.4, 6.3, 7.2, 9.5, 10.4];
    const nn = cleanIntervals(beats, DEFAULT_ANALYSIS_OPTIONS.nn);
    expect(nn.ms.length).toBe(10);
    // 3.3 is early (600 ms) and 4.5 late (1200 ms): both deviate > 25 % from the 900 ms median
    expect(nn.accepted[3]).toBe(0);
    expect(nn.accepted[4]).toBe(0);
    // 9.5 − 7.2 = 2300 ms is out of bounds
    expect(nn.accepted[8]).toBe(0);
    expect(nn.accepted[0]).toBe(1);
    expect(nn.acceptedCount).toBe(7);
    expect(nn.longestGapS).toBeCloseTo(2.3, 6);
  });
});

describe('time domain', () => {
  it('computes RMSSD only across adjacent accepted intervals', () => {
    const beats = [0, 1.0, 2.0, 3.0, 4.0, 5.0];
    const nn = cleanIntervals(beats, DEFAULT_ANALYSIS_OPTIONS.nn);
    const td = timeDomain(nn)!;
    expect(td.meanNN).toBeCloseTo(1000, 6);
    expect(td.meanHR).toBeCloseTo(60, 6);
    expect(td.rmssd).toBe(0);
    const beats2 = [0, 1.0, 2.05, 3.0, 4.05, 5.0];
    const td2 = timeDomain(cleanIntervals(beats2, DEFAULT_ANALYSIS_OPTIONS.nn))!;
    // successive differences: +50, -100, +100, -100 → rmssd = sqrt((2500+10000+10000+10000)/4)
    expect(td2.rmssd).toBeCloseTo(Math.sqrt(32500 / 4), 3);
    expect(td2.pnn50).toBeCloseTo(75, 6);
  });
});

describe('Lomb-Scargle', () => {
  it('recovers LF and HF band powers of a sinusoidal RR series and integrates to the variance', () => {
    const beats = sinusoidBeats(300);
    const nn = cleanIntervals(beats, DEFAULT_ANALYSIS_OPTIONS.nn);
    const fd = frequencyDomain(nn, DEFAULT_ANALYSIS_OPTIONS.spectrum)!;
    expect(fd.lf).toBeGreaterThan(200 * 0.85);
    expect(fd.lf).toBeLessThan(200 * 1.15);
    expect(fd.hf).toBeGreaterThan(450 * 0.85);
    expect(fd.hf).toBeLessThan(450 * 1.15);
    expect(fd.lfHf).toBeGreaterThan((200 / 450) * 0.8);
    expect(fd.lfHf).toBeLessThan((200 / 450) * 1.2);
    expect(fd.respHz).toBeCloseTo(0.25, 1);
    const total = bandPower(fd.psd.f, fd.psd.p, fd.psd.f[0], fd.psd.f[fd.psd.f.length - 1]);
    const ms: number[] = [];
    for (let i = 0; i < nn.ms.length; i++) if (nn.accepted[i]) ms.push(nn.ms[i]);
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    const v = ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1);
    expect(Math.abs(total - v) / v).toBeLessThan(0.03);
  });

  it('agrees with a 4 Hz-resampled Hann periodogram within 15 % per band on a 60 s record', () => {
    const beats = sinusoidBeats(62);
    const nn = cleanIntervals(beats, DEFAULT_ANALYSIS_OPTIONS.nn);
    const fd = frequencyDomain(nn, DEFAULT_ANALYSIS_OPTIONS.spectrum)!;
    const w = welchLikePsd(nn.t, nn.ms, 4);
    const lfW = bandPower(w.f, w.p, 0.04, 0.15);
    const hfW = bandPower(w.f, w.p, 0.15, 0.4);
    expect(Math.abs(fd.hf - hfW) / hfW).toBeLessThan(0.15);
    expect(Math.abs(fd.lf - lfW) / lfW).toBeLessThan(0.15);
    expect(fd.lfBins).toBeCloseTo((nn.t[nn.t.length - 1] - nn.t[0]) * 0.11, 6);
  });

  it('reports the respiratory peak, not the band edge, when a 0.1 Hz Mayer wave dominates (120 s)', () => {
    // LF/HF ≈ 4 with the LF tone at exactly 0.10 Hz: the skirt of that peak
    // enters the 0.1–0.5 Hz search band taller than the 0.20 Hz breathing
    // peak, so a plain argmax returned 0.101 Hz and flagged the stress reading.
    const beats = sinusoidBeats(120, 0.9, 40, 20, 0.2);
    const nn = cleanIntervals(beats, DEFAULT_ANALYSIS_OPTIONS.nn);
    const fd = frequencyDomain(nn, DEFAULT_ANALYSIS_OPTIONS.spectrum)!;
    expect(fd.respHz).toBeCloseTo(0.2, 2);
    expect(Math.abs(fd.lfHf - 4) / 4).toBeLessThan(0.3);
  });

  it('unnormalised periodogram peaks at the injected frequency', () => {
    const t = Float64Array.from({ length: 200 }, (_, i) => i * 0.9);
    const x = Float64Array.from(t, (v) => 10 * Math.sin(2 * Math.PI * 0.25 * v));
    const f = Float64Array.from({ length: 100 }, (_, i) => 0.005 * (i + 1));
    const p = lombScargle(t, x, f);
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    expect(f[best]).toBeCloseTo(0.25, 2);
  });
});
