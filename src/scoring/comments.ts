/**
 * Result comments: one headline chosen from a fatigue × stress matrix, then
 * a handful of lines (comparison with earlier results, how the subjective
 * answers and sleep relate to it, and a provisional note). The wording is
 * the app's own, deliberately plain and non-alarming: these are wellness
 * observations, not diagnoses.
 */
import { S } from '../strings';
import type { Comparison, Level, ResultComments, Scores, SleepInfo, VasAnswers } from './types';
import { SLEEP_LONG_MIN, SLEEP_SHORT_MIN, VAS_HIGH, VAS_LOW, vasMean } from './vas';

/** Comments are capped at this many lines below the headline. */
export const MAX_COMMENT_LINES = 6;

type Row = readonly [string, string, string, string, string];

/** HEADLINES[fatigueLevel − 1][stressLevel − 1]. */
export const HEADLINES: readonly [Row, Row, Row, Row, Row] = [
  [
    'Autonomic activity is well above average for your age and the sympathetic/parasympathetic balance looks relaxed. A good state to be in.',
    'Autonomic activity is well above average for your age with a normal sympathetic/parasympathetic balance.',
    'Autonomic activity is well above average for your age, though sympathetic activity is mildly dominant, as it often is after exertion or caffeine.',
    'Autonomic activity is well above average for your age, but sympathetic activity is clearly dominant right now.',
    'Autonomic activity is well above average for your age, but sympathetic activity is strongly dominant; a few slow breaths may help.',
  ],
  [
    'Autonomic activity is above average for your age and the sympathetic/parasympathetic balance looks relaxed.',
    'Autonomic activity is above average for your age with a normal sympathetic/parasympathetic balance.',
    'Autonomic activity is above average for your age; sympathetic activity is mildly dominant.',
    'Autonomic activity is above average for your age, but sympathetic activity is clearly dominant right now.',
    'Autonomic activity is above average for your age, but sympathetic activity is strongly dominant; consider a short break.',
  ],
  [
    'Autonomic activity is average for your age and the sympathetic/parasympathetic balance looks relaxed.',
    'Autonomic activity is average for your age with a normal sympathetic/parasympathetic balance.',
    'Autonomic activity is average for your age; sympathetic activity is mildly dominant.',
    'Autonomic activity is average for your age, but sympathetic activity is clearly dominant right now.',
    'Autonomic activity is average for your age, but sympathetic activity is strongly dominant; a few minutes of rest may help.',
  ],
  [
    'Autonomic activity is somewhat below average for your age, although the balance looks relaxed; this can follow a short night or a long day.',
    'Autonomic activity is somewhat below average for your age with a normal sympathetic/parasympathetic balance.',
    'Autonomic activity is somewhat below average for your age and sympathetic activity is mildly dominant; some rest may be due.',
    'Autonomic activity is somewhat below average for your age and sympathetic activity is clearly dominant; try to make time to unwind.',
    'Autonomic activity is somewhat below average for your age and sympathetic activity is strongly dominant; rest and sleep are worth prioritising.',
  ],
  [
    'Autonomic activity is well below average for your age, although the balance looks relaxed; make sure you are getting enough sleep.',
    'Autonomic activity is well below average for your age with a normal sympathetic/parasympathetic balance; rest is worth prioritising.',
    'Autonomic activity is well below average for your age and sympathetic activity is mildly dominant; take it easy today if you can.',
    'Autonomic activity is well below average for your age and sympathetic activity is clearly dominant; rest and recovery are worth prioritising.',
    'Autonomic activity is well below average for your age and sympathetic activity is strongly dominant; take time to rest, and repeat the scan on another day to confirm.',
  ],
];

/** Used when the stress level is unavailable (TIME_DOMAIN_ONLY quality). */
export const FATIGUE_ONLY_HEADLINES: Row = [
  'Autonomic activity is well above average for your age.',
  'Autonomic activity is above average for your age.',
  'Autonomic activity is average for your age.',
  'Autonomic activity is somewhat below average for your age.',
  'Autonomic activity is well below average for your age.',
];

/** Used when there is no age-adjusted fatigue score (no profile yet). */
export const STRESS_ONLY_HEADLINES: Row = [
  'The sympathetic/parasympathetic balance looks relaxed.',
  'The sympathetic/parasympathetic balance is normal.',
  'Sympathetic activity is mildly dominant.',
  'Sympathetic activity is clearly dominant right now.',
  'Sympathetic activity is strongly dominant; a few slow breaths may help.',
];

export const NEUTRAL_HEADLINE = 'No scores are available for this measurement.';

export const PROVISIONAL_LINE =
  'The stress level is provisional: short recordings, slow breathing or a low heart rate leave too few LF spectral cells to pin down LF/HF, so treat it as approximate.';

export function headlineFor(fatigue: Level | null, stress: Level | null): string {
  if (fatigue != null && stress != null) return HEADLINES[fatigue - 1][stress - 1];
  if (fatigue != null) return FATIGUE_ONLY_HEADLINES[fatigue - 1];
  if (stress != null) return STRESS_ONLY_HEADLINES[stress - 1];
  return NEUTRAL_HEADLINE;
}

/** Remark when the subjective mean is clearly low or high, noting whether the objective result agrees. */
export function vasRemark(subjectiveMean: number, fatigueLevel: Level | null): string | null {
  if (!Number.isFinite(subjectiveMean)) return null;
  const low = subjectiveMean < VAS_LOW;
  const high = subjectiveMean > VAS_HIGH;
  if (!low && !high) return null;
  if (fatigueLevel == null) return low ? 'You reported feeling low today.' : 'You reported feeling good today.';
  if (low) {
    if (fatigueLevel >= 4) return 'You reported feeling low, and the pulse analysis points the same way; rest is worth prioritising.';
    if (fatigueLevel <= 2) return 'You reported feeling low, although the pulse analysis looks fine; how you feel still matters, so take it easy if you can.';
    return 'You reported feeling low, while the pulse analysis is average for your age.';
  }
  if (fatigueLevel <= 2) return 'You reported feeling good, and the pulse analysis agrees.';
  if (fatigueLevel >= 4) return 'You reported feeling good, although the pulse analysis suggests more fatigue than you feel; keep an eye on rest and sleep.';
  return 'You reported feeling good, and the pulse analysis is average for your age.';
}

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} ${S.common.hours}` : `${h} ${S.common.hours} ${m} ${S.common.minutes}`;
}

export function sleepRemark(durationMin: number | null): string | null {
  if (durationMin == null || !Number.isFinite(durationMin)) return null;
  if (durationMin < SLEEP_SHORT_MIN) {
    return `Sleep was short (${formatDuration(durationMin)}); less than six hours often shows up as lower autonomic activity.`;
  }
  if (durationMin > SLEEP_LONG_MIN) {
    return `Sleep was long (${formatDuration(durationMin)}); more than nine hours can be a sign of catching up on rest.`;
  }
  return null;
}

export function buildComments(scores: Scores, cmp: Comparison, vas: VasAnswers, sleep: SleepInfo): ResultComments {
  const lines: string[] = cmp.lines.map((l) => l.text);
  const v = vasRemark(vasMean(vas), scores.fatigue.level);
  if (v) lines.push(v);
  const s = sleepRemark(sleep.durationMin);
  if (s) lines.push(s);
  if (scores.stress.provisional) lines.push(PROVISIONAL_LINE);
  return {
    headline: headlineFor(scores.fatigue.level, scores.stress.level),
    lines: lines.slice(0, MAX_COMMENT_LINES),
  };
}
