/**
 * IndexedDB persistence for measurements, their list summaries, the profile
 * and the settings. Plain IDB APIs, no libraries. Every public method is
 * promise-based and every multi-store write is one transaction, so a crash
 * half-way never leaves a record without its summary (or vice versa).
 *
 * Schema (version 1):
 *   'records'   keyPath 'id', index 'createdAt'  – full MeasurementRecord
 *   'summaries' keyPath 'id', index 'createdAt'  – MeasurementSummary (cheap lists)
 *   'kv'        out-of-line string keys          – 'profile', 'settings'
 *
 * Typed arrays survive IndexedDB's structured clone, so records are stored
 * as-is; only the JSON export/import converts them to plain number arrays.
 */
import { seriesFromJSON, seriesToJSON, type SampleSeriesJSON } from '../dsp/types';
import type {
  Comparison,
  ComparisonLine,
  IndexScore,
  Level,
  Profile,
  ResultComments,
  Scores,
  SleepInfo,
  VasAnswers,
} from '../scoring/types';
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type CaptureMeta,
  type ExportBundle,
  type MeasurementRecord,
  type MeasurementSummary,
  type Settings,
} from './types';

export const DB_NAME = 'fatigue-meter';
export const DB_VERSION = 1;
export const DEFAULT_OPEN_TIMEOUT_MS = 8000;

export const STORE_RECORDS = 'records';
export const STORE_SUMMARIES = 'summaries';
export const STORE_KV = 'kv';
export const INDEX_CREATED_AT = 'createdAt';
export const KV_PROFILE = 'profile';
export const KV_SETTINGS = 'settings';

type StoreName = typeof STORE_RECORDS | typeof STORE_SUMMARIES | typeof STORE_KV;
const ALL_STORES: readonly StoreName[] = [STORE_RECORDS, STORE_SUMMARIES, STORE_KV];

export interface FatigueDb {
  putRecord(r: MeasurementRecord): Promise<void>;
  getRecord(id: string): Promise<MeasurementRecord | undefined>;
  /** Newest first. */
  listSummaries(opts?: { limit?: number; before?: number }): Promise<MeasurementSummary[]>;
  /**
   * Scores of the newest n valid, non-demo camera records (newest first),
   * optionally created before a timestamp. Demo (synthetic) runs are stored
   * and listed like any other record but never feed the previous-result
   * comparison or the personal baseline.
   */
  latestScores(n: number, before?: number): Promise<Scores[]>;
  countRecords(): Promise<number>;
  deleteRecord(id: string): Promise<void>;
  /** Delete every measurement (records + summaries) but keep profile and settings. */
  clearRecords(): Promise<void>;
  clearAll(): Promise<void>;
  getProfile(): Promise<Profile | null>;
  putProfile(p: Profile | null): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;
  exportAll(): Promise<ExportBundle>;
  importAll(b: ExportBundle, mode: 'merge' | 'replace'): Promise<{ added: number; skipped: number }>;
  close(): void;
}

export interface OpenDbOptions {
  factory?: IDBFactory;
  name?: string;
  openTimeoutMs?: number;
}

// --- Schema migrations ------------------------------------------------------------

type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

/**
 * MIGRATIONS[v] upgrades schema version v to v + 1. `onupgradeneeded` runs them
 * from the stored version up to DB_VERSION, so a later version only appends an
 * entry (and bumps DB_VERSION) and never edits an earlier one.
 */
const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.createObjectStore(STORE_RECORDS, { keyPath: 'id' }).createIndex(INDEX_CREATED_AT, 'createdAt');
    db.createObjectStore(STORE_SUMMARIES, { keyPath: 'id' }).createIndex(INDEX_CREATED_AT, 'createdAt');
    db.createObjectStore(STORE_KV);
  },
];

// --- Opening ---------------------------------------------------------------------

export async function openDb(opts: OpenDbOptions = {}): Promise<FatigueDb> {
  const factory = opts.factory ?? defaultFactory();
  if (!factory) throw new Error('IndexedDB is not available in this environment');
  const name = opts.name ?? DB_NAME;
  const timeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  requestPersistence();
  const open = () => openRaw(factory, name, timeoutMs);
  return new IdbFatigueDb(await open(), open);
}

export function newRecordId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultFactory(): IDBFactory | undefined {
  try {
    // Reading `indexedDB` can throw a SecurityError in sandboxed frames.
    return typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  } catch {
    return undefined;
  }
}

