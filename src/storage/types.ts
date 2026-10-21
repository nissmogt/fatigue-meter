import type { AnalysisResult } from '../dsp/pipeline';
import type { SampleSeries, SampleSeriesJSON } from '../dsp/types';
import type { SourceKind } from '../capture/source';
import type { Comparison, Profile, ResultComments, Scores, SleepInfo, VasAnswers } from '../scoring/types';

export const SCHEMA_VERSION = 1;

export interface CaptureMeta {
  kind: SourceKind;
  label: string;
  width: number;
  height: number;
  nominalFps: number;
  deliveredFps: number;
  torch: boolean;
  locked: boolean;
  durationS: number;
  timeBase: string;
  userAgent: string;
}

export interface MeasurementRecord {
  id: string;
  createdAt: number;
  tz: string;
  schemaVersion: number;
  analysisVersion: string;
  vas: VasAnswers;
  sleep: SleepInfo;
  profile: Profile | null;
  capture: CaptureMeta;
  /** Raw samples (optional; enables re-analysis when the algorithm changes). */
  series: SampleSeries | null;
  /** Analysis without the recomputable waveform/PSD arrays. */
  analysis: Omit<AnalysisResult, 'waveform'>;
  scores: Scores;
  comparison: Comparison;
  comments: ResultComments;
}

export interface MeasurementSummary {
  id: string;
  createdAt: number;
  fatigueLevel: number | null;
  stressLevel: number | null;
  brainFatigue: number | null;
  lfHf: number | null;
  meanHR: number | null;
  rmssd: number | null;
  verdict: string;
  vasMean: number;
  /** Source of the recording; demo (synthetic) rows are shown but never feed comparisons. */
  kind: SourceKind;
}

export interface Settings {
  measureSeconds: 60 | 120;
  keepRawSeries: boolean;
  preferredCameraId: string | null;
  showStressT: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  measureSeconds: 60,
  keepRawSeries: true,
  preferredCameraId: null,
  showStressT: false,
};

export interface ExportBundle {
  app: 'fatigue-meter';
  exportedAt: number;
  schemaVersion: number;
  profile: Profile | null;
  settings: Settings;
  records: Array<Omit<MeasurementRecord, 'series' | 'analysis'> & {
    series: SampleSeriesJSON | null;
    analysis: unknown;
  }>;
}
