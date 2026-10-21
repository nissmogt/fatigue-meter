import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_VERSION, type QualityVerdict } from '../../src/dsp/pipeline';
import { generateSynthetic } from '../../src/dsp/synthetic';
import type { Level, Profile, Scores } from '../../src/scoring/types';
import {
  DB_VERSION,
  analysisFromPlain,
  analysisToPlain,
  mergeSettings,
  newRecordId,
  openDb,
  summaryFromRecord,
  type FatigueDb,
} from '../../src/storage/db';
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type ExportBundle, type MeasurementRecord } from '../../src/storage/types';

// --- Fixtures -------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

interface RecordOverrides {
  id?: string;
  createdAt?: number;
  verdict?: QualityVerdict;
  fatigueLevel?: Level | null;
  stressLevel?: Level | null;
  brainFatigue?: number | null;
  seed?: number;
  withSeries?: boolean;
}

function makeScores(o: RecordOverrides): Scores {
  const fatigueLevel = o.fatigueLevel === undefined ? 3 : o.fatigueLevel;
  const stressLevel = o.stressLevel === undefined ? 2 : o.stressLevel;
  const brainFatigue = o.brainFatigue === undefined ? 52 : o.brainFatigue;
  return {
    fatigue: { key: 'fatigue', value: brainFatigue, z: -0.2, level: fatigueLevel, label: 'Average', provisional: false, basis: 'mean(z lnHF, z lnRMSSD)' },
    stress: { key: 'stress', value: 1.2, z: null, level: stressLevel, label: 'Normal', provisional: true, basis: 'LF/HF' },
    recovery: { key: 'recovery', value: 48, z: -0.2, level: 3, label: 'Average', provisional: false, basis: 'lnRMSSD' },
    activityT: brainFatigue == null ? null : 100 - brainFatigue,
    brainFatigue,
    stressT: 51,
    autonomicAge: 41,
    normsVersion: 'test',
    ageUsed: 40,
    normExtrapolated: false,
  };
}

function makeAnalysis(verdict: QualityVerdict, seed: number): MeasurementRecord['analysis'] {
  const failed = verdict === 'fail';
  return {
    version: ANALYSIS_VERSION,
    fsSource: 30,
    fsUniform: 60,
    channel: 'g',
    channelReason: 'test',
    t0: 0,
    durationS: 60,
    peaks: Float64Array.from([0.5 + seed / 1000, 1.4, 2.3, 3.2]),
    nn: { t: Float64Array.from([1.4, 2.3, 3.2]), ms: Float64Array.from([900, 905, 895]), accepted: Uint8Array.from([1, 1, 0]) },
    time: failed
      ? null
      : { nBeats: 3, meanNN: 900, meanHR: 66.7, sdnn: 30, rmssd: 25, lnRmssd: Math.log(25), pnn50: 0.1, cvnn: 0.033, sd1: 18, sd2: 40 },
    freq:
      verdict === 'full'
        ? {
            lf: 200,
            hf: 450,
            tp: 650,
            lfHf: 200 / 450,
            lfNu: 30.8,
            hfNu: 69.2,
            lnLf: Math.log(200),
            lnHf: Math.log(450),
            lnLfPlusHf: Math.log(650),
            lnLfHf: Math.log(200 / 450),
            dfHz: 0.004,
            lfBins: 6.6,
            respHz: 0.25,
            psd: { f: Float64Array.from([0.04, 0.08, 0.12]), p: Float64Array.from([10.5, 20.25, 5.125]) },
          }
        : null,
    quality: {
      acceptedBeats: failed ? 5 : 3,
      totalBeats: failed ? 20 : 3,
      acceptedFraction: failed ? 0.25 : 1,
      longestGapS: 0,
      dropFraction: 0.02,
      goodFraction: failed ? 0.1 : 1,
      templateCorr: 0.95,
      perfusion: 0.02,
      skewness: 0.5,
      periodicity: 0.9,
      verdict,
      reasons: failed ? ['too-many-rejected', 'low-quality'] : [],
    },
  };
}

const PROFILE: Profile = { birthYear: 1986, sex: 'female', acceptedAt: T0 - 1000 };

