import { describe, expect, it } from 'vitest';
import {
  FATIGUE_ONLY_HEADLINES,
  HEADLINES,
  MAX_COMMENT_LINES,
  NEUTRAL_HEADLINE,
  PROVISIONAL_LINE,
  STRESS_ONLY_HEADLINES,
  buildComments,
  headlineFor,
  sleepRemark,
  vasRemark,
} from '../../src/scoring/comments';
import { muLnHF, muLnLfPlusHf, muLnRmssd } from '../../src/scoring/norms';
import { compareScores, scoreMeasurement } from '../../src/scoring/score';
import type { Comparison, Level, Profile, ScoreInput, Scores, SleepInfo, VasAnswers } from '../../src/scoring/types';
import { makeSleepInfo } from '../../src/scoring/vas';

const NOW = new Date(2026, 5, 15);
const AGE40: Profile = { birthYear: 1986, sex: 'unspecified', acceptedAt: 0 };
const LEVELS: Level[] = [1, 2, 3, 4, 5];

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    lnLfPlusHf: muLnLfPlusHf(40),
    lnHf: muLnHF(40),
    lnRmssd: muLnRmssd(40),
    lnLfHf: 0,
    lfHf: 1.0,
    meanHR: 65,
    lfBins: 10,
    durationS: 120,
    quality: 'full',
    respHz: 0.25,
    ...over,
  };
}

function vas(all: number): VasAnswers {
  return { energy: all, relaxation: all, activity: all, motivation: all, sleep: all };
}

const noCmp: Comparison = { nHistory: 0, usesPersonalBaseline: false, personalMeanT: null, personalSdT: null, lines: [] };
const noSleep: SleepInfo = { bedtime: null, wake: null, durationMin: null };

/** Scores with the requested levels, built through the real scorer. */
function scoresWith(fatigue: Level, stress: Level): Scores {
  const tByLevel = [70, 54, 46, 39, 30];
  const ratioByLevel = [0.5, 1.2, 2.5, 4.0, 6.0];
  const z = (tByLevel[fatigue - 1] - 50) / 10;
  const s = scoreMeasurement(
    input({ lnLfPlusHf: muLnLfPlusHf(40) + 0.8 * z, lfHf: ratioByLevel[stress - 1] }),
    AGE40,
    NOW,
  );
  if (s.fatigue.level !== fatigue || s.stress.level !== stress) throw new Error('fixture mismatch');
  return s;
}

describe('headline matrix', () => {
  it('has a distinct, non-alarming headline for every fatigue × stress pair', () => {
    const seen = new Set<string>();
    for (const f of LEVELS) {
      for (const st of LEVELS) {
        const h = headlineFor(f, st);
        expect(h).toBe(HEADLINES[f - 1][st - 1]);
        expect(h.length).toBeGreaterThan(20);
        expect(h).not.toMatch(/diagnos|disease|danger|illness/i);
        seen.add(h);
        expect(buildComments(scoresWith(f, st), noCmp, vas(50), noSleep).headline).toBe(h);
      }
    }
    expect(seen.size).toBe(25);
  });

  it('falls back to single-index or neutral headlines', () => {
    for (const l of LEVELS) {
      expect(headlineFor(l, null)).toBe(FATIGUE_ONLY_HEADLINES[l - 1]);
      expect(headlineFor(null, l)).toBe(STRESS_ONLY_HEADLINES[l - 1]);
    }
    expect(headlineFor(null, null)).toBe(NEUTRAL_HEADLINE);
    const failed = scoreMeasurement(input({ quality: 'fail' }), AGE40, NOW);
    expect(buildComments(failed, noCmp, vas(50), noSleep).headline).toBe(NEUTRAL_HEADLINE);
    const noProfile = scoreMeasurement(input(), null, NOW);
    expect(buildComments(noProfile, noCmp, vas(50), noSleep).headline).toBe(STRESS_ONLY_HEADLINES[1]);
    const timeOnly = scoreMeasurement(input({ quality: 'time-only' }), AGE40, NOW);
    expect(buildComments(timeOnly, noCmp, vas(50), noSleep).headline).toBe(FATIGUE_ONLY_HEADLINES[timeOnly.fatigue.level! - 1]);
  });
});

