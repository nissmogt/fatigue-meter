/**
 * Turns an analysis result into the displayed scores. Everything here is
 * pure arithmetic on a ScoreInput, so stored records can be re-scored when
 * the norms change.
 *
 * Autonomic activity is an age-adjusted deviation value T (50 = average for
 * age, 10 = one SD); brain fatigue is 100 − T. Stress is the raw LF/HF ratio
 * in fixed, age-independent bands. Recovery is the RMSSD deviation value on
 * its own.
 */
import type { AnalysisResult } from '../dsp/pipeline';
import { S } from '../strings';
import {
  FATIGUE_T_CUTS,
  NORMS_VERSION,
  STRESS_RATIO_CUTS,
  autonomicAgeFromLnLfPlusHf,
  normsForAge,
  tFromZ,
  zScore,
  type AgeNorms,
} from './norms';
import type { Comparison, ComparisonLine, IndexScore, Level, Profile, ScoreInput, Scores } from './types';

/** Recordings at least this long use ln(LF+HF) for autonomic activity ("precise mode"). */
export const PRECISE_MIN_S = 90;
/** Fewer independent LF cells than this makes LF/HF provisional. */
export const MIN_LF_BINS = 5;
/** Below this heart rate the beat series under-samples the HF band. */
export const MIN_HR_FOR_STRESS = 48;
/** Breathing slower than this moves respiratory power into the LF band. */
export const MIN_RESP_HZ = 0.15;

/**
 * Recovery labels for levels 1..5 (5 = best). Kept here rather than in
 * strings.ts because the fatigue words read wrongly when reversed; the UI
 * module owns strings.ts and can move these when it adds a recovery scale.
 */
export const RECOVERY_LABELS: readonly [string, string, string, string, string] = [
  'Low',
  'Below average',
  'Average',
  'Above average',
  'High',
];

/** Level advice: consecutive results further apart than this suggest repeating the scan. */
export const REPEAT_ADVICE_DELTA = 10;

function finiteOrNull(x: number | null | undefined): number | null {
  return x != null && Number.isFinite(x) ? x : null;
}

export function scoreInputFromAnalysis(a: AnalysisResult): ScoreInput {
  const f = a.freq;
  const t = a.time;
  return {
    lnLfPlusHf: f ? finiteOrNull(f.lnLfPlusHf) : null,
    lnHf: f ? finiteOrNull(f.lnHf) : null,
    lnRmssd: t ? finiteOrNull(t.lnRmssd) : null,
    lnLfHf: f ? finiteOrNull(f.lnLfHf) : null,
    lfHf: f ? finiteOrNull(f.lfHf) : null,
    meanHR: t ? finiteOrNull(t.meanHR) : null,
    lfBins: f && Number.isFinite(f.lfBins) ? f.lfBins : 0,
    durationS: Number.isFinite(a.durationS) ? a.durationS : 0,
    quality: a.quality.verdict,
    respHz: f ? finiteOrNull(f.respHz) : null,
  };
}

/** Whole calendar years; null without a profile or with an unusable birth year. */
export function ageFromProfile(profile: Profile | null, now: Date = new Date()): number | null {
  if (!profile || !Number.isFinite(profile.birthYear)) return null;
  return now.getFullYear() - profile.birthYear;
}

export function fatigueLevelFromT(t: number): Level {
  const [c1, c2, c3, c4] = FATIGUE_T_CUTS;
  if (t >= c1) return 1;
  if (t >= c2) return 2;
  if (t >= c3) return 3;
  if (t >= c4) return 4;
  return 5;
}

export function stressLevelFromRatio(r: number): Level {
  const [c1, c2, c3, c4] = STRESS_RATIO_CUTS;
  if (r < c1) return 1;
  if (r < c2) return 2;
  if (r < c3) return 3;
  if (r < c4) return 4;
  return 5;
}

/** Recovery levels run the other way: a high RMSSD T is level 5 (best). */
export function recoveryLevelFromT(t: number): Level {
  return (6 - fatigueLevelFromT(t)) as Level;
}

