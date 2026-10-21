import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../../src/dsp/pipeline';
import { muLnHF, muLnLfHf, muLnLfPlusHf, muLnRmssd } from '../../src/scoring/norms';
import {
  RECOVERY_LABELS,
  ageFromProfile,
  compareScores,
  fatigueLevelFromT,
  recoveryLevelFromT,
  scoreInputFromAnalysis,
  scoreMeasurement,
  stressIsProvisional,
  stressLevelFromRatio,
} from '../../src/scoring/score';
import type { Profile, ScoreInput, Scores } from '../../src/scoring/types';
import { S } from '../../src/strings';

const NOW = new Date(2026, 5, 15);
const AGE40: Profile = { birthYear: 2026 - 40, sex: 'male', acceptedAt: 0 };

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    lnLfPlusHf: 5.5,
    lnHf: muLnHF(40),
    lnRmssd: muLnRmssd(40),
    lnLfHf: muLnLfHf(40, 'male'),
    lfHf: 1.0,
    meanHR: 65,
    lfBins: 10,
    durationS: 120,
    quality: 'full',
    respHz: 0.25,
    ...over,
  };
}

function fakeAnalysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    version: '2026.10.1',
    fsSource: 30,
    fsUniform: 60,
    channel: 'g',
    channelReason: 'test',
    t0: 0,
    durationS: 60,
    waveform: new Float32Array(0),
    peaks: new Float64Array(0),
    nn: { t: new Float64Array(0), ms: new Float64Array(0), accepted: new Uint8Array(0) },
    time: { nBeats: 60, meanNN: 900, meanHR: 66.7, sdnn: 40, rmssd: 35, lnRmssd: Math.log(35), pnn50: 10, cvnn: 0.04, sd1: 25, sd2: 50 },
    freq: {
      lf: 200,
      hf: 450,
      tp: 650,
      lfHf: 200 / 450,
      lfNu: 30,
      hfNu: 70,
      lnLf: Math.log(200),
      lnHf: Math.log(450),
      lnLfPlusHf: Math.log(650),
      lnLfHf: Math.log(200 / 450),
      dfHz: 0.004,
      lfBins: 6,
      respHz: 0.25,
      psd: { f: new Float64Array(0), p: new Float64Array(0) },
    },
    quality: {
      acceptedBeats: 60,
      totalBeats: 60,
      acceptedFraction: 1,
      longestGapS: 1,
      dropFraction: 0,
      goodFraction: 1,
      templateCorr: 0.95,
      perfusion: 2,
      skewness: 0.5,
      periodicity: 0.9,
      verdict: 'full',
      reasons: [],
    },
    ...over,
  };
}

describe('level cut points', () => {
  it('maps T to fatigue levels at 58/50/42/37', () => {
    expect(fatigueLevelFromT(80)).toBe(1);
    expect(fatigueLevelFromT(58)).toBe(1);
    expect(fatigueLevelFromT(57.9)).toBe(2);
    expect(fatigueLevelFromT(50)).toBe(2);
    expect(fatigueLevelFromT(49.9)).toBe(3);
    expect(fatigueLevelFromT(42)).toBe(3);
    expect(fatigueLevelFromT(41.9)).toBe(4);
    expect(fatigueLevelFromT(37)).toBe(4);
    expect(fatigueLevelFromT(36.9)).toBe(5);
    expect(fatigueLevelFromT(20)).toBe(5);
  });

  it('maps LF/HF to stress levels at 0.8/2.0/3.5/5.0', () => {
    expect(stressLevelFromRatio(0)).toBe(1);
    expect(stressLevelFromRatio(0.79)).toBe(1);
    expect(stressLevelFromRatio(0.8)).toBe(2);
    expect(stressLevelFromRatio(1.99)).toBe(2);
    expect(stressLevelFromRatio(2.0)).toBe(3);
    expect(stressLevelFromRatio(3.49)).toBe(3);
    expect(stressLevelFromRatio(3.5)).toBe(4);
    expect(stressLevelFromRatio(4.99)).toBe(4);
    expect(stressLevelFromRatio(5.0)).toBe(5);
    expect(stressLevelFromRatio(12)).toBe(5);
  });

  it('inverts the fatigue levels for recovery', () => {
    expect(recoveryLevelFromT(80)).toBe(5);
    expect(recoveryLevelFromT(50)).toBe(4);
    expect(recoveryLevelFromT(45)).toBe(3);
    expect(recoveryLevelFromT(40)).toBe(2);
    expect(recoveryLevelFromT(30)).toBe(1);
  });
});

