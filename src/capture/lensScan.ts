/**
 * Lens scan for phones with several rear cameras. Fingertip PPG needs the
 * flash light to pass through the finger into the lens, so only the lens
 * next to the flash gets a usable signal (on an iPhone 14 Pro that is the
 * telephoto, not the 1x main camera a plain "rear camera" request returns).
 * The device model is not readable from a web page, so instead each rear
 * lens is tried once with the torch on and scored by the pulse it sees. The
 * winner is remembered by id and label (iOS rotates device ids per page load).
 */
import { butterworthBandpass, filtfilt, mean } from '../dsp/filters';
import { periodicity, robustRange } from '../dsp/quality';
import { dedupeTimes, resampleSpline } from '../dsp/resample';
import type { Channel, Sample, SampleSeries } from '../dsp/types';
import { channelOf, toSeries } from '../dsp/types';
import { createCameraSource, listCameras } from './camera';
import type { CameraDevice, SampleSource } from './source';

export type LensReason = 'ok' | 'no-finger' | 'saturated' | 'dark' | 'weak' | 'error';

export interface LensScore {
  deviceId: string;
  label: string;
  /** 0..1; 0 when no finger was seen or every channel is saturated. */
  score: number;
  /** Fraction of the sampled window with a finger detected. */
  fingerFraction: number;
  /** Robust peak-to-peak of the band-passed pulse (8-bit levels) on the chosen channel. */
  ac: number;
  /** Autocorrelation at the pulse lag (0..1). */
  periodicity: number;
  /** Mean of the chosen channel (8-bit levels). */
  dc: number;
  /** Channel the score was computed on. */
  channel: Channel;
  /** True when red (or green) clipped: the lens sits right at the flash. */
  saturated: boolean;
  reason: LensReason;
  samples: number;
  error: string | null;
}

export interface LensScanOptions {
  /** Wall-clock settle after the torch request before sampling (auto-exposure adapts to the covered lens). */
  settleMs?: number;
  /** Length of the scored window. */
  sampleMs?: number;
  /** Pause between lenses so the previous camera is released (iOS allows one at a time). */
  gapMs?: number;
  onProgress?: (index: number, total: number, label: string) => void;
  /** Return true to abandon the scan (user cancelled / screen left). */
  shouldAbort?: () => boolean;
  /** Test seam: builds the source for a device. */
  makeSource?: (deviceId: string) => SampleSource;
}

export interface LensScanResult {
  best: LensScore | null;
  scores: LensScore[];
  aborted: boolean;
}

const REAR_LABEL = /back|rear|environment/i;
const FRONT_LABEL = /front|user|face/i;
/** Virtual multi-lens devices switch lenses on their own; physical lenses only. */
const VIRTUAL_LABEL = /dual|triple/i;
/** Upper bound on lenses tried, to keep the one-time scan short. */
const MAX_CANDIDATES = 4;
/** Below this score a lens is treated as "no usable pulse". */
export const MIN_USABLE_SCORE = 0.08;
/** A channel mean at or above this is clipped and carries no pulse. */
const CHANNEL_SATURATED = 245;
/** A channel mean below this is too dark to carry a pulse. */
const CHANNEL_DARK = 15;
/** Multiplier applied when the lens clips a channel (right at the flash); still usable on the others. */
const SATURATION_PENALTY = 0.7;

/** Rear physical lenses, labels permitting; call after camera permission was granted. */
export function rearCandidates(devices: readonly CameraDevice[]): CameraDevice[] {
  const withIds = devices.filter((d) => d.deviceId);
  const labelled = withIds.filter((d) => d.label);
  let out: CameraDevice[];
  if (labelled.length === withIds.length && labelled.some((d) => REAR_LABEL.test(d.label))) {
    out = labelled.filter((d) => REAR_LABEL.test(d.label) && !VIRTUAL_LABEL.test(d.label));
  } else {
    // No usable labels: everything that is not obviously a front camera.
    out = withIds.filter((d) => !FRONT_LABEL.test(d.label));
  }
  return out.slice(0, MAX_CANDIDATES);
}

export async function listRearCandidates(): Promise<CameraDevice[]> {
  return rearCandidates(await listCameras());
}

/** Resolve a remembered lens against the current device list (id first, then label). */
export function findRemembered(
  devices: readonly CameraDevice[],
  id: string | null,
  label: string | null,
): CameraDevice | null {
  if (id) {
    const byId = devices.find((d) => d.deviceId === id);
    if (byId) return byId;
  }
  if (label) {
    const byLabel = devices.find((d) => d.label && d.label === label);
    if (byLabel) return byLabel;
  }
  return null;
}

/**
 * Finger over the lens, judged per 1-s slice with a scan-specific rule: a
 * covered lens is red-dominant (torch or ambient) OR pink-white when it sits
 * right at the flash (red clipped, green high). The live detector's stricter
 * rule would call the brightest lens "no finger" and lose exactly the lens we
 * are looking for.
 */
function sliceHasFinger(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  if (sum <= 0) return false;
  const rr = r / sum;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < CHANNEL_DARK) return false;
  if (rr >= 0.33 && r > g) return true;
  return r >= CHANNEL_SATURATED && g >= 100;
}

type Scored = Omit<LensScore, 'deviceId' | 'label' | 'error'>;

