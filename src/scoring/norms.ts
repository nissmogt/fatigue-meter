/**
 * Age (and sex) norms for the HRV quantities behind the scores, as
 * natural-log means with one standard deviation each, plus the level cut
 * points. Everything is versioned so a stored record can say which norms
 * produced its numbers.
 *
 * The regressions are 5-minute literature values applied to 60-second
 * measurements; they are a population reference only. The personal baseline
 * (the user's own mean ± SD of T) takes over in the comments after 30
 * measurements.
 */
import type { Sex } from './types';

export const NORMS_VERSION = '2026.10.1';

export interface Norm {
  /** Mean of the natural log of the quantity (ms² for powers, ms for RMSSD). */
  mu: number;
  /** Standard deviation in the same ln units. */
  sigma: number;
}

export const NORMS_PROVENANCE = {
  version: NORMS_VERSION,
  transform: 'ln',
  sigma_method: 'derived from R^2',
  sources: [
    {
      id: 'choi2020',
      citation: 'Choi J et al. (2020). Front Aging Neurosci 12:610626.',
      used: 'Age regressions of ln HF and ln LF (fingertip PPG, 300 seated adults, no sex difference); sigma derived from the reported R^2.',
    },
    {
      id: 'voss2015',
      citation: 'Voss A et al. (2015). PLoS ONE 10:e0118308.',
      used: 'Sex difference and age slope of ln(LF/HF).',
    },
    {
      id: 'nunan2010',
      citation: 'Nunan D et al. (2010). PACE 33:1407-1417.',
      used: 'Short-term RMSSD reference range (placeholder age regression, low confidence).',
    },
    {
      id: 'fsl-bands',
      citation: 'Fatigue Science Lab, published caution/warning bands.',
      used: 'Autonomic-activity T cut points 42 (caution) and 37 (warning); LF/HF stress bands.',
    },
  ],
  note:
    'These are 5-minute literature norms applied to 60-second values and are a population reference only. The personal baseline (own mean ± SD of T) takes over after 30 measurements.',
} as const;

/** Age range the regressions are evaluated over; outside it the age is clamped. */
export const AGE_MIN = 20;
export const AGE_MAX = 75;
/** Above this age (and below AGE_MIN) the norm is an extrapolation of the fitted range. */
export const AGE_EXTRAPOLATED_ABOVE = 70;

export const SIGMA_LN_HF = 0.9;
export const SIGMA_LN_LF = 0.8;
export const SIGMA_LN_LF_PLUS_HF = 0.8;
/** Placeholder: Nunan 2010 gives a range, not an age regression; low confidence. */
export const SIGMA_LN_RMSSD = 0.45;
export const SIGMA_LN_LF_HF = 0.9;

/**
 * Autonomic-activity T cut points, descending: T >= 58 is level 1 (very low
 * fatigue), >= 50 level 2, >= 42 level 3, >= 37 level 4, below that level 5.
 * 42 and 37 are the Fatigue Science Lab caution/warning bands.
 */
export const FATIGUE_T_CUTS: readonly [number, number, number, number] = [58, 50, 42, 37];

/** LF/HF upper bounds (exclusive) of stress levels 1..4, ascending; >= 5.0 is level 5. */
export const STRESS_RATIO_CUTS: readonly [number, number, number, number] = [0.8, 2.0, 3.5, 5.0];

/** Deviation values are clamped to this range (3 SD either side of average). */
export const T_MIN = 20;
export const T_MAX = 80;

/** ln(LF+HF) ≈ AUTONOMIC_AGE_INTERCEPT − AUTONOMIC_AGE_SLOPE · age (linear fit of muLnLfPlusHf). */
export const AUTONOMIC_AGE_INTERCEPT = 7.71;
export const AUTONOMIC_AGE_SLOPE = 0.043;