describe('ageFromProfile', () => {
  it('uses whole calendar years and null without a profile', () => {
    expect(ageFromProfile(null, NOW)).toBeNull();
    expect(ageFromProfile(AGE40, NOW)).toBe(40);
    expect(ageFromProfile({ birthYear: Number.NaN, sex: 'unspecified', acceptedAt: 0 }, NOW)).toBeNull();
  });
});

describe('scoreInputFromAnalysis', () => {
  it('copies the fields used by the scores', () => {
    const i = scoreInputFromAnalysis(fakeAnalysis());
    expect(i.lnLfPlusHf).toBeCloseTo(Math.log(650), 12);
    expect(i.lnHf).toBeCloseTo(Math.log(450), 12);
    expect(i.lnRmssd).toBeCloseTo(Math.log(35), 12);
    expect(i.lnLfHf).toBeCloseTo(Math.log(200 / 450), 12);
    expect(i.lfHf).toBeCloseTo(200 / 450, 12);
    expect(i.meanHR).toBeCloseTo(66.7, 12);
    expect(i.lfBins).toBe(6);
    expect(i.durationS).toBe(60);
    expect(i.quality).toBe('full');
    expect(i.respHz).toBe(0.25);
  });

  it('nulls the frequency and time fields when the pipeline has none', () => {
    const i = scoreInputFromAnalysis(fakeAnalysis({ freq: null, time: null }));
    expect(i.lnLfPlusHf).toBeNull();
    expect(i.lnHf).toBeNull();
    expect(i.lnLfHf).toBeNull();
    expect(i.lfHf).toBeNull();
    expect(i.respHz).toBeNull();
    expect(i.lnRmssd).toBeNull();
    expect(i.meanHR).toBeNull();
    expect(i.lfBins).toBe(0);
  });

  it('treats non-finite values (ln 0) as missing', () => {
    const a = fakeAnalysis();
    a.freq!.lnHf = -Infinity;
    expect(scoreInputFromAnalysis(a).lnHf).toBeNull();
  });
});