export function stressIsProvisional(i: ScoreInput): boolean {
  return (
    i.durationS < PRECISE_MIN_S ||
    i.lfBins < MIN_LF_BINS ||
    (i.meanHR != null && i.meanHR < MIN_HR_FOR_STRESS) ||
    (i.respHz != null && i.respHz < MIN_RESP_HZ) ||
    i.quality !== 'full'
  );
}

function emptyIndex(key: IndexScore['key']): IndexScore {
  return { key, value: null, z: null, level: null, label: S.common.notAvailable, provisional: false, basis: 'none' };
}

function emptyScores(norms: AgeNorms | null): Scores {
  return {
    fatigue: emptyIndex('fatigue'),
    stress: emptyIndex('stress'),
    recovery: emptyIndex('recovery'),
    activityT: null,
    brainFatigue: null,
    stressT: null,
    autonomicAge: null,
    normsVersion: NORMS_VERSION,
    ageUsed: norms ? norms.ageUsed : null,
    normExtrapolated: norms ? norms.extrapolated : false,
  };
}

interface ActivityZ {
  z: number;
  basis: string;
}

/**
 * ln(LF+HF) needs a long recording to be stable; the 60-s default averages
 * the HF and RMSSD z-scores instead (both mostly parasympathetic). The
 * frequency values passed here are already null unless the verdict is FULL.
 */
function activityZ(
  lnLfPlusHf: number | null,
  lnHf: number | null,
  lnRmssd: number | null,
  durationS: number,
  norms: AgeNorms,
): ActivityZ | null {
  if (durationS >= PRECISE_MIN_S && lnLfPlusHf != null) {
    return { z: zScore(lnLfPlusHf, norms.lnLfPlusHf), basis: 'ln(LF+HF)' };
  }
  const parts: Array<{ z: number; name: string }> = [];
  if (lnHf != null) parts.push({ z: zScore(lnHf, norms.lnHf), name: 'lnHF' });
  if (lnRmssd != null) parts.push({ z: zScore(lnRmssd, norms.lnRmssd), name: 'lnRMSSD' });
  if (parts.length === 0) return null;
  const z = parts.reduce((s, p) => s + p.z, 0) / parts.length;
  return { z, basis: parts.map((p) => p.name).join('+') };
}

