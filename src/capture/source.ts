/**
 * Contract between the measurement screen and the two sample sources
 * (real camera, synthetic). Both deliver `Sample`s on one time base.
 */
import type { Sample } from '../dsp/types';

export type SourceKind = 'camera' | 'synthetic';

export type SourceErrorCode =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-camera'
  | 'in-use'
  | 'overconstrained'
  | 'ended'
  | 'unknown';

export class SourceError extends Error {
  constructor(
    public readonly code: SourceErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface SourceCapabilities {
  torch: boolean;
  exposureLock: boolean;
  focusLock: boolean;
  whiteBalanceLock: boolean;
  frameCallback: 'rvfc' | 'raf' | 'timer';
}

export interface SourceInfo {
  kind: SourceKind;
  label: string;
  deviceId?: string;
  width: number;
  height: number;
  nominalFps: number;
  /** Clock the samples are stamped with; decided from the first frames (see timebase.ts). */
  timeBase: 'mediaTime' | 'captureTime' | 'presentationTime' | 'performance';
  /** Why that clock was chosen (diagnostics). */
  timeBaseReason?: string;
  capabilities: SourceCapabilities;
}

export interface LockResult {
  exposure: boolean;
  focus: boolean;
  whiteBalance: boolean;
}

export type SourceEvent =
  | { type: 'started'; info: SourceInfo }
  | { type: 'torch'; on: boolean; verified: boolean }
  | { type: 'locked'; result: LockResult }
  | { type: 'interrupted'; reason: 'track-ended' | 'track-muted' | 'hidden' | 'low-fps' }
  | { type: 'error'; error: SourceError }
  | { type: 'stopped' };

export interface SampleSource {
  readonly kind: SourceKind;
  /** Call from a user-gesture chain (tap handler). Resolves when frames flow. */
  start(video: HTMLVideoElement): Promise<SourceInfo>;
  /** Idempotent. Turns the torch off (or stops the track), releases the camera. */
  stop(): Promise<void>;
  onSample(cb: (s: Sample) => void): () => void;
  onEvent(cb: (e: SourceEvent) => void): () => void;
  /** Resolves the actual state; false when unsupported or rejected. */
  setTorch(on: boolean): Promise<boolean>;
  /** Lock AE/AF/AWB where supported. No-op elsewhere. Call after the finger is stable. */
  lockControls(): Promise<LockResult>;
  /** Mean delivered frames per second over the last few seconds (0 before start). */
  deliveredFps(): number;
}

export interface CameraSourceOptions {
  deviceId?: string;
  facing?: 'environment' | 'user';
  idealWidth?: number;
  idealHeight?: number;
  idealFps?: number;
  /** Fraction of the frame (per axis) used for the centre crop. */
  cropFraction?: number;
  /** Side of the square analysis canvas in pixels. */
  gridSize?: number;
  /** Red value at or above which a pixel counts as saturated. */
  saturationLevel?: number;
}

export interface SyntheticSourceOptions {
  seed: number;
  fps?: number;
  durationS?: number;
  hrBpm?: number;
  aLfMs?: number;
  aHfMs?: number;
  /** Windows [startS, endS] during which the "finger" is off the lens. */
  fingerOffWindows?: Array<[number, number]>;
  preset?: 'clean' | 'poor' | 'saturated';
  /** Playback speed multiplier (tests). 1 = real time. */
  speed?: number;
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}