describe('scoreMeasurement: worked example from the plan', () => {
  it('age 40, ln(LF+HF) 5.5, 120 s full → T ≈ 43.9, brain fatigue ≈ 56, level 3', () => {
    const s = scoreMeasurement(input(), AGE40, NOW);
    expect(muLnLfPlusHf(40)).toBeCloseTo(5.99, 2);
    expect(s.fatigue.basis).toBe('ln(LF+HF)');
    expect(s.fatigue.z).toBeCloseTo(-0.61, 2);
    expect(s.activityT).toBeCloseTo(43.9, 1);
    expect(s.brainFatigue).toBeCloseTo(56.1, 1);
    expect(Math.round(s.brainFatigue!)).toBe(56);
    expect(s.fatigue.value).toBe(s.brainFatigue);
    expect(s.fatigue.level).toBe(3);
    expect(s.fatigue.label).toBe(S.result.fatigueLevels[2]);
    expect(s.fatigue.provisional).toBe(false);
    expect(s.normsVersion).toBe('2026.10.1');
    expect(s.ageUsed).toBe(40);
    expect(s.normExtrapolated).toBe(false);
  });

  it('fills autonomic age and the adjusted stress T', () => {
    const s = scoreMeasurement(input(), AGE40, NOW);
    expect(s.autonomicAge).toBeCloseTo((7.71 - 5.5) / 0.043, 6);
    // lnLfHf exactly at the male norm → z 0 → T 50
    expect(s.stress.z).toBeCloseTo(0, 12);
    expect(s.stressT).toBeCloseTo(50, 12);
    expect(s.stress.value).toBe(1.0);
    expect(s.stress.level).toBe(2);
    expect(s.stress.label).toBe(S.result.stressLevels[1]);
    expect(s.stress.provisional).toBe(false);
  });

  it('recovery is the RMSSD deviation value with inverted levels', () => {
    const avg = scoreMeasurement(input(), AGE40, NOW);
    expect(avg.recovery.value).toBeCloseTo(50, 12);
    expect(avg.recovery.level).toBe(4);
    expect(avg.recovery.label).toBe(RECOVERY_LABELS[3]);
    const high = scoreMeasurement(input({ lnRmssd: muLnRmssd(40) + 0.45 * 1.5 }), AGE40, NOW);
    expect(high.recovery.value).toBeCloseTo(65, 12);
    expect(high.recovery.level).toBe(5);
    expect(high.recovery.label).toBe('High');
    const low = scoreMeasurement(input({ lnRmssd: muLnRmssd(40) - 0.45 * 1.5 }), AGE40, NOW);
    expect(low.recovery.value).toBeCloseTo(35, 12);
    expect(low.recovery.level).toBe(1);
    expect(low.recovery.label).toBe('Low');
  });
});

describe('scoreMeasurement: 60-second path', () => {
  it('averages z(lnHF) and z(lnRMSSD) with basis lnHF+lnRMSSD', () => {
    // lnHF one SD above the norm, lnRMSSD one SD below → mean z 0 → T 50.
    const s = scoreMeasurement(
      input({ durationS: 60, lnHf: muLnHF(40) + 0.9, lnRmssd: muLnRmssd(40) - 0.45, lnLfPlusHf: 9 }),
      AGE40,
      NOW,
    );
    expect(s.fatigue.basis).toBe('lnHF+lnRMSSD');
    expect(s.fatigue.z).toBeCloseTo(0, 12);
    expect(s.activityT).toBeCloseTo(50, 12);
    expect(s.brainFatigue).toBeCloseTo(50, 12);
    expect(s.fatigue.level).toBe(2);
    expect(s.fatigue.provisional).toBe(false);
    // ln(LF+HF) = 9 was ignored for the activity score but still gives an autonomic age.
    expect(s.autonomicAge).toBe(20);
  });

  it('uses ln(LF+HF) only with full quality at 90 s or more', () => {
    expect(scoreMeasurement(input({ durationS: 89.9 }), AGE40, NOW).fatigue.basis).toBe('lnHF+lnRMSSD');
    expect(scoreMeasurement(input({ durationS: 90 }), AGE40, NOW).fatigue.basis).toBe('ln(LF+HF)');
    expect(scoreMeasurement(input({ durationS: 120, lnLfPlusHf: null }), AGE40, NOW).fatigue.basis).toBe('lnHF+lnRMSSD');
  });

  it('clamps T to [20, 80]', () => {
    const s = scoreMeasurement(input({ lnLfPlusHf: 1 }), AGE40, NOW);
    expect(s.activityT).toBe(20);
    expect(s.brainFatigue).toBe(80);
    expect(s.fatigue.level).toBe(5);
    const hi = scoreMeasurement(input({ lnLfPlusHf: 12 }), AGE40, NOW);
    expect(hi.activityT).toBe(80);
    expect(hi.fatigue.level).toBe(1);
  });
});