export function scoreMeasurement(input: ScoreInput, profile: Profile | null, now: Date = new Date()): Scores {
  const age = ageFromProfile(profile, now);
  const norms = age != null ? normsForAge(age, profile?.sex ?? 'unspecified') : null;
  const scores = emptyScores(norms);
  if (input.quality === 'fail') return scores;

  // The pipeline still reports a spectrum for TIME_DOMAIN_ONLY recordings;
  // only a FULL verdict makes it trustworthy.
  const full = input.quality === 'full';
  const lnLfPlusHf = full ? input.lnLfPlusHf : null;
  const lnHf = full ? input.lnHf : null;
  const lnLfHf = full ? input.lnLfHf : null;
  const lfHf = full ? input.lfHf : null;
  const lnRmssd = input.lnRmssd;

  if (lfHf != null) {
    const level = stressLevelFromRatio(lfHf);
    const z = norms && lnLfHf != null ? zScore(lnLfHf, norms.lnLfHf) : null;
    scores.stress = {
      key: 'stress',
      value: lfHf,
      z,
      level,
      label: S.result.stressLevels[level - 1],
      provisional: stressIsProvisional(input),
      basis: 'LF/HF',
    };
    if (z != null) scores.stressT = tFromZ(z);
  }

  // Age-independent, so available without a profile.
  if (lnLfPlusHf != null) scores.autonomicAge = autonomicAgeFromLnLfPlusHf(lnLfPlusHf);

  if (!norms) return scores;

  const act = activityZ(lnLfPlusHf, lnHf, lnRmssd, input.durationS, norms);
  if (act) {
    const t = tFromZ(act.z);
    const level = fatigueLevelFromT(t);
    scores.activityT = t;
    scores.brainFatigue = 100 - t;
    scores.fatigue = {
      key: 'fatigue',
      value: scores.brainFatigue,
      z: act.z,
      level,
      label: S.result.fatigueLevels[level - 1],
      // Provisional when the basis is thinner than the one intended for the length.
      provisional: !full || (act.basis !== 'ln(LF+HF)' && act.basis !== 'lnHF+lnRMSSD'),
      basis: act.basis,
    };
  }

  if (lnRmssd != null) {
    const z = zScore(lnRmssd, norms.lnRmssd);
    const t = tFromZ(z);
    const level = recoveryLevelFromT(t);
    scores.recovery = {
      key: 'recovery',
      value: t,
      z,
      level,
      label: RECOVERY_LABELS[level - 1],
      provisional: false,
      basis: 'lnRMSSD',
    };
  }

  return scores;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation (n − 1). */
function sampleSd(xs: readonly number[], m: number): number {
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

function previousFatigueText(delta: number): string {
  const d = Math.round(Math.abs(delta));
  let text: string;
  if (d === 0) text = 'Brain fatigue is about the same as last time.';
  else text = `Brain fatigue is ${d} point${d === 1 ? '' : 's'} ${delta > 0 ? 'higher' : 'lower'} than last time.`;
  if (Math.abs(delta) > REPEAT_ADVICE_DELTA) {
    text += ' Results this far apart suggest repeating the scan and going by the middle value.';
  }
  return text;
}

function previousStressText(current: Level, previous: Level): string {
  if (current === previous) return 'Stress level is the same as last time.';
  const dir = current > previous ? 'higher' : 'lower';
  return `Stress level is ${dir} than last time (level ${current} vs ${previous}).`;
}

function personalText(zp: number): string {
  const rel = zp >= 1.5 ? 'well above' : zp >= 0.5 ? 'above' : zp <= -1.5 ? 'well below' : zp <= -0.5 ? 'below' : 'close to';
  return `Your autonomic activity is ${rel} your personal average.`;
}

/**
 * Lines comparing the current scores with the previous record and, once
 * `history` holds at least `minN` records with an autonomic-activity T, with
 * the personal baseline. Records without a T (scored before a birth year was
 * entered) cannot contribute to the baseline, so they are not counted towards
 * `minN` either and `nHistory` reports only the contributing records.
 * `delta` is in the index's displayed units: brain-fatigue points for
 * 'fatigue' (positive = more fatigued), level steps for 'stress'.
 */
export function compareScores(
  current: Scores,
  previous: Scores | null,
  history: readonly Scores[],
  minN = 30,
): Comparison {
  const ts = history.map((h) => h.activityT).filter((t): t is number => t != null && Number.isFinite(t));
  const nHistory = ts.length;
  const usesPersonalBaseline = nHistory >= minN;
  let personalMeanT: number | null = null;
  let personalSdT: number | null = null;
  if (usesPersonalBaseline && ts.length >= 2) {
    personalMeanT = mean(ts);
    personalSdT = sampleSd(ts, personalMeanT);
  }

  const lines: ComparisonLine[] = [];
  if (previous) {
    if (current.brainFatigue != null && previous.brainFatigue != null) {
      const delta = current.brainFatigue - previous.brainFatigue;
      lines.push({ kind: 'previous', index: 'fatigue', delta, text: previousFatigueText(delta) });
    }
    if (current.stress.level != null && previous.stress.level != null) {
      const delta = current.stress.level - previous.stress.level;
      lines.push({
        kind: 'previous',
        index: 'stress',
        delta,
        text: previousStressText(current.stress.level, previous.stress.level),
      });
    }
  }
  if (personalMeanT != null && personalSdT != null && current.activityT != null) {
    const diffT = current.activityT - personalMeanT;
    // A flat history (e.g. repeated demo runs) has SD 0; fall back to population SD units.
    const zp = personalSdT > 0 ? diffT / personalSdT : diffT / 10;
    lines.push({ kind: 'personal', index: 'fatigue', delta: -diffT, text: personalText(zp) });
  }

  return { nHistory, usesPersonalBaseline, personalMeanT, personalSdT, lines };
}