/** Score the pulse visible in a sampled window (pure; unit-tested). */
export function scoreLensSeries(series: SampleSeries): Scored {
  const n = series.length;
  const base: Scored = {
    score: 0,
    fingerFraction: 0,
    ac: 0,
    periodicity: 0,
    dc: n ? mean(series.r) : 0,
    channel: 'g',
    saturated: false,
    reason: 'no-finger',
    samples: n,
  };
  if (n < 8) return base;
  const t0 = series.t[0];
  const t1 = series.t[n - 1];
  let fingerSlices = 0;
  let slices = 0;
  for (let s = t0; s < t1; s += 1) {
    const e = Math.min(t1, s + 1);
    if (e - s < 0.5) break;
    slices++;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (series.t[i] >= s && series.t[i] < e) {
        sr += series.r[i];
        sg += series.g[i];
        sb += series.b[i];
        c++;
      }
    }
    if (c >= 3 && sliceHasFinger(sr / c, sg / c, sb / c)) fingerSlices++;
  }
  const fingerFraction = slices ? fingerSlices / slices : 0;
  const mr = mean(series.r);
  const mg = mean(series.g);
  const mb = mean(series.b);
  const satR = mean(series.sat) > 0.3 || mr >= CHANNEL_SATURATED;
  const satG = mg >= CHANNEL_SATURATED;
  const satB = mb >= CHANNEL_SATURATED;
  const lum = 0.299 * mr + 0.587 * mg + 0.114 * mb;
  if (fingerFraction < 0.5) return { ...base, fingerFraction, saturated: satR, reason: 'no-finger' };
  if (lum < CHANNEL_DARK) return { ...base, fingerFraction, reason: 'dark' };

  // Candidate channels: unsaturated and not dark; the best by periodicity x amplitude wins.
  const fs = 60;
  const all: Array<{ ch: Channel; m: number }> = [
    { ch: 'g', m: mg },
    { ch: 'r', m: mr },
    { ch: 'b', m: mb },
  ];
  const candidates = all.filter((c) => c.m >= CHANNEL_DARK && (c.ch === 'r' ? !satR : c.ch === 'g' ? !satG : !satB));
  if (candidates.length === 0) {
    return { ...base, fingerFraction, dc: mr, saturated: true, reason: 'saturated' };
  }
  const { t } = dedupeTimes(series.t, series.r);
  if (t.length < 8 || t[t.length - 1] - t[0] < 1.5) return { ...base, fingerFraction, reason: 'weak' };
  let bestCh: Channel = candidates[0].ch;
  let bestPer = 0;
  let bestAc = 0;
  let bestDc = candidates[0].m;
  let bestVal = -1;
  for (const c of candidates) {
    const x = channelOf(series, c.ch);
    const d = dedupeTimes(series.t, x);
    const u = resampleSpline(d.t, d.x, fs);
    const inv = new Float64Array(u.y.length);
    for (let i = 0; i < inv.length; i++) inv[i] = -u.y[i];
    const y = filtfilt(inv, butterworthBandpass(fs, 0.5, 4), fs);
    const ac = robustRange(y);
    const per = periodicity(y, fs).r;
    const val = per * Math.min(1, ac / 1.5);
    if (val > bestVal) {
      bestVal = val;
      bestCh = c.ch;
      bestPer = per;
      bestAc = ac;
      bestDc = c.m;
    }
  }
  const saturated = satR || satG;
  const score = Math.max(0, bestVal) * (saturated ? SATURATION_PENALTY : 1);
  return {
    score,
    fingerFraction,
    ac: bestAc,
    periodicity: bestPer,
    dc: bestDc,
    channel: bestCh,
    saturated,
    reason: score >= MIN_USABLE_SCORE ? 'ok' : 'weak',
    samples: n,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Try each candidate lens with the torch on and score the pulse it sees. */
export async function scanLenses(
  candidates: readonly CameraDevice[],
  video: HTMLVideoElement,
  o: LensScanOptions = {},
): Promise<LensScanResult> {
  const settleMs = o.settleMs ?? 2000;
  const sampleMs = o.sampleMs ?? 3000;
  const gapMs = o.gapMs ?? 300;
  const makeSource = o.makeSource ?? ((deviceId: string) => createCameraSource({ deviceId }));
  const scores: LensScore[] = [];
  const abort = () => o.shouldAbort?.() === true;
  for (let i = 0; i < candidates.length; i++) {
    if (abort()) return { best: null, scores, aborted: true };
    const cand = candidates[i];
    o.onProgress?.(i, candidates.length, cand.label);
    const samples: Sample[] = [];
    const source = makeSource(cand.deviceId);
    const unsubscribe = source.onSample((s) => samples.push(s));
    let error: string | null = null;
    try {
      await source.start(video);
      try {
        await source.setTorch(true);
      } catch {
        /* ambient mode for this lens */
      }
      await delay(settleMs);
      const from = samples.length;
      await delay(sampleMs);
      if (abort()) {
        unsubscribe();
        await source.stop();
        return { best: null, scores, aborted: true };
      }
      const window = samples.slice(from);
      const scored = scoreLensSeries(toSeries(window));
      scores.push({ deviceId: cand.deviceId, label: cand.label, error: null, ...scored });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      scores.push({
        deviceId: cand.deviceId,
        label: cand.label,
        score: 0,
        fingerFraction: 0,
        ac: 0,
        periodicity: 0,
        dc: 0,
        channel: 'g',
        saturated: false,
        reason: 'error',
        samples: samples.length,
        error,
      });
    } finally {
      unsubscribe();
      await source.stop().catch(() => undefined);
    }
    if (i + 1 < candidates.length) await delay(gapMs);
  }
  let best: LensScore | null = null;
  for (const s of scores) if (s.score >= MIN_USABLE_SCORE && (!best || s.score > best.score)) best = s;
  return { best, scores, aborted: false };
}