describe('scoreMeasurement: quality and profile gating', () => {
  it('returns all-null scores with placeholder labels on a failed recording', () => {
    const s = scoreMeasurement(input({ quality: 'fail' }), AGE40, NOW);
    expect(s.activityT).toBeNull();
    expect(s.brainFatigue).toBeNull();
    expect(s.stressT).toBeNull();
    expect(s.autonomicAge).toBeNull();
    for (const idx of [s.fatigue, s.stress, s.recovery]) {
      expect(idx.value).toBeNull();
      expect(idx.z).toBeNull();
      expect(idx.level).toBeNull();
      expect(idx.label).toBe(S.common.notAvailable);
      expect(idx.provisional).toBe(false);
    }
    expect(s.normsVersion).toBe('2026.10.1');
  });

  it('time-only quality: no stress, fatigue from lnRMSSD only and marked provisional', () => {
    const s = scoreMeasurement(input({ quality: 'time-only', durationS: 60 }), AGE40, NOW);
    expect(s.stress.value).toBeNull();
    expect(s.stress.level).toBeNull();
    expect(s.stress.label).toBe(S.common.notAvailable);
    expect(s.stress.provisional).toBe(false);
    expect(s.stressT).toBeNull();
    expect(s.autonomicAge).toBeNull();
    expect(s.fatigue.basis).toBe('lnRMSSD');
    expect(s.fatigue.level).not.toBeNull();
    expect(s.fatigue.provisional).toBe(true);
    expect(s.recovery.level).not.toBeNull();
  });

  it('stress is unavailable when LF/HF is null', () => {
    const s = scoreMeasurement(input({ lfHf: null }), AGE40, NOW);
    expect(s.stress.level).toBeNull();
    expect(s.stress.label).toBe(S.common.notAvailable);
    expect(s.fatigue.level).not.toBeNull();
  });

  it('without a profile only the age-independent parts are filled', () => {
    const s = scoreMeasurement(input({ durationS: 60 }), null, NOW);
    expect(s.ageUsed).toBeNull();
    expect(s.normExtrapolated).toBe(false);
    expect(s.fatigue.level).toBeNull();
    expect(s.fatigue.label).toBe(S.common.notAvailable);
    expect(s.activityT).toBeNull();
    expect(s.brainFatigue).toBeNull();
    expect(s.recovery.level).toBeNull();
    expect(s.stressT).toBeNull();
    expect(s.stress.level).toBe(2);
    expect(s.stress.z).toBeNull();
    expect(s.stress.provisional).toBe(true);
    expect(s.autonomicAge).not.toBeNull();
  });

  it('flags extrapolated norms and the clamped age', () => {
    const old: Profile = { birthYear: 2026 - 82, sex: 'female', acceptedAt: 0 };
    const s = scoreMeasurement(input(), old, NOW);
    expect(s.ageUsed).toBe(75);
    expect(s.normExtrapolated).toBe(true);
    const young: Profile = { birthYear: 2026 - 17, sex: 'unspecified', acceptedAt: 0 };
    const y = scoreMeasurement(input(), young, NOW);
    expect(y.ageUsed).toBe(20);
    expect(y.normExtrapolated).toBe(true);
    const mid = scoreMeasurement(input(), { birthYear: 2026 - 71, sex: 'unspecified', acceptedAt: 0 }, NOW);
    expect(mid.ageUsed).toBe(71);
    expect(mid.normExtrapolated).toBe(true);
  });

  it('sex only shifts the adjusted stress T', () => {
    const m = scoreMeasurement(input(), { ...AGE40, sex: 'male' }, NOW);
    const f = scoreMeasurement(input(), { ...AGE40, sex: 'female' }, NOW);
    expect(m.activityT).toBeCloseTo(f.activityT!, 12);
    expect(m.stress.level).toBe(f.stress.level);
    expect(m.stressT!).toBeLessThan(f.stressT!);
  });
});