export interface AgeUsed {
  /** Age the norms are evaluated at, clamped to [AGE_MIN, AGE_MAX]. */
  age: number;
  /** True when the requested age lies outside the fitted range [AGE_MIN, AGE_EXTRAPOLATED_ABOVE]. */
  extrapolated: boolean;
}

export function clampAge(age: number): AgeUsed {
  const a = Math.min(AGE_MAX, Math.max(AGE_MIN, age));
  return { age: a, extrapolated: age < AGE_MIN || age > AGE_EXTRAPOLATED_ABOVE };
}

/** Choi 2020: ln HF (ms²) against age in years. */
export function muLnHF(age: number): number {
  return 6.833 - 0.039 * clampAge(age).age;
}

/** Choi 2020: ln LF (ms²) against age in years. */
export function muLnLF(age: number): number {
  return 7.197 - 0.047 * clampAge(age).age;
}

/** ln(LF+HF) of the two regression means (not the sum of the logs). */
export function muLnLfPlusHf(age: number): number {
  return Math.log(Math.exp(muLnLF(age)) + Math.exp(muLnHF(age)));
}

/** Placeholder RMSSD regression informed by Nunan 2010; low confidence. */
export function muLnRmssd(age: number): number {
  return 4.0 - 0.012 * clampAge(age).age;
}

/**
 * ln(LF/HF) from Voss 2015: men run about 0.45 above women; 'unspecified'
 * takes the midpoint so the sex choice never changes the result by more
 * than a quarter of a standard deviation.
 */
export function muLnLfHf(age: number, sex: Sex): number {
  const intercept = sex === 'female' ? 0.15 : sex === 'male' ? 0.6 : 0.375;
  return intercept + 0.013 * (clampAge(age).age - 30);
}

export interface AgeNorms {
  ageUsed: number;
  extrapolated: boolean;
  sex: Sex;
  lnHf: Norm;
  lnLf: Norm;
  lnLfPlusHf: Norm;
  lnRmssd: Norm;
  lnLfHf: Norm;
}

export function normsForAge(age: number, sex: Sex = 'unspecified'): AgeNorms {
  const { age: a, extrapolated } = clampAge(age);
  return {
    ageUsed: a,
    extrapolated,
    sex,
    lnHf: { mu: muLnHF(a), sigma: SIGMA_LN_HF },
    lnLf: { mu: muLnLF(a), sigma: SIGMA_LN_LF },
    lnLfPlusHf: { mu: muLnLfPlusHf(a), sigma: SIGMA_LN_LF_PLUS_HF },
    lnRmssd: { mu: muLnRmssd(a), sigma: SIGMA_LN_RMSSD },
    lnLfHf: { mu: muLnLfHf(a, sex), sigma: SIGMA_LN_LF_HF },
  };
}

/** Age the all-ages fallback is evaluated at (middle of the adult range). */
export const ALL_AGES_AGE = 45;

/**
 * Fallback norms for a reading with no profile: the age-45, sex-unspecified
 * values. scoreMeasurement itself leaves the age-adjusted scores null without
 * a profile (the UI asks for a birth year instead); this is for consumers
 * that explicitly want an all-ages comparison.
 */
export const ALL_AGES: AgeNorms = normsForAge(ALL_AGES_AGE, 'unspecified');

export function zScore(x: number, n: Norm): number {
  return (x - n.mu) / n.sigma;
}

/** Deviation value: 50 = average, 10 = one SD, clamped to [T_MIN, T_MAX]. */
export function tFromZ(z: number): number {
  return Math.min(T_MAX, Math.max(T_MIN, 50 + 10 * z));
}

/** Age whose ln(LF+HF) norm equals the measured value, clamped to [20, 80]. */
export function autonomicAgeFromLnLfPlusHf(lnLfPlusHf: number): number {
  const age = (AUTONOMIC_AGE_INTERCEPT - lnLfPlusHf) / AUTONOMIC_AGE_SLOPE;
  return Math.min(80, Math.max(20, age));
}
