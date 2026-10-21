import type { QualityVerdict } from '../dsp/pipeline';

export type Level = 1 | 2 | 3 | 4 | 5;
export type Sex = 'female' | 'male' | 'unspecified';

export interface Profile {
  birthYear: number;
  sex: Sex;
  /** Epoch ms when the disclaimer was accepted. */
  acceptedAt: number;
}

export interface VasAnswers {
  energy: number;
  relaxation: number;
  activity: number;
  motivation: number;
  sleep: number;
}

export interface SleepInfo {
  /** 'HH:MM' local time, or null when the user did not sleep. */
  bedtime: string | null;
  wake: string | null;
  durationMin: number | null;
}

export interface ScoreInput {
  lnLfPlusHf: number | null;
  lnHf: number | null;
  lnRmssd: number | null;
  lnLfHf: number | null;
  lfHf: number | null;
  meanHR: number | null;
  lfBins: number;
  durationS: number;
  quality: QualityVerdict;
  respHz: number | null;
}

export interface IndexScore {
  key: 'fatigue' | 'stress' | 'recovery';
  /** Displayed number: brain fatigue 0–100, LF/HF ratio, or recovery T. */
  value: number | null;
  z: number | null;
  level: Level | null;
  label: string;
  provisional: boolean;
  /** Which quantity produced the score (for the About page / debug). */
  basis: string;
}

export interface Scores {
  fatigue: IndexScore;
  stress: IndexScore;
  recovery: IndexScore;
  /** Autonomic activity deviation value, 50 = average for age. */
  activityT: number | null;
  /** 100 − activityT. */
  brainFatigue: number | null;
  /** Age/sex-adjusted stress deviation value (optional display). */
  stressT: number | null;
  autonomicAge: number | null;
  normsVersion: string;
  ageUsed: number | null;
  normExtrapolated: boolean;
}

export interface ComparisonLine {
  kind: 'previous' | 'personal';
  index: 'fatigue' | 'stress';
  delta: number;
  text: string;
}

export interface Comparison {
  nHistory: number;
  usesPersonalBaseline: boolean;
  personalMeanT: number | null;
  personalSdT: number | null;
  lines: ComparisonLine[];
}

export interface ResultComments {
  headline: string;
  lines: string[];
}