describe('provisional stress flags', () => {
  it('is clean for a 120-s full-quality recording with enough LF cells', () => {
    expect(stressIsProvisional(input())).toBe(false);
    expect(scoreMeasurement(input(), AGE40, NOW).stress.provisional).toBe(false);
  });

  it('flags short recordings, few LF cells, low heart rate, slow breathing and non-full quality', () => {
    expect(stressIsProvisional(input({ durationS: 60 }))).toBe(true);
    expect(stressIsProvisional(input({ durationS: 89 }))).toBe(true);
    expect(stressIsProvisional(input({ lfBins: 4 }))).toBe(true);
    expect(stressIsProvisional(input({ lfBins: 5 }))).toBe(false);
    expect(stressIsProvisional(input({ meanHR: 47 }))).toBe(true);
    expect(stressIsProvisional(input({ meanHR: null }))).toBe(false);
    expect(stressIsProvisional(input({ respHz: 0.1 }))).toBe(true);
    expect(stressIsProvisional(input({ respHz: null }))).toBe(false);
    expect(stressIsProvisional(input({ quality: 'time-only' }))).toBe(true);
    expect(scoreMeasurement(input({ durationS: 60 }), AGE40, NOW).stress.provisional).toBe(true);
  });
});

describe('compareScores', () => {
  const current = scoreMeasurement(input({ lnLfPlusHf: 5.5, lfHf: 2.5 }), AGE40, NOW); // fatigue ≈ 56.1, stress 3
  const previous = scoreMeasurement(input({ lnLfPlusHf: muLnLfPlusHf(40), lfHf: 1.0 }), AGE40, NOW); // fatigue 50, stress 2

  function historyOf(n: number, tOffsets: number[] = [0]): Scores[] {
    const out: Scores[] = [];
    for (let i = 0; i < n; i++) {
      const dz = tOffsets[i % tOffsets.length] / 10;
      out.push(scoreMeasurement(input({ lnLfPlusHf: muLnLfPlusHf(40) + 0.8 * dz }), AGE40, NOW));
    }
    return out;
  }

  it('reports deltas against the previous record', () => {
    const c = compareScores(current, previous, [previous]);
    expect(c.nHistory).toBe(1);
    expect(c.usesPersonalBaseline).toBe(false);
    expect(c.personalMeanT).toBeNull();
    expect(c.personalSdT).toBeNull();
    const fat = c.lines.find((l) => l.kind === 'previous' && l.index === 'fatigue')!;
    expect(fat.delta).toBeCloseTo(6.1, 1);
    expect(fat.text).toBe('Brain fatigue is 6 points higher than last time.');
    const st = c.lines.find((l) => l.kind === 'previous' && l.index === 'stress')!;
    expect(st.delta).toBe(1);
    expect(st.text).toBe('Stress level is higher than last time (level 3 vs 2).');
    expect(c.lines.some((l) => l.kind === 'personal')).toBe(false);
  });

  it('words lower, equal and large differences', () => {
    const lower = compareScores(previous, current, []).lines[0];
    expect(lower.delta).toBeCloseTo(-6.1, 1);
    expect(lower.text).toBe('Brain fatigue is 6 points lower than last time.');
    const same = compareScores(previous, previous, []);
    expect(same.lines[0].text).toBe('Brain fatigue is about the same as last time.');
    expect(same.lines[1].text).toBe('Stress level is the same as last time.');
    const far = scoreMeasurement(input({ lnLfPlusHf: 3.0 }), AGE40, NOW);
    const big = compareScores(far, previous, []).lines[0];
    expect(big.delta).toBeGreaterThan(10);
    expect(big.text).toMatch(/repeating the scan/);
  });

  it('skips lines whose inputs are missing', () => {
    expect(compareScores(current, null, []).lines).toEqual([]);
    const noProfile = scoreMeasurement(input(), null, NOW);
    const c = compareScores(noProfile, previous, [previous]);
    expect(c.lines.map((l) => l.index)).toEqual(['stress']);
    const failed = scoreMeasurement(input({ quality: 'fail' }), AGE40, NOW);
    expect(compareScores(failed, previous, [previous]).lines).toEqual([]);
  });

  it('uses the personal baseline only from 30 records', () => {
    const h29 = historyOf(29, [-5, 0, 5]);
    const c29 = compareScores(current, h29[0], h29);
    expect(c29.nHistory).toBe(29);
    expect(c29.usesPersonalBaseline).toBe(false);
    expect(c29.personalMeanT).toBeNull();
    expect(c29.lines.some((l) => l.kind === 'personal')).toBe(false);

    const h30 = historyOf(30, [-5, 0, 5]);
    const c30 = compareScores(current, h30[0], h30);
    expect(c30.nHistory).toBe(30);
    expect(c30.usesPersonalBaseline).toBe(true);
    expect(c30.personalMeanT).toBeCloseTo(50, 6);
    expect(c30.personalSdT).toBeGreaterThan(3);
    expect(c30.personalSdT).toBeLessThan(5);
    const p = c30.lines.find((l) => l.kind === 'personal')!;
    expect(p.index).toBe('fatigue');
    expect(p.delta).toBeCloseTo(6.1, 1);
    expect(p.text).toBe('Your autonomic activity is below your personal average.');
  });

  it('ignores records without an activity T when counting the baseline', () => {
    // Scans taken before a birth year was entered have no T: they can neither
    // unlock the 30-record baseline nor be announced as part of it.
    const noProfile = scoreMeasurement(input(), null, NOW);
    expect(noProfile.activityT).toBeNull();
    const mixed = [...historyOf(2, [-5, 5]), ...Array.from({ length: 28 }, () => noProfile)];
    const c = compareScores(current, mixed[0], mixed);
    expect(c.nHistory).toBe(2);
    expect(c.usesPersonalBaseline).toBe(false);
    expect(c.personalMeanT).toBeNull();
    expect(c.personalSdT).toBeNull();
    expect(c.lines.some((l) => l.kind === 'personal')).toBe(false);
    // The previous-record lines still work against a no-profile record (stress only).
    const vsNoProfile = compareScores(current, noProfile, mixed);
    expect(vsNoProfile.lines.map((l) => l.index)).toEqual(['stress']);

    const none = Array.from({ length: 30 }, () => noProfile);
    const cNone = compareScores(current, none[0], none);
    expect(cNone.nHistory).toBe(0);
    expect(cNone.usesPersonalBaseline).toBe(false);
    expect(cNone.personalMeanT).toBeNull();

    // Thirty contributing records among the no-profile ones do unlock it.
    const enough = [...historyOf(30, [-5, 0, 5]), ...Array.from({ length: 10 }, () => noProfile)];
    const cEnough = compareScores(current, enough[0], enough);
    expect(cEnough.nHistory).toBe(30);
    expect(cEnough.usesPersonalBaseline).toBe(true);
    expect(cEnough.personalMeanT).toBeCloseTo(50, 6);
  });

  it('honours a custom minN and a flat history', () => {
    const h5 = historyOf(5);
    const c = compareScores(current, h5[0], h5, 5);
    expect(c.usesPersonalBaseline).toBe(true);
    expect(c.personalSdT).toBe(0);
    // SD 0 falls back to population units: −6.1 T ≈ −0.61 → "below"
    expect(c.lines.find((l) => l.kind === 'personal')!.text).toMatch(/below your personal average/);
    const close = compareScores(previous, h5[0], h5, 5);
    expect(close.lines.find((l) => l.kind === 'personal')!.text).toBe('Your autonomic activity is close to your personal average.');
    const far = scoreMeasurement(input({ lnLfPlusHf: muLnLfPlusHf(40) + 2 }), AGE40, NOW);
    expect(compareScores(far, h5[0], h5, 5).lines.find((l) => l.kind === 'personal')!.text).toMatch(/well above/);
  });
});