function makeRecord(o: RecordOverrides = {}): MeasurementRecord {
  const seed = o.seed ?? 1;
  const verdict = o.verdict ?? 'full';
  return {
    id: o.id ?? newRecordId(),
    createdAt: o.createdAt ?? T0,
    tz: 'Europe/London',
    schemaVersion: SCHEMA_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    vas: { energy: 60, relaxation: 50, activity: 40, motivation: 70, sleep: 30 },
    sleep: { bedtime: '23:30', wake: '07:00', durationMin: 450 },
    profile: PROFILE,
    capture: {
      kind: 'synthetic',
      label: 'Synthetic',
      width: 320,
      height: 240,
      nominalFps: 30,
      deliveredFps: 29.6,
      torch: false,
      locked: false,
      durationS: 60,
      timeBase: 'performance',
      userAgent: 'vitest',
    },
    series: o.withSeries === false ? null : generateSynthetic({ seed, durationS: 3 }).series,
    analysis: makeAnalysis(verdict, seed),
    scores: makeScores(o),
    comparison: { nHistory: 0, usesPersonalBaseline: false, personalMeanT: null, personalSdT: null, lines: [] },
    comments: { headline: 'Average fatigue, normal stress.', lines: ['Line one.'] },
  };
}

let dbSeq = 0;

/** A fresh in-memory database per test so tests cannot see each other's rows. */
async function freshDb(): Promise<FatigueDb> {
  return openDb({ factory: new IDBFactory(), name: `test-${++dbSeq}` });
}

function seriesArrays(r: MeasurementRecord): number[][] {
  const s = r.series;
  if (!s) throw new Error('fixture has no series');
  return [s.t, s.r, s.g, s.b, s.sat, s.frame].map((a) => Array.from(a));
}

// --- Tests ----------------------------------------------------------------------------

