/**
 * The analysis pipeline: channel choice → uniform 60 Hz grid → inversion →
 * zero-phase band-pass → Elgendi peaks → interval cleaning → HRV → quality
 * gate. Also the cheap live snapshot used while measuring.
 */
import { butterworthBandpass, filtfilt, mean, median } from './filters';
import { cleanIntervals } from './ibi';
import { frequencyDomain, timeDomain } from './hrv';
import { alignPeaksToTemplate, detectSystolicPeaks } from './peaks';
import type {
  AnalysisOptions,
  AnalysisResult,
  FingerReason,
  GateReason,
  LiveSnapshot,
  Quality,
  QualityVerdict,
} from './pipeline';
import { DEFAULT_ANALYSIS_OPTIONS, ANALYSIS_VERSION } from './pipeline';
import { periodicity, robustRange, segmentGoodFraction, skewness, templateCorrelation } from './quality';
import { dedupeTimes, estimateFs, gapStats, resampleSpline } from './resample';
import type { Channel, SampleSeries } from './types';
import { channelOf } from './types';

// Channel-selection thresholds (8-bit units).
const GREEN_TOO_DARK = 15;
const RED_SAT_MEAN = 245;
const RED_SAT_FRACTION = 0.1;
const WEAK_AC = 0.3;

// Live finger thresholds (mirrors src/capture/config.ts; union of torch and ambient modes).
const LIVE_RED_RATIO_TORCH = 0.4;
const LIVE_RED_RATIO_AMBIENT = 0.33;
const LIVE_RED_MIN = 60;
const LIVE_LUM_MIN = 15;
const LIVE_LUM_MAX = 240;
const LIVE_STEP_LEVELS = 10;

export function mergeOptions(opts?: Partial<AnalysisOptions>): AnalysisOptions {
  if (!opts) return DEFAULT_ANALYSIS_OPTIONS;
  return {
    ...DEFAULT_ANALYSIS_OPTIONS,
    ...opts,
    peaks: { ...DEFAULT_ANALYSIS_OPTIONS.peaks, ...(opts.peaks ?? {}) },
    nn: { ...DEFAULT_ANALYSIS_OPTIONS.nn, ...(opts.nn ?? {}) },
    spectrum: { ...DEFAULT_ANALYSIS_OPTIONS.spectrum, ...(opts.spectrum ?? {}) },
    quality: { ...DEFAULT_ANALYSIS_OPTIONS.quality, ...(opts.quality ?? {}) },
  };
}

export interface ChannelChoice {
  channel: Channel;
  reason: string;
}

/**
 * Pick the channel with the best measured pulse signal-to-noise (autocorrelation
 * at the pulse lag), excluding saturated red and dark green. Green tends to win
 * under a torch (red clips); red can win in ambient light or on sensors whose
 * green pulse is weak.
 */
export function chooseChannel(series: SampleSeries, fs: number, band: [number, number]): ChannelChoice {
  const n = series.length;
  if (n < 8) return { channel: 'g', reason: 'default (too few samples)' };
  const mr = mean(series.r);
  const mg = mean(series.g);
  const sat = mean(series.sat);
  const redUsable = sat < RED_SAT_FRACTION && mr < RED_SAT_MEAN && mr >= GREEN_TOO_DARK;
  const greenUsable = mg >= GREEN_TOO_DARK;
  if (!redUsable && !greenUsable) return { channel: 'g', reason: 'neither channel usable' };
  if (!redUsable) return { channel: 'g', reason: 'red saturated or dark' };
  if (!greenUsable) return { channel: 'r', reason: 'green too dark' };
  const qg = channelSnr(series, 'g', fs, band);
  const qr = channelSnr(series, 'r', fs, band);
  if (qg.ac < WEAK_AC && qr.ac >= WEAK_AC) return { channel: 'r', reason: 'green pulse weak' };
  if (qr.ac < WEAK_AC && qg.ac >= WEAK_AC) return { channel: 'g', reason: 'red pulse weak' };
  // Prefer the higher periodicity; ties go to green (better SNR in the literature).
  if (qr.r > qg.r) return { channel: 'r', reason: `red periodicity ${qr.r.toFixed(2)} > green ${qg.r.toFixed(2)}` };
  return { channel: 'g', reason: `green periodicity ${qg.r.toFixed(2)} >= red ${qr.r.toFixed(2)}` };
}

