/**
 * Subjective inputs: the five visual-analogue sliders and the sleep times.
 * The VAS mean is an informal overall feeling (0 = worst, 100 = best) used
 * only for the comments and the radar chart, never for the scores.
 */
import type { SleepInfo, VasAnswers } from './types';

export const VAS_KEYS = ['energy', 'relaxation', 'activity', 'motivation', 'sleep'] as const;
export type VasKey = (typeof VAS_KEYS)[number];

export const VAS_MIN = 0;
export const VAS_MAX = 100;
export const VAS_DEFAULT = 50;
/** Below this subjective mean the user reports feeling low; above VAS_HIGH, good. */
export const VAS_LOW = 40;
export const VAS_HIGH = 70;

/** Sleep shorter than this (minutes) gets a remark; so does sleep longer than SLEEP_LONG_MIN. */
export const SLEEP_SHORT_MIN = 360;
export const SLEEP_LONG_MIN = 540;

const MINUTES_PER_DAY = 24 * 60;

/** 'HH:MM' (or 'HH:MM:SS' from a time input with a step) → minutes since midnight. */
export function parseClockMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatClock(minutesSinceMidnight: number): string {
  const m = ((Math.round(minutesSinceMidnight) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** (wake − bed) mod 24 h, so a bedtime before midnight and a morning wake work; null when either is missing or invalid. */
export function sleepDurationMin(bed: string | null, wake: string | null): number | null {
  const b = parseClockMinutes(bed);
  const w = parseClockMinutes(wake);
  if (b == null || w == null) return null;
  return (((w - b) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Normalises the times to 'HH:MM' (invalid or empty → null) and fills the duration. */
export function makeSleepInfo(bed: string | null, wake: string | null): SleepInfo {
  const b = parseClockMinutes(bed);
  const w = parseClockMinutes(wake);
  return {
    bedtime: b == null ? null : formatClock(b),
    wake: w == null ? null : formatClock(w),
    durationMin: sleepDurationMin(bed, wake),
  };
}

export function vasValues(v: VasAnswers): number[] {
  return VAS_KEYS.map((k) => v[k]);
}

export function vasMean(v: VasAnswers): number {
  const xs = vasValues(v);
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function defaultVas(): VasAnswers {
  return { energy: VAS_DEFAULT, relaxation: VAS_DEFAULT, activity: VAS_DEFAULT, motivation: VAS_DEFAULT, sleep: VAS_DEFAULT };
}