let persistRequested = false;

/** Ask the browser not to evict our data under storage pressure. Best effort, once per page. */
function requestPersistence(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    void storage?.persist?.().catch(() => undefined);
  } catch {
    // Not available (node, old browsers, opaque origins): nothing to do.
  }
}

function openRaw(factory: IDBFactory, name: string, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let blocked = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      const why = blocked ? ': another tab holds an older version of the database open' : '';
      finish(() => reject(new Error(`IndexedDB open of "${name}" timed out after ${timeoutMs} ms${why}`)));
    }, timeoutMs);

    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, DB_VERSION);
    } catch (e) {
      finish(() => reject(toError(e)));
      return;
    }
    req.onblocked = () => {
      // Another tab has not yet closed its connection; keep waiting (it may
      // close on its versionchange event), the timeout reports it otherwise.
      blocked = true;
    };
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      try {
        if (!tx) throw new Error('upgrade transaction missing');
        for (let v = ev.oldVersion; v < DB_VERSION; v++) {
          const migrate = MIGRATIONS[v];
          if (!migrate) throw new Error(`no migration from schema version ${v}`);
          migrate(db, tx);
        }
      } catch (e) {
        try {
          tx?.abort();
        } catch {
          // already aborted
        }
        finish(() => reject(toError(e)));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        // The timeout already rejected; do not leak the late connection.
        db.close();
        return;
      }
      finish(() => resolve(db));
    };
    req.onerror = () => finish(() => reject(req.error ?? new Error('IndexedDB open failed')));
  });
}

// --- Connection wrapper ---------------------------------------------------------------

class IdbFatigueDb implements FatigueDb {
  private conn: IDBDatabase | null;
  private opening: Promise<IDBDatabase> | null = null;
  private closed = false;

  constructor(
    conn: IDBDatabase,
    private readonly reopen: () => Promise<IDBDatabase>,
  ) {
    this.conn = conn;
    this.attach(conn);
  }

  private attach(db: IDBDatabase): void {
    // Another tab wants to upgrade (or delete) the database: release our
    // connection right away so it is not blocked; the next call reopens.
    db.onversionchange = () => {
      db.close();
      if (this.conn === db) this.conn = null;
    };
    // The browser closed the connection itself (storage cleared, crash).
    db.onclose = () => {
      if (this.conn === db) this.conn = null;
    };
  }