function channelSnr(series: SampleSeries, c: Channel, fs: number, band: [number, number]): { r: number; ac: number } {
  const { t, x } = dedupeTimes(series.t, channelOf(series, c));
  if (t.length < 8) return { r: 0, ac: 0 };
  const u = resampleSpline(t, x, fs);
  const y = filtfilt(u.y, butterworthBandpass(fs, band[0], band[1]), Math.round(fs));
  return { r: periodicity(y, fs).r, ac: robustRange(y) };
}

export function analyzePPG(series: SampleSeries, opts?: Partial<AnalysisOptions>): AnalysisResult {
  const o = mergeOptions(opts);
  const fsU = o.fsUniform;
  const reasons: GateReason[] = [];
  const n = series.length;
  const startS = o.window?.startS ?? (n ? series.t[0] : 0);
  const endS = o.window?.endS ?? (n ? series.t[n - 1] : 0);
  const durationS = Math.max(0, endS - startS);

  const empty = (channel: Channel, channelReason: string, fsSource: number, extra: GateReason[]): AnalysisResult => ({
    version: ANALYSIS_VERSION,
    fsSource,
    fsUniform: fsU,
    channel,
    channelReason,
    t0: startS,
    durationS,
    waveform: new Float32Array(0),
    peaks: new Float64Array(0),
    nn: { t: new Float64Array(0), ms: new Float64Array(0), accepted: new Uint8Array(0) },
    time: null,
    freq: null,
    quality: {
      acceptedBeats: 0,
      totalBeats: 0,
      acceptedFraction: 0,
      longestGapS: durationS,
      dropFraction: 0,
      goodFraction: 0,
      templateCorr: NaN,
      perfusion: 0,
      skewness: NaN,
      periodicity: 0,
      verdict: 'fail',
      reasons: extra,
    },
  });

  if (n < 8 || durationS < 20) return empty('g', 'n/a', estimateFs(series.t), ['too-short']);

  // Window sub-series for channel choice / gap statistics.
  const wIdx = indexRange(series.t, startS, endS);
  const fsSource = estimateFs(series.t.subarray(wIdx[0], wIdx[1]));
  if (!(fsSource > 5)) return empty('g', 'n/a', fsSource, ['too-short']);
  const windowSeries = subSeries(series, wIdx[0], wIdx[1]);
  const choice = o.channel === 'auto' ? chooseChannel(windowSeries, fsU, o.displayBand) : { channel: o.channel, reason: 'forced' };
  const channel = choice.channel;

  const raw = channelOf(series, channel);
  const { t, x } = dedupeTimes(series.t, raw);
  if (t.length < 8) return empty(channel, choice.reason, fsSource, ['too-short']);
  const gaps = gapStats(t.subarray(...indexRange(t, startS, endS)), fsSource);

  // Uniform grid over the whole series (pre/post samples act as filter padding).
  const u = resampleSpline(t, x, fsU);
  const inv = new Float64Array(u.y.length);
  for (let i = 0; i < inv.length; i++) inv[i] = -u.y[i];
  const pad = Math.round(fsU);
  const yDet = filtfilt(inv, butterworthBandpass(fsU, o.peaks.band[0], o.peaks.band[1]), pad);
  const yDisp = filtfilt(inv, butterworthBandpass(fsU, o.displayBand[0], o.displayBand[1]), pad);

  const k0 = Math.max(0, Math.ceil((startS - u.t0) * fsU - 1e-9));
  const k1 = Math.min(inv.length - 1, Math.floor((endS - u.t0) * fsU + 1e-9));
  if (k1 - k0 < fsU * 20) return empty(channel, choice.reason, fsSource, ['too-short']);
  const waveform = Float32Array.from(yDisp.subarray(k0, k1 + 1));

  // Peaks on the whole band-passed series, then restricted to the window.
  const allPeaks = detectSystolicPeaks(yDet, { fs: fsU, ...o.peaks });
  const inWin: number[] = [];
  for (let i = 0; i < allPeaks.length; i++) if (allPeaks[i] >= k0 && allPeaks[i] <= k1) inWin.push(allPeaks[i]);
  const peakIdx = Int32Array.from(inWin);
  const aligned = alignPeaksToTemplate(yDet, peakIdx, fsU);
  const peakTimes = new Float64Array(aligned.length);
  for (let i = 0; i < aligned.length; i++) peakTimes[i] = u.t0 + aligned[i] / fsU;

  const nn = cleanIntervals(peakTimes, o.nn);
  const time = timeDomain(nn);
  const freq = frequencyDomain(nn, o.spectrum);

  // Quality indices over the window.
  const tmpl = templateCorrelation(yDet, fsU, peakIdx);
  const winDet = yDet.subarray(k0, k1 + 1);
  const per = periodicity(winDet, fsU);
  const dc = Math.abs(mean(windowSeries.length ? channelOf(windowSeries, channel) : raw));
  const ac = robustRange(waveform);
  const perfusion = dc > 0 ? (100 * ac) / dc : 0;
  const goodFraction = segmentGoodFraction(peakTimes, tmpl.perBeat, startS, endS, o.quality);
  const totalBeats = nn.ms.length;
  const acceptedFraction = totalBeats > 0 ? nn.acceptedCount / totalBeats : 0;

  const q = o.quality;
  if (ac < 0.15 || per.r < 0.25) reasons.push('no-signal');
  if (mean(channelOf(windowSeries, channel)) > 252) reasons.push('saturated');
  if (nn.acceptedCount < q.minBeats) reasons.push('too-few-beats');
  if (acceptedFraction < q.timeOnlyAcceptedFraction) reasons.push('too-many-rejected');
  if (nn.longestGapS > q.maxGapS) reasons.push('long-gap');
  if (gaps.dropFraction > q.maxDropFraction) reasons.push('dropped-frames');
  if (goodFraction < 0.5) reasons.push('low-quality');
  let verdict: QualityVerdict;
  if (reasons.length > 0 || !time) {
    verdict = 'fail';
    if (!time && reasons.length === 0) reasons.push('too-few-beats');
  } else if (acceptedFraction >= q.fullAcceptedFraction && goodFraction >= q.minGoodFraction && freq) {
    verdict = 'full';
  } else {
    verdict = 'time-only';
  }

  const quality: Quality = {
    acceptedBeats: nn.acceptedCount,
    totalBeats,
    acceptedFraction,
    longestGapS: nn.longestGapS,
    dropFraction: gaps.dropFraction,
    goodFraction,
    templateCorr: tmpl.templateCorr,
    perfusion,
    skewness: skewness(winDet),
    periodicity: per.r,
    verdict,
    reasons,
  };

  return {
    version: ANALYSIS_VERSION,
    fsSource,
    fsUniform: fsU,
    channel,
    channelReason: choice.reason,
    t0: startS,
    durationS,
    waveform,
    peaks: peakTimes,
    nn: { t: nn.t, ms: nn.ms, accepted: nn.accepted },
    time,
    freq,
    quality,
  };
}