describe('openDb', () => {
  it('opens through the global indexedDB when no factory is given', async () => {
    const db = await openDb();
    expect(await db.countRecords()).toBe(0);
    db.close();
  });

  it('rejects with a clear error when the open request never settles', async () => {
    const factory = { open: () => ({}) } as unknown as IDBFactory;
    await expect(openDb({ factory, name: 'hang', openTimeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
  });

  it('rejects further calls after close()', async () => {
    const db = await freshDb();
    db.close();
    await expect(db.countRecords()).rejects.toThrow(/closed/);
  });

  it('releases its connection on versionchange so another tab can upgrade', async () => {
    const factory = new IDBFactory();
    const db = await openDb({ factory, name: 'vc' });
    await db.putRecord(makeRecord({ id: 'a' }));
    // A newer app version in another tab opens at DB_VERSION + 1: must not be blocked.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('vc', DB_VERSION + 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked by the old connection'));
    });
    expect(upgraded.version).toBe(DB_VERSION + 1);
    upgraded.close();
    // Reopening at our (older) version now fails with a VersionError rather than hanging.
    await expect(db.countRecords()).rejects.toThrow(/version/i);
  });
});

describe('records', () => {
  it('round-trips a record with typed arrays through put/get', async () => {
    const db = await freshDb();
    const r = makeRecord({ id: 'r1' });
    await db.putRecord(r);
    const got = await db.getRecord('r1');
    expect(got).toEqual(r);
    expect(got?.series?.t).toBeInstanceOf(Float64Array);
    expect(got?.analysis.nn.accepted).toBeInstanceOf(Uint8Array);
    expect(await db.getRecord('missing')).toBeUndefined();
    expect(await db.countRecords()).toBe(1);
  });

  it('stores a record without raw series', async () => {
    const db = await freshDb();
    await db.putRecord(makeRecord({ id: 'noseries', withSeries: false }));
    expect((await db.getRecord('noseries'))?.series).toBeNull();
  });

  it('putRecord overwrites a record and its summary with the same id', async () => {
    const db = await freshDb();
    await db.putRecord(makeRecord({ id: 'x', fatigueLevel: 2 }));
    await db.putRecord(makeRecord({ id: 'x', fatigueLevel: 4 }));
    expect(await db.countRecords()).toBe(1);
    const [s] = await db.listSummaries();
    expect(s.fatigueLevel).toBe(4);
  });

  it('derives the summary from scores, analysis and VAS', () => {
    const s = summaryFromRecord(makeRecord({ id: 's', fatigueLevel: 4, stressLevel: 1, brainFatigue: 61 }));
    expect(s).toEqual({
      id: 's',
      createdAt: T0,
      fatigueLevel: 4,
      stressLevel: 1,
      brainFatigue: 61,
      lfHf: 1.2,
      meanHR: 66.7,
      rmssd: 25,
      verdict: 'full',
      vasMean: 50,
    });
    const failed = summaryFromRecord(makeRecord({ verdict: 'fail', fatigueLevel: null, brainFatigue: null }));
    expect(failed.meanHR).toBeNull();
    expect(failed.rmssd).toBeNull();
    expect(failed.fatigueLevel).toBeNull();
    expect(failed.verdict).toBe('fail');
  });
});

describe('listSummaries', () => {
  async function seeded(): Promise<FatigueDb> {
    const db = await freshDb();
    // Inserted out of order on purpose: the index, not insertion order, must sort.
    for (const [id, offset] of [
      ['b', 2],
      ['d', 4],
      ['a', 1],
      ['c', 3],
    ] as const) {
      await db.putRecord(makeRecord({ id, createdAt: T0 + offset * 60_000, seed: offset }));
    }
    return db;
  }

  it('lists newest first', async () => {
    const db = await seeded();
    const all = await db.listSummaries();
    expect(all.map((s) => s.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('honours limit and an exclusive before bound', async () => {
    const db = await seeded();
    expect((await db.listSummaries({ limit: 2 })).map((s) => s.id)).toEqual(['d', 'c']);
    expect((await db.listSummaries({ before: T0 + 3 * 60_000 })).map((s) => s.id)).toEqual(['b', 'a']);
    expect((await db.listSummaries({ limit: 1, before: T0 + 3 * 60_000 })).map((s) => s.id)).toEqual(['b']);
    expect(await db.listSummaries({ limit: 0 })).toEqual([]);
    expect(await db.listSummaries({ before: T0 })).toEqual([]);
  });
});

describe('latestScores', () => {
  it('returns the newest n scores, skipping failed analyses', async () => {
    const db = await freshDb();
    await db.putRecord(makeRecord({ id: 'ok1', createdAt: T0 + 1, brainFatigue: 41 }));
    await db.putRecord(makeRecord({ id: 'bad', createdAt: T0 + 2, verdict: 'fail', brainFatigue: null }));
    await db.putRecord(makeRecord({ id: 'ok2', createdAt: T0 + 3, verdict: 'time-only', brainFatigue: 42 }));
    await db.putRecord(makeRecord({ id: 'ok3', createdAt: T0 + 4, brainFatigue: 43 }));

    expect((await db.latestScores(10)).map((s) => s.brainFatigue)).toEqual([43, 42, 41]);
    expect((await db.latestScores(2)).map((s) => s.brainFatigue)).toEqual([43, 42]);
    expect((await db.latestScores(1)).map((s) => s.brainFatigue)).toEqual([43]);
    expect((await db.latestScores(10, T0 + 4)).map((s) => s.brainFatigue)).toEqual([42, 41]);
    expect((await db.latestScores(10, T0 + 3)).map((s) => s.brainFatigue)).toEqual([41]);
    expect(await db.latestScores(0)).toEqual([]);
  });
});

describe('delete and clear', () => {
  it('deleteRecord removes the record and its summary', async () => {
    const db = await freshDb();
    await db.putRecord(makeRecord({ id: 'keep', createdAt: T0 }));
    await db.putRecord(makeRecord({ id: 'gone', createdAt: T0 + 1 }));
    await db.deleteRecord('gone');
    await db.deleteRecord('never-existed');
    expect(await db.getRecord('gone')).toBeUndefined();
    expect((await db.listSummaries()).map((s) => s.id)).toEqual(['keep']);
    expect(await db.countRecords()).toBe(1);
  });

  it('clearAll empties records, summaries and the key-value store', async () => {
    const db = await freshDb();
    await db.putRecord(makeRecord({ id: 'a' }));
    await db.putProfile(PROFILE);
    await db.putSettings({ measureSeconds: 120 });
    await db.clearAll();
    expect(await db.countRecords()).toBe(0);
    expect(await db.listSummaries()).toEqual([]);
    expect(await db.latestScores(5)).toEqual([]);
    expect(await db.getProfile()).toBeNull();
    expect(await db.getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('profile and settings', () => {
  it('stores and clears the profile', async () => {
    const db = await freshDb();
    expect(await db.getProfile()).toBeNull();
    await db.putProfile(PROFILE);
    expect(await db.getProfile()).toEqual(PROFILE);
    await db.putProfile(null);
    expect(await db.getProfile()).toBeNull();
  });

  it('merges settings patches over the defaults', async () => {
    const db = await freshDb();
    expect(await db.getSettings()).toEqual(DEFAULT_SETTINGS);
    const first = await db.putSettings({ measureSeconds: 120 });
    expect(first).toEqual({ ...DEFAULT_SETTINGS, measureSeconds: 120 });
    const second = await db.putSettings({ preferredCameraId: 'cam-2', showStressT: true });
    expect(second).toEqual({ ...DEFAULT_SETTINGS, measureSeconds: 120, preferredCameraId: 'cam-2', showStressT: true });
    expect(await db.getSettings()).toEqual(second);
    const third = await db.putSettings({ preferredCameraId: null });
    expect(third.preferredCameraId).toBeNull();
    expect(third.measureSeconds).toBe(120);
  });

  it('ignores unknown keys and badly typed values', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { measureSeconds: 90, keepRawSeries: 'no', extra: 1, showStressT: true });
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, showStressT: true });
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, 'junk')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('export and import', () => {
  it('exports a JSON-safe bundle and imports it back (replace) with identical arrays', async () => {
    const src = await freshDb();
    const r1 = makeRecord({ id: 'one', createdAt: T0 + 1, seed: 7 });
    const r2 = makeRecord({ id: 'two', createdAt: T0 + 2, seed: 8, verdict: 'time-only' });
    const r3 = makeRecord({ id: 'three', createdAt: T0 + 3, withSeries: false });
    for (const r of [r2, r3, r1]) await src.putRecord(r);
    await src.putProfile(PROFILE);
    await src.putSettings({ measureSeconds: 120, showStressT: true });

    const bundle = await src.exportAll();
    expect(bundle.app).toBe('fatigue-meter');
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);
    expect(bundle.records.map((r) => r.id)).toEqual(['one', 'two', 'three']);
    expect(Array.isArray(bundle.records[0].series?.t)).toBe(true);
    expect(bundle.records[2].series).toBeNull();

    // The file on disk is JSON: everything must survive stringify/parse.
    const parsed = JSON.parse(JSON.stringify(bundle)) as ExportBundle;
    expect(parsed).toEqual(bundle);

    const dst = await freshDb();
    await dst.putRecord(makeRecord({ id: 'stale' }));
    const counts = await dst.importAll(parsed, 'replace');
    expect(counts).toEqual({ added: 3, skipped: 0 });
    expect(await dst.countRecords()).toBe(3);
    expect(await dst.getRecord('stale')).toBeUndefined();

    const got1 = await dst.getRecord('one');
    expect(got1).toBeDefined();
    expect(seriesArrays(got1!)).toEqual(seriesArrays(r1));
    expect(got1!.series!.t).toBeInstanceOf(Float64Array);
    expect(got1!.series!.r).toBeInstanceOf(Float32Array);
    expect(got1!.series!.frame).toBeInstanceOf(Uint32Array);
    expect(got1!.analysis).toEqual(r1.analysis);
    expect(got1!.analysis.peaks).toBeInstanceOf(Float64Array);
    expect(got1!.analysis.nn.accepted).toBeInstanceOf(Uint8Array);
    expect(got1!.analysis.freq!.psd.p).toBeInstanceOf(Float64Array);
    expect(got1!.scores).toEqual(r1.scores);
    expect(got1!.vas).toEqual(r1.vas);

    const got2 = await dst.getRecord('two');
    expect(got2!.analysis.freq).toBeNull();
    expect(got2!.analysis.quality.verdict).toBe('time-only');
    expect((await dst.getRecord('three'))!.series).toBeNull();

    expect((await dst.listSummaries()).map((s) => s.id)).toEqual(['three', 'two', 'one']);
    expect(await dst.getProfile()).toEqual(PROFILE);
    expect(await dst.getSettings()).toEqual({ ...DEFAULT_SETTINGS, measureSeconds: 120, showStressT: true });
  });

  it('merge skips ids that already exist and keeps profile and settings', async () => {
    const src = await freshDb();
    await src.putRecord(makeRecord({ id: 'dup', createdAt: T0 + 1 }));
    await src.putRecord(makeRecord({ id: 'new', createdAt: T0 + 2 }));
    await src.putProfile({ birthYear: 1970, sex: 'male', acceptedAt: T0 });
    await src.putSettings({ measureSeconds: 120 });
    const bundle = JSON.parse(JSON.stringify(await src.exportAll())) as ExportBundle;

    const dst = await freshDb();
    const local = makeRecord({ id: 'dup', createdAt: T0 + 1, brainFatigue: 99 });
    await dst.putRecord(local);
    await dst.putProfile(PROFILE);

    expect(await dst.importAll(bundle, 'merge')).toEqual({ added: 1, skipped: 1 });
    expect(await dst.countRecords()).toBe(2);
    expect((await dst.getRecord('dup'))!.scores.brainFatigue).toBe(99);
    expect((await dst.listSummaries()).map((s) => s.id)).toEqual(['new', 'dup']);
    expect(await dst.getProfile()).toEqual(PROFILE);
    expect(await dst.getSettings()).toEqual(DEFAULT_SETTINGS);

    // Importing the same file again adds nothing.
    expect(await dst.importAll(bundle, 'merge')).toEqual({ added: 0, skipped: 2 });
    expect(await dst.countRecords()).toBe(2);
  });

  it('rejects a bundle from another app or a newer schema, without writing', async () => {
    const db = await freshDb();
    await db.putRecord(makeRecord({ id: 'keep' }));
    const good = await db.exportAll();

    await expect(db.importAll({ ...good, app: 'other' } as unknown as ExportBundle, 'replace')).rejects.toThrow(/not a fatigue-meter/);
    await expect(db.importAll({ ...good, schemaVersion: SCHEMA_VERSION + 1 }, 'replace')).rejects.toThrow(/newer/);
    await expect(db.importAll({} as ExportBundle, 'merge')).rejects.toThrow();
    await expect(db.importAll(null as unknown as ExportBundle, 'merge')).rejects.toThrow();
    await expect(db.importAll({ ...good, records: [{ id: 'x' }] } as unknown as ExportBundle, 'replace')).rejects.toThrow(/createdAt/);

    expect(await db.countRecords()).toBe(1);
    expect(await db.getRecord('keep')).toBeDefined();
  });
});

describe('analysis plain conversion', () => {
  it('converts typed arrays to number[] and back on the known paths', () => {
    const a = makeAnalysis('full', 3);
    const plain = analysisToPlain(a) as Record<string, unknown>;
    expect(Array.isArray(plain.peaks)).toBe(true);
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);
    const back = analysisFromPlain(JSON.parse(JSON.stringify(plain)));
    expect(back).toEqual(a);
  });

  it('tolerates missing arrays and a null freq', () => {
    const back = analysisFromPlain({ quality: { verdict: 'fail', reasons: [] }, freq: null, time: null });
    expect(back.peaks).toEqual(new Float64Array(0));
    expect(back.nn.accepted).toEqual(new Uint8Array(0));
    expect(back.freq).toBeNull();
    expect(() => analysisFromPlain({ time: null })).toThrow(/malformed/);
  });
});

describe('newRecordId', () => {
  it('returns unique non-empty ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRecordId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.length).toBeGreaterThan(8);
  });
});