  private connection(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('database is closed'));
    if (this.conn) return Promise.resolve(this.conn);
    if (!this.opening) {
      this.opening = this.reopen()
        .then((db) => {
          if (this.closed) {
            db.close();
            throw new Error('database is closed');
          }
          this.attach(db);
          this.conn = db;
          return db;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  /**
   * Runs `body` inside one transaction and resolves after the transaction
   * committed. `body` must issue its requests synchronously (or from request
   * callbacks); awaiting anything else lets the transaction auto-commit.
   * A transaction that finishes (commits or aborts) while `body` is still
   * pending rejects instead of hanging, e.g. when a request callback threw
   * before it could settle the body's promise.
   */
  private async run<T>(
    stores: readonly StoreName[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => T | Promise<T>,
  ): Promise<T> {
    const db = await this.connection();
    const tx = db.transaction([...stores], mode);
    const done = txDone(tx);
    // Invoked synchronously (not via a deferred .then) so the transaction is
    // still active when the body issues its requests; a sync throw rejects.
    const bodyPromise = new Promise<T>((resolve) => resolve(body(tx)));
    const ended = done.then(() => {
      throw new Error('IndexedDB transaction finished before its body settled');
    });
    let result: T;
    try {
      result = await Promise.race([bodyPromise, ended]);
    } catch (e) {
      done.catch(() => undefined);
      try {
        tx.abort();
      } catch {
        // already finished
      }
      throw e;
    }
    await done;
    return result;
  }

  async putRecord(r: MeasurementRecord): Promise<void> {
    const summary = summaryFromRecord(r);
    return this.run([STORE_RECORDS, STORE_SUMMARIES], 'readwrite', (tx) => {
      tx.objectStore(STORE_RECORDS).put(r);
      tx.objectStore(STORE_SUMMARIES).put(summary);
    });
  }

  getRecord(id: string): Promise<MeasurementRecord | undefined> {
    return this.run([STORE_RECORDS], 'readonly', (tx) =>
      request<MeasurementRecord | undefined>(tx.objectStore(STORE_RECORDS).get(id)),
    );
  }

  listSummaries(opts: { limit?: number; before?: number } = {}): Promise<MeasurementSummary[]> {
    const max = opts.limit ?? Infinity;
    const before = finiteOrUndefined(opts.before);
    if (max <= 0) return Promise.resolve([]);
    return this.run([STORE_SUMMARIES], 'readonly', (tx) => {
      const out: MeasurementSummary[] = [];
      const index = tx.objectStore(STORE_SUMMARIES).index(INDEX_CREATED_AT);
      return eachCursor(index.openCursor(beforeRange(before), 'prev'), (cursor) => {
        const s = cursor.value as MeasurementSummary;
        // Summaries written before `kind` existed are camera runs.
        if (before === undefined || s.createdAt < before) out.push(s.kind ? s : { ...s, kind: 'camera' });
        return out.length < max;
      }).then(() => out);
    });
  }

  latestScores(n: number, before?: number): Promise<Scores[]> {
    const bound = finiteOrUndefined(before);
    if (!(n > 0)) return Promise.resolve([]);
    return this.run([STORE_RECORDS], 'readonly', (tx) => {
      const out: Scores[] = [];
      const index = tx.objectStore(STORE_RECORDS).index(INDEX_CREATED_AT);
      return eachCursor(index.openCursor(beforeRange(bound), 'prev'), (cursor) => {
        const r = cursor.value as MeasurementRecord;
        const valid = r.capture?.kind !== 'synthetic' && r.analysis?.quality?.verdict !== 'fail' && r.scores != null;
        if (valid && (bound === undefined || r.createdAt < bound)) out.push(r.scores);
        return out.length < n;
      }).then(() => out);
    });
  }

  countRecords(): Promise<number> {
    return this.run([STORE_RECORDS], 'readonly', (tx) => request<number>(tx.objectStore(STORE_RECORDS).count()));
  }

  deleteRecord(id: string): Promise<void> {
    return this.run([STORE_RECORDS, STORE_SUMMARIES], 'readwrite', (tx) => {
      tx.objectStore(STORE_RECORDS).delete(id);
      tx.objectStore(STORE_SUMMARIES).delete(id);
    });
  }

  clearRecords(): Promise<void> {
    return this.run([STORE_RECORDS, STORE_SUMMARIES], 'readwrite', (tx) => {
      tx.objectStore(STORE_RECORDS).clear();
      tx.objectStore(STORE_SUMMARIES).clear();
    });
  }

  clearAll(): Promise<void> {
    return this.run(ALL_STORES, 'readwrite', (tx) => {
      for (const name of ALL_STORES) tx.objectStore(name).clear();
    });
  }

  getProfile(): Promise<Profile | null> {
    return this.run([STORE_KV], 'readonly', (tx) =>
      request<Profile | undefined>(tx.objectStore(STORE_KV).get(KV_PROFILE)).then((p) => p ?? null),
    );
  }

  putProfile(p: Profile | null): Promise<void> {
    return this.run([STORE_KV], 'readwrite', (tx) => {
      const kv = tx.objectStore(STORE_KV);
      if (p) kv.put(p, KV_PROFILE);
      else kv.delete(KV_PROFILE);
    });
  }

  getSettings(): Promise<Settings> {
    return this.run([STORE_KV], 'readonly', (tx) =>
      request<unknown>(tx.objectStore(STORE_KV).get(KV_SETTINGS)).then((s) => mergeSettings(DEFAULT_SETTINGS, s)),
    );
  }

  putSettings(patch: Partial<Settings>): Promise<Settings> {
    // Read-merge-write inside one readwrite transaction so concurrent patches
    // (two screens saving at once) cannot lose each other's keys.
    return this.run(
      [STORE_KV],
      'readwrite',
      (tx) =>
        new Promise<Settings>((resolve, reject) => {
          const kv = tx.objectStore(STORE_KV);
          const get = kv.get(KV_SETTINGS);
          get.onsuccess = () => {
            const next = mergeSettings(mergeSettings(DEFAULT_SETTINGS, get.result), patch);
            kv.put(next, KV_SETTINGS);
            resolve(next);
          };
          get.onerror = () => reject(get.error ?? new Error('settings read failed'));
        }),
    );
  }

  exportAll(): Promise<ExportBundle> {
    return this.run(ALL_STORES, 'readonly', async (tx) => {
      // All three requests are issued before the first await, so the
      // transaction stays alive until they have all completed.
      const records = request<MeasurementRecord[]>(tx.objectStore(STORE_RECORDS).getAll());
      const profile = request<Profile | undefined>(tx.objectStore(STORE_KV).get(KV_PROFILE));
      const settings = request<unknown>(tx.objectStore(STORE_KV).get(KV_SETTINGS));
      const [rs, p, s] = await Promise.all([records, profile, settings]);
      rs.sort((a, b) => a.createdAt - b.createdAt);
      return {
        app: 'fatigue-meter',
        exportedAt: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        profile: p ?? null,
        settings: mergeSettings(DEFAULT_SETTINGS, s),
        records: rs.map(recordToPlain),
      };
    });
  }

  async importAll(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<{ added: number; skipped: number }> {
    // Validate and convert everything before touching the database, so a bad
    // file is rejected as a whole (a rejection, never a sync throw) and is
    // never half-imported.
    validateBundle(bundle);
    // Summaries are built here too: a throw in the async body is a rejection,
    // whereas one inside an IDB callback would leave the import pending.
    const prepared = bundle.records.map((raw, i) => {
      const record = recordFromPlain(raw, i);
      return { record, summary: summaryFromRecord(record) };
    });
    const profile = mode === 'replace' ? profileOrNull(bundle.profile) : null;
    const settings = mode === 'replace' && bundle.settings ? mergeSettings(DEFAULT_SETTINGS, bundle.settings) : null;

    return this.run(
      ALL_STORES,
      'readwrite',
      (tx) =>
        new Promise<{ added: number; skipped: number }>((resolve, reject) => {
          const records = tx.objectStore(STORE_RECORDS);
          const summaries = tx.objectStore(STORE_SUMMARIES);
          const kv = tx.objectStore(STORE_KV);
          const write = (existing: Set<string>): void => {
            let added = 0;
            let skipped = 0;
            for (const { record, summary } of prepared) {
              if (existing.has(record.id)) {
                skipped++;
                continue;
              }
              existing.add(record.id); // a duplicate id inside the bundle itself is skipped too
              records.put(record);
              summaries.put(summary);
              added++;
            }
            resolve({ added, skipped });
          };
          // A throw inside an IDB callback escapes the executor; turn it into a rejection.
          const guarded = (fn: () => void): void => {
            try {
              fn();
            } catch (e) {
              reject(toError(e));
            }
          };
          if (mode === 'replace') {
            guarded(() => {
              for (const name of ALL_STORES) tx.objectStore(name).clear();
              if (profile) kv.put(profile, KV_PROFILE);
              if (settings) kv.put(settings, KV_SETTINGS);
              write(new Set());
            });
          } else {
            const keys = records.getAllKeys();
            keys.onsuccess = () =>
              guarded(() => write(new Set(keys.result.filter((k): k is string => typeof k === 'string'))));
            keys.onerror = () => reject(keys.error ?? new Error('key listing failed'));
          }
        }),
    );
  }

  close(): void {
    this.closed = true;
    this.conn?.close();
    this.conn = null;
  }
}

// --- Summaries and settings ---------------------------------------------------------------

export function summaryFromRecord(r: MeasurementRecord): MeasurementSummary {
  const time = r.analysis.time;
  return {
    id: r.id,
    createdAt: r.createdAt,
    fatigueLevel: r.scores.fatigue.level ?? null,
    stressLevel: r.scores.stress.level ?? null,
    brainFatigue: r.scores.brainFatigue ?? null,
    lfHf: r.scores.stress.value ?? null,
    meanHR: time?.meanHR ?? null,
    rmssd: time?.rmssd ?? null,
    verdict: r.analysis.quality.verdict,
    vasMean: vasMean(r.vas),
    kind: r.capture?.kind ?? 'camera',
  };
}

function vasMean(vas: MeasurementRecord['vas']): number {
  const values = [vas.energy, vas.relaxation, vas.activity, vas.motivation, vas.sleep].filter((v) =>
    Number.isFinite(v),
  );
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const SETTING_GUARDS: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  measureSeconds: (v): v is 60 | 120 => v === 60 || v === 120,
  keepRawSeries: (v): v is boolean => typeof v === 'boolean',
  preferredCameraId: (v): v is string | null => v === null || typeof v === 'string',
  preferredCameraLabel: (v): v is string | null => v === null || typeof v === 'string',
  showStressT: (v): v is boolean => typeof v === 'boolean',
};

/** `patch` keys that are known and well-typed override `base`; anything else is ignored. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const out: Settings = { ...base };
  if (!isObject(patch)) return out;
  for (const key of Object.keys(SETTING_GUARDS) as Array<keyof Settings>) {
    const v = patch[key];
    if (SETTING_GUARDS[key](v)) (out as Record<keyof Settings, unknown>)[key] = v;
  }
  return out;
}

function profileOrNull(p: unknown): Profile | null {
  if (!isObject(p) || typeof p.birthYear !== 'number' || !Number.isFinite(p.birthYear)) return null;
  const sex = p.sex === 'female' || p.sex === 'male' ? p.sex : 'unspecified';
  const acceptedAt = typeof p.acceptedAt === 'number' && Number.isFinite(p.acceptedAt) ? p.acceptedAt : Date.now();
  return { birthYear: p.birthYear, sex, acceptedAt };
}

// --- Export / import conversion ----------------------------------------------------------

type StoredAnalysis = MeasurementRecord['analysis'];
type PlainRecord = ExportBundle['records'][number];

/** Typed-array fields of a stored analysis and the constructor that restores each. */
const ANALYSIS_ARRAY_FIELDS: ReadonlyArray<[path: readonly string[], ctor: Float64ArrayConstructor | Uint8ArrayConstructor]> = [
  [['peaks'], Float64Array],
  [['nn', 't'], Float64Array],
  [['nn', 'ms'], Float64Array],
  [['nn', 'accepted'], Uint8Array],
  [['freq', 'psd', 'f'], Float64Array],
  [['freq', 'psd', 'p'], Float64Array],
];

/** Deep copy with every ArrayBufferView replaced by a plain number[] (JSON-safe). */
export function toPlain(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(toPlain);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlain(v);
    return out;
  }
  return value;
}

export function analysisToPlain(a: StoredAnalysis): unknown {
  return toPlain(a);
}

/**
 * Rebuilds the typed arrays of an analysis from its plain form. Unknown
 * fields pass through untouched; a missing array becomes an empty one so
 * consumers can rely on `.length`. A `null` parent (freq) stays null.
 */
export function analysisFromPlain(p: unknown): StoredAnalysis {
  if (!isObject(p) || !isObject(p.quality) || typeof p.quality.verdict !== 'string') {
    throw new Error('analysis is malformed');
  }
  const copy = toPlain(p) as Record<string, unknown>;
  for (const [path, ctor] of ANALYSIS_ARRAY_FIELDS) {
    let parent: Record<string, unknown> | null = copy;
    for (let i = 0; i < path.length - 1 && parent; i++) {
      const next: unknown = parent[path[i]];
      if (next === null) parent = null;
      else if (isObject(next)) parent = next;
      else parent = parent[path[i]] = {};
    }
    if (!parent) continue;
    const leaf = path[path.length - 1];
    const raw = parent[leaf];
    parent[leaf] = ctor.from(isNumberList(raw) ? raw : []);
  }
  return copy as unknown as StoredAnalysis;
}

function recordToPlain(r: MeasurementRecord): PlainRecord {
  return { ...r, series: r.series ? seriesToJSON(r.series) : null, analysis: analysisToPlain(r.analysis) };
}

/**
 * Builds a record from its plain (JSON) form field by field, validating every
 * field the app reads, so an edited, truncated or third-party file can never
 * store a record that later blanks the result screen. Unknown fields are
 * dropped. Throws a `record <id> ...` error; importAll turns that into a
 * rejection of the whole bundle.
 */
function recordFromPlain(raw: unknown, index: number): MeasurementRecord {
  if (!isObject(raw)) throw new Error(`record ${index} is not an object`);
  if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error(`record ${index} has no id`);
  const id = raw.id;
  const createdAt = raw.createdAt;
  if (!isFiniteNumber(createdAt)) throw new Error(`record ${id} has no createdAt`);
  const rawVersion = raw.schemaVersion;
  if (isFiniteNumber(rawVersion) && rawVersion > SCHEMA_VERSION) {
    throw new Error(`record ${id} has schema version ${rawVersion}, newer than supported version ${SCHEMA_VERSION}`);
  }
  const schemaVersion = isFiniteNumber(rawVersion) ? rawVersion : SCHEMA_VERSION;
  if (!isObject(raw.scores) || !isObject(raw.vas)) throw new Error(`record ${id} lacks scores or vas`);
  let series: MeasurementRecord['series'] = null;
  if (raw.series != null) {
    if (!isSeriesJSON(raw.series)) throw new Error(`record ${id} has a malformed series`);
    series = seriesFromJSON(raw.series);
  }
  let analysis: StoredAnalysis;
  try {
    analysis = analysisFromPlain(raw.analysis);
  } catch (e) {
    throw new Error(`record ${id}: ${toError(e).message}`);
  }
  return {
    id,
    createdAt,
    tz: stringOr(raw.tz, ''),
    schemaVersion,
    analysisVersion: stringOr(raw.analysisVersion, ''),
    vas: vasFromPlain(raw.vas, id),
    sleep: sleepFromPlain(raw.sleep, id),
    profile: profileOrNull(raw.profile),
    capture: captureFromPlain(raw.capture, id),
    series,
    analysis,
    scores: scoresFromPlain(raw.scores, id),
    comparison: comparisonFromPlain(raw.comparison, id),
    comments: commentsFromPlain(raw.comments, id),
  };
}

const VAS_KEYS: ReadonlyArray<keyof VasAnswers> = ['energy', 'relaxation', 'activity', 'motivation', 'sleep'];

function vasFromPlain(v: Record<string, unknown>, id: string): VasAnswers {
  const out: Partial<VasAnswers> = {};
  for (const key of VAS_KEYS) {
    const x = v[key];
    if (!isFiniteNumber(x)) throw new Error(`record ${id} has malformed vas (${key})`);
    out[key] = Math.min(100, Math.max(0, x));
  }
  return out as VasAnswers;
}

function sleepFromPlain(v: unknown, id: string): SleepInfo {
  if (!isObject(v)) throw new Error(`record ${id} has malformed sleep`);
  const { bedtime, wake, durationMin } = v;
  if (!isStringOrNull(bedtime) || !isStringOrNull(wake) || !isFiniteOrNull(durationMin)) {
    throw new Error(`record ${id} has malformed sleep`);
  }
  return { bedtime, wake, durationMin };
}

function captureFromPlain(v: unknown, id: string): CaptureMeta {
  if (!isObject(v)) throw new Error(`record ${id} has malformed capture`);
  const kind = v.kind;
  if (kind !== 'camera' && kind !== 'synthetic') throw new Error(`record ${id} has malformed capture (kind)`);
  const num = (x: unknown): number => (isFiniteNumber(x) ? x : 0);
  return {
    kind,
    label: stringOr(v.label, ''),
    width: num(v.width),
    height: num(v.height),
    nominalFps: num(v.nominalFps),
    deliveredFps: num(v.deliveredFps),
    torch: v.torch === true,
    locked: v.locked === true,
    durationS: num(v.durationS),
    timeBase: stringOr(v.timeBase, ''),
    userAgent: stringOr(v.userAgent, ''),
  };
}

function indexFromPlain(v: unknown, key: IndexScore['key'], id: string): IndexScore {
  const bad = (): Error => new Error(`record ${id} has malformed scores (${key})`);
  if (!isObject(v)) throw bad();
  const { value, z, level, label, provisional, basis } = v;
  if (
    !isFiniteOrNull(value) ||
    !isFiniteOrNull(z) ||
    !isLevelOrNull(level) ||
    typeof label !== 'string' ||
    typeof provisional !== 'boolean' ||
    typeof basis !== 'string'
  ) {
    throw bad();
  }
  return { key, value, z, level, label, provisional, basis };
}

function scoresFromPlain(v: Record<string, unknown>, id: string): Scores {
  const bad = (field: string): Error => new Error(`record ${id} has malformed scores (${field})`);
  const fatigue = indexFromPlain(v.fatigue, 'fatigue', id);
  const stress = indexFromPlain(v.stress, 'stress', id);
  const recovery = indexFromPlain(v.recovery, 'recovery', id);
  const { activityT, brainFatigue, stressT, autonomicAge, ageUsed, normsVersion, normExtrapolated } = v;
  if (!isFiniteOrNull(activityT)) throw bad('activityT');
  if (!isFiniteOrNull(brainFatigue)) throw bad('brainFatigue');
  if (!isFiniteOrNull(stressT)) throw bad('stressT');
  if (!isFiniteOrNull(autonomicAge)) throw bad('autonomicAge');
  if (!isFiniteOrNull(ageUsed)) throw bad('ageUsed');
  if (typeof normsVersion !== 'string') throw bad('normsVersion');
  if (typeof normExtrapolated !== 'boolean') throw bad('normExtrapolated');
  return { fatigue, stress, recovery, activityT, brainFatigue, stressT, autonomicAge, normsVersion, ageUsed, normExtrapolated };
}

function comparisonFromPlain(v: unknown, id: string): Comparison {
  const bad = (field: string): Error => new Error(`record ${id} has malformed comparison (${field})`);
  if (!isObject(v)) throw bad('object');
  const { nHistory, usesPersonalBaseline, personalMeanT, personalSdT, lines } = v;
  if (!isFiniteNumber(nHistory)) throw bad('nHistory');
  if (typeof usesPersonalBaseline !== 'boolean') throw bad('usesPersonalBaseline');
  if (!isFiniteOrNull(personalMeanT)) throw bad('personalMeanT');
  if (!isFiniteOrNull(personalSdT)) throw bad('personalSdT');
  if (!Array.isArray(lines)) throw bad('lines');
  const out: ComparisonLine[] = lines.map((l: unknown, i) => {
    if (!isObject(l)) throw bad(`lines[${i}]`);
    const { kind, index, delta, text } = l;
    if ((kind !== 'previous' && kind !== 'personal') || (index !== 'fatigue' && index !== 'stress')) {
      throw bad(`lines[${i}]`);
    }
    if (!isFiniteNumber(delta) || typeof text !== 'string') throw bad(`lines[${i}]`);
    return { kind, index, delta, text };
  });
  return { nHistory, usesPersonalBaseline, personalMeanT, personalSdT, lines: out };
}

function commentsFromPlain(v: unknown, id: string): ResultComments {
  if (!isObject(v)) throw new Error(`record ${id} has malformed comments`);
  const { headline, lines } = v;
  if (typeof headline !== 'string' || !Array.isArray(lines) || !lines.every(isString)) {
    throw new Error(`record ${id} has malformed comments`);
  }
  return { headline, lines: [...lines] };
}

function validateBundle(b: unknown): asserts b is ExportBundle {
  if (!isObject(b) || b.app !== 'fatigue-meter') throw new Error('not a fatigue-meter export');
  if (typeof b.schemaVersion !== 'number' || !Number.isFinite(b.schemaVersion)) {
    throw new Error('export has no schema version');
  }
  if (b.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`export schema version ${b.schemaVersion} is newer than supported version ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(b.records)) throw new Error('export has no records array');
}

/**
 * Every channel must have exactly as many finite numbers as `t` (seriesFromJSON
 * sets `length = t.length`), so a ragged or non-numeric series can never be
 * stored with a lying length and NaN samples.
 */
function isSeriesJSON(v: unknown): v is SampleSeriesJSON {
  if (!isObject(v)) return false;
  const t = v.t;
  if (!isNumberList(t)) return false;
  const channels: unknown[] = [t, v.r, v.g, v.b, v.sat];
  if (v.frame !== undefined) channels.push(v.frame);
  return channels.every((c) => isFiniteNumberList(c, t.length));
}

function isFiniteNumberList(v: unknown, n: number): v is ArrayLike<number> {
  if (!isNumberList(v) || v.length !== n) return false;
  for (let i = 0; i < n; i++) {
    const x: unknown = v[i];
    if (!isFiniteNumber(x)) return false;
  }
  return true;
}

// --- Small IDB helpers -------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // A failed request aborts the transaction, so 'abort' covers both cases
    // and `tx.error` carries the request's error by then.
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Visits each cursor row; `visit` returns true to keep going. */
function eachCursor(
  req: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      if (visit(cursor)) cursor.continue();
      else resolve();
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
  });
}

/** Exclusive upper bound on createdAt, or null when IDBKeyRange is unavailable (callers filter anyway). */
function beforeRange(before: number | undefined): IDBKeyRange | null {
  if (before === undefined) return null;
  const KeyRange = (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
  return KeyRange ? KeyRange.upperBound(before, true) : null;
}

function finiteOrUndefined(x: number | undefined): number | undefined {
  return x !== undefined && Number.isFinite(x) ? x : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

function isNumberList(v: unknown): v is ArrayLike<number> {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteOrNull(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function isLevelOrNull(v: unknown): v is Level | null {
  return v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5);
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
