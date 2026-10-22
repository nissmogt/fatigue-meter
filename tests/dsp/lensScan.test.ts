import { describe, expect, it } from 'vitest';
import { findRemembered, rearCandidates, scoreLensSeries, MIN_USABLE_SCORE } from '../../src/capture/lensScan';
import { generateSynthetic, syntheticPreset } from '../../src/dsp/synthetic';
import { sliceSeriesByTime } from '../../src/dsp/types';

describe('lens scan scoring', () => {
  it('scores a clean pulse high and a finger-off lens zero', () => {
    const clean = generateSynthetic({ seed: 5, durationS: 4 });
    const good = scoreLensSeries(sliceSeriesByTime(clean.series, 1, 3.5));
    expect(good.fingerFraction).toBe(1);
    expect(good.periodicity).toBeGreaterThan(0.5);
    expect(good.score).toBeGreaterThan(MIN_USABLE_SCORE);
    const off = generateSynthetic({ seed: 5, durationS: 4, fingerOffWindows: [[0, 4]] });
    const none = scoreLensSeries(sliceSeriesByTime(off.series, 1, 3.5));
    expect(none.fingerFraction).toBe(0);
    expect(none.score).toBe(0);
  });

  it('prefers the lens with the stronger, more periodic pulse', () => {
    const lit = generateSynthetic({ seed: 8, durationS: 4 });
    const dim = generateSynthetic({ seed: 8, durationS: 4, acFractionR: 0.003, acFractionG: 0.004, noiseSd: 0.6 });
    const a = scoreLensSeries(sliceSeriesByTime(lit.series, 1, 3.5));
    const b = scoreLensSeries(sliceSeriesByTime(dim.series, 1, 3.5));
    expect(a.score).toBeGreaterThan(b.score);
    const poor = generateSynthetic({ ...syntheticPreset('poor', 8), durationS: 4 });
    const c = scoreLensSeries(sliceSeriesByTime(poor.series, 1, 3.5));
    expect(c.score).toBeLessThan(a.score);
  });

  it('handles tiny windows without throwing', () => {
    const s = generateSynthetic({ seed: 1, durationS: 2 });
    expect(scoreLensSeries(sliceSeriesByTime(s.series, 0, 0.1)).score).toBe(0);
  });
});

describe('rear candidates and remembered lens', () => {
  const iphonePro = [
    { deviceId: 'f', label: 'Front Camera' },
    { deviceId: 'b', label: 'Back Camera' },
    { deviceId: 't', label: 'Back Triple Camera' },
    { deviceId: 'u', label: 'Back Ultra Wide Camera' },
    { deviceId: 'z', label: 'Back Telephoto Camera' },
  ];

  it('keeps physical rear lenses and drops front and virtual multi-lens devices', () => {
    expect(rearCandidates(iphonePro).map((d) => d.deviceId)).toEqual(['b', 'u', 'z']);
    const android = [
      { deviceId: '0', label: 'camera2 0, facing back' },
      { deviceId: '1', label: 'camera2 1, facing front' },
      { deviceId: '2', label: 'camera2 2, facing back' },
    ];
    expect(rearCandidates(android).map((d) => d.deviceId)).toEqual(['0', '2']);
  });

  it('falls back to every non-front device when labels are missing and caps the list', () => {
    const unlabelled = [
      { deviceId: 'a', label: '' },
      { deviceId: 'b', label: '' },
    ];
    expect(rearCandidates(unlabelled).map((d) => d.deviceId)).toEqual(['a', 'b']);
    const many = Array.from({ length: 6 }, (_, i) => ({ deviceId: String(i), label: `Back Camera ${i}` }));
    expect(rearCandidates(many)).toHaveLength(4);
    expect(rearCandidates([{ deviceId: 'fake', label: 'fake_device_0' }])).toHaveLength(1);
  });

  it('resolves a remembered lens by id, then by label (ids rotate on iOS)', () => {
    expect(findRemembered(iphonePro, 'z', null)?.label).toBe('Back Telephoto Camera');
    expect(findRemembered(iphonePro, 'stale', 'Back Telephoto Camera')?.deviceId).toBe('z');
    expect(findRemembered(iphonePro, 'stale', 'Nope')).toBeNull();
    expect(findRemembered(iphonePro, null, null)).toBeNull();
  });
});
