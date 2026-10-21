import { describe, expect, it } from 'vitest';
import {
  AGE_MAX,
  AGE_MIN,
  ALL_AGES,
  ALL_AGES_AGE,
  FATIGUE_T_CUTS,
  NORMS_PROVENANCE,
  NORMS_VERSION,
  STRESS_RATIO_CUTS,
  autonomicAgeFromLnLfPlusHf,
  clampAge,
  muLnHF,
  muLnLF,
  muLnLfHf,
  muLnLfPlusHf,
  muLnRmssd,
  normsForAge,
  tFromZ,
  zScore,
} from '../../src/scoring/norms';

describe('norm constants', () => {
  it('exposes the level cut points from the plan', () => {
    expect(FATIGUE_T_CUTS).toEqual([58, 50, 42, 37]);
    expect(STRESS_RATIO_CUTS).toEqual([0.8, 2.0, 3.5, 5.0]);
  });

  it('is versioned with provenance', () => {
    expect(NORMS_VERSION).toBe('2026.10.1');
    expect(NORMS_PROVENANCE.version).toBe(NORMS_VERSION);
    expect(NORMS_PROVENANCE.transform).toBe('ln');
    expect(NORMS_PROVENANCE.sigma_method).toBe('derived from R^2');
    expect(NORMS_PROVENANCE.sources.map((s) => s.id)).toEqual(['choi2020', 'voss2015', 'nunan2010', 'fsl-bands']);
    expect(NORMS_PROVENANCE.note).toMatch(/5-minute/);
    expect(NORMS_PROVENANCE.note).toMatch(/30 measurements/);
  });
});

describe('age clamping and extrapolation', () => {
  it('clamps to [20, 75] and flags outside [20, 70]', () => {
    expect(clampAge(18)).toEqual({ age: AGE_MIN, extrapolated: true });
    expect(clampAge(20)).toEqual({ age: 20, extrapolated: false });
    expect(clampAge(40)).toEqual({ age: 40, extrapolated: false });
    expect(clampAge(70)).toEqual({ age: 70, extrapolated: false });
    expect(clampAge(72)).toEqual({ age: 72, extrapolated: true });
    expect(clampAge(90)).toEqual({ age: AGE_MAX, extrapolated: true });
  });

  it('evaluates the regressions at the clamped age', () => {
    expect(muLnHF(90)).toBeCloseTo(muLnHF(75), 12);
    expect(muLnLF(10)).toBeCloseTo(muLnLF(20), 12);
    const n = normsForAge(90, 'male');
    expect(n.ageUsed).toBe(75);
    expect(n.extrapolated).toBe(true);
  });
});

describe('regression means', () => {
  it('matches the Choi 2020 lines', () => {
    expect(muLnHF(40)).toBeCloseTo(6.833 - 0.039 * 40, 12);
    expect(muLnLF(40)).toBeCloseTo(7.197 - 0.047 * 40, 12);
    expect(muLnRmssd(40)).toBeCloseTo(4.0 - 0.012 * 40, 12);
  });

  it('gives ln(LF+HF) ≈ 5.99 at age 40 and tracks the 7.71 − 0.043·age fit', () => {
    expect(muLnLfPlusHf(40)).toBeCloseTo(5.99, 2);
    for (let age = 20; age <= 75; age += 5) {
      expect(Math.abs(muLnLfPlusHf(age) - (7.71 - 0.043 * age))).toBeLessThan(0.03);
    }
  });

  it('uses the sex intercepts for ln(LF/HF) with the midpoint for unspecified', () => {
    expect(muLnLfHf(30, 'male')).toBeCloseTo(0.6, 12);
    expect(muLnLfHf(30, 'female')).toBeCloseTo(0.15, 12);
    expect(muLnLfHf(30, 'unspecified')).toBeCloseTo(0.375, 12);
    expect(muLnLfHf(40, 'male')).toBeCloseTo(0.6 + 0.013 * 10, 12);
  });

  it('carries the sigmas in the norm bundle', () => {
    const n = normsForAge(40, 'female');
    expect(n.lnHf.sigma).toBe(0.9);
    expect(n.lnLf.sigma).toBe(0.8);
    expect(n.lnLfPlusHf.sigma).toBe(0.8);
    expect(n.lnRmssd.sigma).toBe(0.45);
    expect(n.lnLfHf.sigma).toBe(0.9);
    expect(n.sex).toBe('female');
  });

  it('exports an all-ages fallback at age 45', () => {
    expect(ALL_AGES_AGE).toBe(45);
    expect(ALL_AGES.ageUsed).toBe(45);
    expect(ALL_AGES.extrapolated).toBe(false);
    expect(ALL_AGES.lnHf.mu).toBeCloseTo(muLnHF(45), 12);
    expect(ALL_AGES.lnLfHf.mu).toBeCloseTo(muLnLfHf(45, 'unspecified'), 12);
  });
});

describe('helpers', () => {
  it('z-scores and clamps T to [20, 80]', () => {
    expect(zScore(6.0, { mu: 5.0, sigma: 0.5 })).toBe(2);
    expect(tFromZ(0)).toBe(50);
    expect(tFromZ(1.5)).toBe(65);
    expect(tFromZ(4)).toBe(80);
    expect(tFromZ(-4)).toBe(20);
  });

  it('inverts the ln(LF+HF) fit for the autonomic age', () => {
    expect(autonomicAgeFromLnLfPlusHf(7.71 - 0.043 * 40)).toBeCloseTo(40, 6);
    expect(autonomicAgeFromLnLfPlusHf(9)).toBe(20);
    expect(autonomicAgeFromLnLfPlusHf(2)).toBe(80);
  });
});
