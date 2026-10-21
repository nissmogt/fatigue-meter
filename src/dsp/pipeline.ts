/**
 * Pipeline contract: options, result types and the quality policy. The
 * implementation of `analyzePPG` / `liveSnapshot` lives in pipeline-impl.ts
 * so that screens and tests can depend on this file alone.
 */
import type { Channel, SampleSeries } from './types';

export const ANALYSIS_VERSION = '2026.10.2';

export type QualityVerdict = 'full' | 'time-only' | 'fail';

export type GateReason =
  | 'too-short'
  | 'no-signal'
  | 'saturated'
  | 'too-few-beats'
  | 'too-many-rejected'
  | 'long-gap'
  | 'low-quality'
  | 'dropped-frames';

export interface PeakOptions {
  /** Band-pass for detection (NeuroKit2 Elgendi: 0.5–8 Hz). */
  band: [number, number];
  /** Elgendi W1, seconds (0.111). */
  peakWindowS: number;
  /** Elgendi W2, seconds (0.667). */
  beatWindowS: number;
  /** Elgendi beta offset (0.02). */
  beatOffset: number;
  /** Refractory period, seconds (0.3). */
  minDelayS: number;
}

export interface NnOptions {
  minMs: number;
  maxMs: number;
  /** Neighbours on each side for the local-median rule. */
  medianHalfWindow: number;
  /** Relative deviation from the local median that rejects an interval. */
  tolerance: number;
}

export interface SpectrumOptions {
  /** Oversampling factor of the Lomb-Scargle grid. */
  ofac: number;
  /** Upper frequency bound (clamped to the beat-series Nyquist). */
  fMax: number;
  lf: [number, number];
  hf: [number, number];
  detrend: 'mean' | 'linear';
}

export interface QualityPolicy {
  minBeats: number;
  fullAcceptedFraction: number;
  timeOnlyAcceptedFraction: number;
  maxGapS: number;
  maxDropFraction: number;
  /** Fraction of the window that must pass the per-segment check for FULL. */
  minGoodFraction: number;
  /** Per-segment (Orphanidou) rules. */
  segmentS: number;
  hrMin: number;
  hrMax: number;
  maxIntervalRatio: number;
  minTemplateCorr: number;
  /**
   * Beats whose template correlation is below this are artefacts and are
   * excluded from interval cleaning and HRV (per-beat correlation is noisier
   * than the segment mean, hence the lower bar than minTemplateCorr).
   */
  minBeatCorr: number;
}

export interface AnalysisOptions {
  channel: 'auto' | Channel;
  /** Analysis window in series seconds; samples outside are filter padding. */
  window?: { startS: number; endS: number };
  /** Uniform processing rate (Hz). */
  fsUniform: number;
  /** Display band for the stored waveform. */
  displayBand: [number, number];
  peaks: PeakOptions;
  nn: NnOptions;
  spectrum: SpectrumOptions;
  quality: QualityPolicy;
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  channel: 'auto',
  fsUniform: 60,
  displayBand: [0.5, 4],
  peaks: { band: [0.5, 8], peakWindowS: 0.111, beatWindowS: 0.667, beatOffset: 0.02, minDelayS: 0.3 },
  nn: { minMs: 300, maxMs: 2000, medianHalfWindow: 5, tolerance: 0.25 },
  spectrum: { ofac: 4, fMax: 0.5, lf: [0.04, 0.15], hf: [0.15, 0.4], detrend: 'linear' },
  quality: {
    minBeats: 40,
    fullAcceptedFraction: 0.95,
    timeOnlyAcceptedFraction: 0.9,
    maxGapS: 3,
    maxDropFraction: 0.1,
    minGoodFraction: 50 / 60,
    segmentS: 10,
    hrMin: 40,
    hrMax: 180,
    maxIntervalRatio: 2.2,
    minTemplateCorr: 0.86,
    minBeatCorr: 0.8,
  },
};

export interface HrvTime {
  nBeats: number;
  meanNN: number;
  meanHR: number;
  sdnn: number;
  rmssd: number;
  lnRmssd: number;
  pnn50: number;
  cvnn: number;
  sd1: number;
  sd2: number;
}

export interface HrvFreq {
  lf: number;
  hf: number;
  /** LF + HF (VLF is not resolvable in 60 s). */
  tp: number;
  lfHf: number;
  lfNu: number;
  hfNu: number;
  lnLf: number;
  lnHf: number;
  lnLfPlusHf: number;
  lnLfHf: number;
  /** Grid spacing in Hz. */
  dfHz: number;
  /** Independent frequency cells inside the LF band (T × bandwidth). */
  lfBins: number;
  /** Dominant peak in 0.1–0.5 Hz, a respiration estimate; null if none. */
  respHz: number | null;
  psd: { f: Float64Array; p: Float64Array };
}

export interface Quality {
  acceptedBeats: number;
  totalBeats: number;
  acceptedFraction: number;
  /** Longest stretch of the window not covered by an accepted interval (lead-in and tail included), seconds. */
  longestGapS: number;
  dropFraction: number;
  goodFraction: number;
  templateCorr: number;
  perfusion: number;
  skewness: number;
  periodicity: number;
  verdict: QualityVerdict;
  reasons: GateReason[];
}

export interface AnalysisResult {
  version: string;
  fsSource: number;
  fsUniform: number;
  channel: Channel;
  channelReason: string;
  t0: number;
  durationS: number;
  /** Band-passed display waveform over the window at fsUniform (positive = systole). */
  waveform: Float32Array;
  /** Beat times in series seconds (refined; artefact beats below quality.minBeatCorr are excluded). */
  peaks: Float64Array;
  nn: { t: Float64Array; ms: Float64Array; accepted: Uint8Array };
  time: HrvTime | null;
  freq: HrvFreq | null;
  quality: Quality;
}

export type LiveQuality = 'none' | 'poor' | 'good';
export type FingerReason = 'ok' | 'no-finger' | 'too-dark' | 'saturated' | 'moving';

export interface LiveSnapshot {
  fingerOn: boolean;
  fingerReason: FingerReason;
  quality: LiveQuality;
  hrBpm: number | null;
  /** Recent band-passed wave for display (positive = systole). */
  wave: Float32Array;
  waveFs: number;
  channel: Channel;
  /** Peak-to-peak of the chosen channel over the window (8-bit units). */
  ac: number;
  dc: number;
  /** Mean beat-template correlation over the window (NaN when fewer than 3 full beats). */
  templateCorr: number;
}