/** Finger / signal state over the last `windowS` seconds; stateless and cheap. */
export function liveSnapshot(series: SampleSeries, windowS = 8, channel: 'auto' | Channel = 'auto'): LiveSnapshot {
  const n = series.length;
  const fs = 60;
  const none = (reason: FingerReason, ch: Channel, dc = 0, ac = 0): LiveSnapshot => ({
    fingerOn: reason === 'ok' || reason === 'moving',
    fingerReason: reason,
    quality: 'none',
    hrBpm: null,
    wave: new Float32Array(0),
    waveFs: fs,
    channel: ch,
    ac,
    dc,
  });
  if (n === 0) return none('no-finger', 'g');
  const tEnd = series.t[n - 1];
  const [i0, i1] = indexRange(series.t, tEnd - windowS, tEnd + 1e-6);
  const win = subSeries(series, i0, i1);
  const m = win.length;
  if (m < 4) return none('no-finger', 'g');

  // Finger presence from the last ~0.5 s of means.
  const tail = subSeries(win, Math.max(0, m - Math.max(2, Math.round(0.5 * (m / Math.max(0.5, win.t[m - 1] - win.t[0]))))), m);
  const r = mean(tail.r);
  const g = mean(tail.g);
  const b = mean(tail.b);
  const sat = mean(tail.sat);
  const sum = r + g + b;
  const rr = sum > 0 ? r / sum : 0;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  let reason: FingerReason = 'ok';
  const torchLike = rr >= LIVE_RED_RATIO_TORCH && r >= LIVE_RED_MIN && r <= 254.5 && g > 0 && r / g >= 1.5;
  const ambientLike = rr >= LIVE_RED_RATIO_AMBIENT && r > g && g > b && lum >= LIVE_LUM_MIN && lum <= LIVE_LUM_MAX;
  if (sat > 0.5 && g > 245) reason = 'saturated';
  else if (rr >= LIVE_RED_RATIO_AMBIENT && r > g && lum < LIVE_LUM_MIN) reason = 'too-dark';
  else if (!(torchLike || ambientLike)) reason = 'no-finger';

  const ch: Channel = channel === 'auto' ? chooseChannel(win, fs, DEFAULT_ANALYSIS_OPTIONS.displayBand).channel : channel;
  if (reason !== 'ok') return none(reason, ch, r, 0);

  // Motion / pressure change: compare consecutive 1-s means and single-frame jumps.
  const x = channelOf(win, ch);
  let step = false;
  for (let i = 1; i < m; i++) if (Math.abs(x[i] - x[i - 1]) > LIVE_STEP_LEVELS) step = true;
  const secMeans: number[] = [];
  let s = 0;
  let c = 0;
  let secStart = win.t[0];
  for (let i = 0; i < m; i++) {
    if (win.t[i] - secStart >= 1) {
      if (c) secMeans.push(s / c);
      s = 0;
      c = 0;
      secStart = win.t[i];
    }
    s += x[i];
    c++;
  }
  if (c) secMeans.push(s / c);
  for (let i = 1; i < secMeans.length; i++) if (Math.abs(secMeans[i] - secMeans[i - 1]) > LIVE_STEP_LEVELS) step = true;
  const recentStep = step && secMeans.length >= 2 && Math.abs(secMeans[secMeans.length - 1] - secMeans[secMeans.length - 2]) > LIVE_STEP_LEVELS;

  const { t, x: xd } = dedupeTimes(win.t, x);
  const span = t.length ? t[t.length - 1] - t[0] : 0;
  if (t.length < 8 || span < 3) {
    return { ...none(recentStep ? 'moving' : 'ok', ch, r, 0), quality: 'poor' };
  }
  const u = resampleSpline(t, xd, fs);
  const inv = new Float64Array(u.y.length);
  for (let i = 0; i < inv.length; i++) inv[i] = -u.y[i];
  const yd = filtfilt(inv, butterworthBandpass(fs, 0.5, 4), fs);
  const ac = robustRange(yd);
  const per = periodicity(yd, fs);
  const yDet = filtfilt(inv, butterworthBandpass(fs, 0.5, 8), fs);
  const peaks = detectSystolicPeaks(yDet, { fs, ...DEFAULT_ANALYSIS_OPTIONS.peaks });
  let hr: number | null = null;
  if (peaks.length >= 3) {
    const ibis: number[] = [];
    for (let i = 1; i < peaks.length; i++) ibis.push((peaks[i] - peaks[i - 1]) / fs);
    const md = median(ibis.slice(-6));
    if (md > 0) hr = 60 / md;
  }
  const good =
    !recentStep && ac >= 0.25 && ac <= 60 && per.r >= 0.5 && hr !== null && hr >= 40 && hr <= 180;
  return {
    fingerOn: true,
    fingerReason: recentStep ? 'moving' : 'ok',
    quality: good ? 'good' : 'poor',
    hrBpm: hr !== null ? Math.round(hr) : null,
    wave: Float32Array.from(yd),
    waveFs: fs,
    channel: ch,
    ac,
    dc: r,
  };
}

function indexRange(t: ArrayLike<number>, t0: number, t1: number): [number, number] {
  let a = 0;
  while (a < t.length && t[a] < t0) a++;
  let b = a;
  while (b < t.length && t[b] <= t1) b++;
  return [a, b];
}

function subSeries(s: SampleSeries, from: number, to: number): SampleSeries {
  return {
    t: s.t.subarray(from, to),
    r: s.r.subarray(from, to),
    g: s.g.subarray(from, to),
    b: s.b.subarray(from, to),
    sat: s.sat.subarray(from, to),
    frame: s.frame.subarray(from, to),
    length: Math.max(0, to - from),
  };
}
