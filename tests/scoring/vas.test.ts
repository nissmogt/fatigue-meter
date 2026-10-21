import { describe, expect, it } from 'vitest';
import {
  VAS_KEYS,
  defaultVas,
  formatClock,
  makeSleepInfo,
  parseClockMinutes,
  sleepDurationMin,
  vasMean,
  vasValues,
} from '../../src/scoring/vas';
import { S } from '../../src/strings';

describe('VAS', () => {
  it('keeps the five keys in questionnaire order', () => {
    expect(VAS_KEYS).toEqual(['energy', 'relaxation', 'activity', 'motivation', 'sleep']);
    expect(S.vas.items.map((i) => i.key)).toEqual([...VAS_KEYS]);
  });

  it('averages the five answers', () => {
    expect(vasMean({ energy: 10, relaxation: 20, activity: 30, motivation: 40, sleep: 50 })).toBe(30);
    expect(vasMean(defaultVas())).toBe(50);
    expect(vasValues({ energy: 1, relaxation: 2, activity: 3, motivation: 4, sleep: 5 })).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('clock parsing', () => {
  it('accepts HH:MM and HH:MM:SS, rejects the rest', () => {
    expect(parseClockMinutes('23:30')).toBe(1410);
    expect(parseClockMinutes('6:45')).toBe(405);
    expect(parseClockMinutes('06:45:30')).toBe(405);
    expect(parseClockMinutes('24:00')).toBeNull();
    expect(parseClockMinutes('12:60')).toBeNull();
    expect(parseClockMinutes('noon')).toBeNull();
    expect(parseClockMinutes('')).toBeNull();
    expect(parseClockMinutes(null)).toBeNull();
  });

  it('formats back to zero-padded HH:MM', () => {
    expect(formatClock(405)).toBe('06:45');
    expect(formatClock(1410)).toBe('23:30');
    expect(formatClock(0)).toBe('00:00');
  });
});

describe('sleep duration', () => {
  it('wraps midnight: 23:30 → 06:45 is 435 min', () => {
    expect(sleepDurationMin('23:30', '06:45')).toBe(435);
    expect(sleepDurationMin('22:00', '06:00')).toBe(480);
    expect(sleepDurationMin('01:15', '08:00')).toBe(405);
    expect(sleepDurationMin('13:00', '14:30')).toBe(90);
  });

  it('is null when either time is missing or invalid', () => {
    expect(sleepDurationMin(null, '06:45')).toBeNull();
    expect(sleepDurationMin('23:30', null)).toBeNull();
    expect(sleepDurationMin('', '06:45')).toBeNull();
    expect(sleepDurationMin('25:00', '06:45')).toBeNull();
    expect(sleepDurationMin(null, null)).toBeNull();
  });

  it('makeSleepInfo normalises the times and fills the duration', () => {
    expect(makeSleepInfo('23:30', '6:45')).toEqual({ bedtime: '23:30', wake: '06:45', durationMin: 435 });
    expect(makeSleepInfo(null, null)).toEqual({ bedtime: null, wake: null, durationMin: null });
    expect(makeSleepInfo('23:30', 'x')).toEqual({ bedtime: '23:30', wake: null, durationMin: null });
  });
});
