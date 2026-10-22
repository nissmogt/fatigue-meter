/**
 * Small module-level store: the in-progress session (VAS answers and sleep
 * times, mirrored to localStorage so a reload mid-questionnaire keeps them),
 * the PWA "update ready" flag, the sample source chosen for the next
 * measurement, the last capture diagnostics, and the shared database handle.
 */
import type { VasAnswers } from '../scoring/types';
import type { CaptureMeta } from '../storage/types';
import { openDb, type FatigueDb } from '../storage/db';

const SESSION_KEY = 'fatigue-meter.session';
const DIAG_KEY = 'fatigue-meter.diagnostics';

// --- In-progress session ------------------------------------------------------

export interface SessionState {
  vas: Partial<VasAnswers>;
  bedtime: string | null;
  wake: string | null;
  didNotSleep: boolean;
}

const EMPTY_SESSION: SessionState = { vas: {}, bedtime: null, wake: null, didNotSleep: false };
const VAS_KEYS: ReadonlyArray<keyof VasAnswers> = ['energy', 'relaxation', 'activity', 'motivation', 'sleep'];

let session: SessionState | null = null;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota: the in-memory copy still works for this page load.
  }
}

function loadSession(): SessionState {
  if (session) return session;
  const raw = readJson<Partial<SessionState>>(SESSION_KEY);
  const vas: Partial<VasAnswers> = {};
  if (raw && raw.vas && typeof raw.vas === 'object') {
    for (const k of VAS_KEYS) {
      const v = (raw.vas as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) vas[k] = Math.min(100, Math.max(0, v));
    }
  }
  session = {
    vas,
    bedtime: typeof raw?.bedtime === 'string' ? raw.bedtime : null,
    wake: typeof raw?.wake === 'string' ? raw.wake : null,
    didNotSleep: raw?.didNotSleep === true,
  };
  return session;
}

function saveSession(): void {
  writeJson(SESSION_KEY, session);
}

export function getSession(): SessionState {
  const s = loadSession();
  return { ...s, vas: { ...s.vas } };
}

export function setVasAnswer(key: keyof VasAnswers, value: number): void {
  const s = loadSession();
  s.vas[key] = Math.min(100, Math.max(0, Math.round(value)));
  saveSession();
}

export function setSleep(p: { bedtime: string | null; wake: string | null; didNotSleep: boolean }): void {
  const s = loadSession();
  s.bedtime = p.bedtime;
  s.wake = p.wake;
  s.didNotSleep = p.didNotSleep;
  saveSession();
}

export function clearSession(): void {
  session = { ...EMPTY_SESSION, vas: {} };
  writeJson(SESSION_KEY, null);
}

/** Full answers; unanswered items default to the scale midpoint (50). */
export function vasAnswersOrDefault(partial: Partial<VasAnswers>): VasAnswers {
  return {
    energy: partial.energy ?? 50,
    relaxation: partial.relaxation ?? 50,
    activity: partial.activity ?? 50,
    motivation: partial.motivation ?? 50,
    sleep: partial.sleep ?? 50,
  };
}

// --- PWA update flag ------------------------------------------------------------

let needRefresh = false;
let applyUpdate: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Called by main.ts when a new service worker is waiting. Never reloads by itself. */
export function markNeedRefresh(apply: () => Promise<void>): void {
  needRefresh = true;
  applyUpdate = apply;
  notify();
}

export function hasUpdate(): boolean {
  return needRefresh;
}

/** Activates the waiting service worker (which reloads the page). User-initiated only. */
export async function applyPendingUpdate(): Promise<void> {
  const fn = applyUpdate;
  if (!fn) return;
  needRefresh = false;
  applyUpdate = null;
  notify();
  await fn();
}

export function onStateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// --- Sample source for the next measurement -----------------------------------------

export type SourceChoice =
  | { kind: 'camera' }
  | {
      kind: 'synthetic';
      seed: number;
      preset?: 'clean' | 'poor' | 'saturated';
      fingerOffWindows?: Array<[number, number]>;
    };

let sourceChoice: SourceChoice = { kind: 'camera' };

export function getSourceChoice(): SourceChoice {
  return sourceChoice;
}

export function setSourceChoice(c: SourceChoice): void {
  sourceChoice = c;
}

/**
 * `#/measure?source=synthetic&seed=42[&preset=poor][&fingerOff=10-13,30-31]`
 * selects the synthetic source (tests/demo). Returns null when the query says
 * nothing about the source.
 */
export function sourceChoiceFromQuery(q: URLSearchParams): SourceChoice | null {
  const source = q.get('source');
  if (source === 'camera') return { kind: 'camera' };
  if (source !== 'synthetic') return null;
  const seedRaw = Number(q.get('seed'));
  const seed = Number.isFinite(seedRaw) && q.get('seed') !== null ? Math.trunc(seedRaw) : 42;
  const presetRaw = q.get('preset');
  const preset = presetRaw === 'poor' || presetRaw === 'saturated' || presetRaw === 'clean' ? presetRaw : undefined;
  const fingerOffWindows: Array<[number, number]> = [];
  for (const part of (q.get('fingerOff') ?? '').split(',')) {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(part.trim());
    if (m) fingerOffWindows.push([Number(m[1]), Number(m[2])]);
  }
  return {
    kind: 'synthetic',
    seed,
    ...(preset ? { preset } : {}),
    ...(fingerOffWindows.length ? { fingerOffWindows } : {}),
  };
}

// --- Diagnostics of the last capture (settings panel) -----------------------------

/** One lens tried by the lens scan (settings diagnostics). */
export interface LensScanEntry {
  label: string;
  score: number;
  fingerFraction: number;
  ac: number;
  periodicity: number;
  dc: number;
  chosen: boolean;
  /** Why the lens did or did not qualify ('ok', 'no-finger', 'saturated', 'dark', 'weak', 'error'). */
  reason?: string;
}

export interface Diagnostics {
  at: number;
  capture: CaptureMeta;
  verdict: string | null;
  reasons: string[];
  fsSource: number | null;
  dropFraction: number | null;
  error: string | null;
  /** Result of the most recent lens scan, if one ran. */
  lensScan?: LensScanEntry[];
}

const LENS_SCAN_KEY = 'fatigue-meter.lensScan';

export function setLastLensScan(entries: LensScanEntry[]): void {
  writeJson(LENS_SCAN_KEY, entries);
}

export function getLastLensScan(): LensScanEntry[] | null {
  const v = readJson<LensScanEntry[]>(LENS_SCAN_KEY);
  return Array.isArray(v) ? v : null;
}

export function setDiagnostics(d: Diagnostics): void {
  writeJson(DIAG_KEY, d);
}

export function getDiagnostics(): Diagnostics | null {
  const d = readJson<Diagnostics>(DIAG_KEY);
  return d && typeof d === 'object' && d.capture ? d : null;
}

// --- Database handle ------------------------------------------------------------

let dbPromise: Promise<FatigueDb> | null = null;

/** Lazily opened, shared by all screens. A failed open is retried on the next call. */
export function getDb(): Promise<FatigueDb> {
  if (!dbPromise) {
    const p = Promise.resolve().then(() => openDb());
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
    dbPromise = p;
  }
  return dbPromise;
}