describe('VAS remark', () => {
  it('is silent in the middle band', () => {
    expect(vasRemark(40, 3)).toBeNull();
    expect(vasRemark(70, 3)).toBeNull();
    expect(vasRemark(55, 5)).toBeNull();
  });

  it('says whether feeling low or good agrees with the objective result', () => {
    expect(vasRemark(30, 4)).toMatch(/feeling low.*points the same way/);
    expect(vasRemark(30, 1)).toMatch(/feeling low.*looks fine/);
    expect(vasRemark(30, 3)).toMatch(/feeling low.*average/);
    expect(vasRemark(80, 2)).toMatch(/feeling good.*agrees/);
    expect(vasRemark(80, 5)).toMatch(/feeling good.*more fatigue/);
    expect(vasRemark(80, 3)).toMatch(/feeling good.*average/);
    expect(vasRemark(30, null)).toBe('You reported feeling low today.');
    expect(vasRemark(80, null)).toBe('You reported feeling good today.');
  });
});

describe('sleep remark', () => {
  it('remarks on short and long sleep only', () => {
    expect(sleepRemark(null)).toBeNull();
    expect(sleepRemark(360)).toBeNull();
    expect(sleepRemark(540)).toBeNull();
    expect(sleepRemark(330)).toBe('Sleep was short (5 h 30 min); less than six hours often shows up as lower autonomic activity.');
    expect(sleepRemark(600)).toBe('Sleep was long (10 h); more than nine hours can be a sign of catching up on rest.');
  });
});

describe('buildComments', () => {
  it('assembles comparison, VAS, sleep and provisional lines in order', () => {
    // 60-s path: activity = mean(z lnHF, z lnRMSSD); both 1.6 SD low → T 34, brain fatigue 66.
    const current = scoreMeasurement(
      input({ durationS: 60, lnHf: muLnHF(40) - 0.9 * 1.6, lnRmssd: muLnRmssd(40) - 0.45 * 1.6 }),
      AGE40,
      NOW,
    );
    const previous = scoreMeasurement(input(), AGE40, NOW);
    const cmp = compareScores(current, previous, [previous]);
    const c = buildComments(current, cmp, vas(20), makeSleepInfo('01:00', '05:30'));
    expect(c.headline).toBe(headlineFor(current.fatigue.level, current.stress.level));
    expect(c.lines.length).toBe(5);
    expect(c.lines[0]).toMatch(/^Brain fatigue is \d+ points higher than last time\./);
    expect(c.lines[1]).toBe('Stress level is the same as last time.');
    expect(c.lines[2]).toMatch(/feeling low/);
    expect(c.lines[3]).toMatch(/^Sleep was short \(4 h 30 min\)/);
    expect(c.lines[4]).toBe(PROVISIONAL_LINE);
  });

  it('omits what does not apply', () => {
    const s = scoreMeasurement(input(), AGE40, NOW);
    const c = buildComments(s, noCmp, vas(50), makeSleepInfo('23:00', '07:00'));
    expect(c.lines).toEqual([]);
  });

  it('never exceeds the line cap', () => {
    const s = scoreMeasurement(input({ durationS: 60 }), AGE40, NOW);
    const many: Comparison = {
      ...noCmp,
      lines: Array.from({ length: 8 }, (_, i) => ({ kind: 'previous' as const, index: 'fatigue' as const, delta: i, text: `line ${i}` })),
    };
    const c = buildComments(s, many, vas(10), makeSleepInfo('02:00', '05:00'));
    expect(c.lines.length).toBe(MAX_COMMENT_LINES);
  });
});
