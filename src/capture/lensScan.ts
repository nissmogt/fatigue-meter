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
import { chooseChannel, liveSnapshot } from '../dsp/pipeline-impl';
import { periodicity, robustRange } from '../dsp/quality';
import { dedupeTimes, resampleSpline } from '../dsp/resample';
import type { Sample, SampleSeries } from '../dsp/types';
import { channelOf, toSeries } from '../dsp/types';
import { createCameraSource, listCameras } from './camera';
import type { CameraDevice, SampleSource } from './source';

export interface LensScore {
  deviceId: string;
  label: string;
  /** 0..1; 0 when no finger was seen. */
  score: number;
  /** Fraction of the sampled window with a finger detected. */
  fingerFraction: number;
  /** Robust peak-to-peak of the band-passed pulse (8-bit levels). */
  ac: number;
  /** Autocorrelation at the pulse lag (0..1). */
  periodicity: number;
  /** Mean of the chosen channel (8-bit levels). */
  dc: number;
  samples: number;
  error: string | null;
}

export interface LensScanOptions {
  /** Wall-clock settle after the torch request before sampling. */
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
export const MIN_USABLE_SCORE = 0.15;

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

/** Score the pulse visible in a sampled window (pure; unit-tested). */
export function scoreLensSeries(series: SampleSeries): Omit<LensScore, 'deviceId' | 'label' | 'error'> {
  const n = series.length;
  const empty = { score: 0, fingerFraction: 0, ac: 0, periodicity: 0, dc: n ? mean(series.r) : 0, samples: n };
  if (n < 8) return empty;
  // Finger presence over the window: the live detector on 1-s slices.
  const t0 = series.t[0];
  const t1 = series.t[n - 1];
  let fingerSlices = 0;
  let slices = 0;
  for (let s = t0; s < t1; s += 1) {
    const e = Math.min(t1, s + 1);
    if (e - s < 0.5) break;
    slices++;
    const idx: Sample[] = [];
    for (let i = 0; i < n; i++) {
      if (series.t[i] >= s && series.t[i] < e) {
        idx.push({ t: series.t[i], r: series.r[i], g: series.g[i], b: series.b[i], sat: series.sat[i], frame: series.frame[i] });
      }
    }
    if (idx.length >= 3 && liveSnapshot(toSeries(idx), 1).fingerOn) fingerSlices++;
  }
  const fingerFraction = slices ? fingerSlices / slices : 0;
  const fs = 60;
  const choice = chooseChannel(series, fs, [0.5, 4]);
  const x = channelOf(series, choice.channel);
  const dc = mean(x);
  const { t, x: xd } = dedupeTimes(series.t, x);
  if (t.length < 8 || t[t.length - 1] - t[0] < 1.5) return { ...empty, fingerFraction, dc };
  const u = resampleSpline(t, xd, fs);
  const inv = new Float64Array(u.y.length);
  for (let i = 0; i < inv.length; i++) inv[i] = -u.y[i];
  const y = filtfilt(inv, butterworthBandpass(fs, 0.5, 4), fs);
  const ac = robustRange(y);
  const per = periodicity(y, fs).r;
  // Periodicity is the signal-to-noise proxy; a very small swing is penalised
  // because it will not survive real finger pressure variation.
  const amplitudeFactor = Math.min(1, ac / 1.5);
  const brightnessOk = dc >= 40 && dc <= 250;
  const score = fingerFraction < 0.5 || !brightnessOk ? 0 : per * amplitudeFactor;
  return { score, fingerFraction, ac, periodicity: per, dc, samples: n };
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
  const settleMs = o.settleMs ?? 1200;
  const sampleMs = o.sampleMs ?? 2500;
  const gapMs = o.gapMs ?? 250;
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
