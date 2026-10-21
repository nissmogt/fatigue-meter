/**
 * Frame loop: turns each presented video frame into one Sample (channel means
 * of the centre crop). Uses requestVideoFrameCallback where it exists, else a
 * requestAnimationFrame loop deduplicated on `currentTime`. The time base is
 * chosen once in start() and never mixed within a session.
 */
import type { Sample } from '../dsp/types';
import { CROP_FRACTION, GRID_SIZE, LOW_FPS_WINDOW_S, SATURATION_LEVEL } from './config';

export type FrameLoop = 'rvfc' | 'raf';
export type TimeBase = 'mediaTime' | 'performance';

export interface SamplerOptions {
  cropFraction?: number;
  gridSize?: number;
  saturationLevel?: number;
}

export interface Sampler {
  /** Picks the frame loop and time base (once per start) and begins delivering samples. */
  start(video: HTMLVideoElement, onSample: (s: Sample) => void): { loop: FrameLoop; timeBase: TimeBase };
  stop(): void;
  /** Frames delivered per second over the last LOW_FPS_WINDOW_S seconds (0 when stopped). */
  deliveredFps(): number;
  readonly running: boolean;
}

export function createSampler(opts: SamplerOptions = {}): Sampler {
  return new FrameSampler(opts);
}

/** Ring size for frame timestamps: covers the fps window at up to 120 fps. */
const STAMP_RING = 512;

class FrameSampler implements Sampler {
  private readonly grid: number;
  private readonly cropFraction: number;
  private readonly satLevel: number;
  private ctx: CanvasRenderingContext2D | null = null;
  private video: HTMLVideoElement | null = null;
  private onSample: ((s: Sample) => void) | null = null;
  private rvfcHandle = 0;
  private rafHandle = 0;
  private lastCurrentTime = -1;
  private frameCounter = 0;
  private startedAt = 0;
  private readonly stamps = new Float64Array(STAMP_RING);
  private head = 0;
  private count = 0;
  running = false;

  constructor(opts: SamplerOptions) {
    this.grid = Math.max(2, Math.floor(opts.gridSize ?? GRID_SIZE));
    this.cropFraction = Math.min(1, Math.max(0.05, opts.cropFraction ?? CROP_FRACTION));
    this.satLevel = opts.saturationLevel ?? SATURATION_LEVEL;
  }

  start(video: HTMLVideoElement, onSample: (s: Sample) => void): { loop: FrameLoop; timeBase: TimeBase } {
    if (this.running) this.stop();
    if (!this.ctx) {
      // Created once; willReadFrequently keeps the backing store on the CPU
      // so getImageData does not stall on a GPU read-back every frame.
      const canvas = document.createElement('canvas');
      canvas.width = this.grid;
      canvas.height = this.grid;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2d canvas context unavailable');
      this.ctx = ctx;
    }
    this.video = video;
    this.onSample = onSample;
    this.running = true;
    this.head = 0;
    this.count = 0;
    this.lastCurrentTime = -1;
    this.frameCounter = 0;
    this.startedAt = performance.now();
    if (typeof (video as Partial<HTMLVideoElement>).requestVideoFrameCallback === 'function') {
      this.rvfcHandle = video.requestVideoFrameCallback(this.onVideoFrame);
      return { loop: 'rvfc', timeBase: 'mediaTime' };
    }
    this.rafHandle = requestAnimationFrame(this.onAnimationFrame);
    return { loop: 'raf', timeBase: 'performance' };
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const video = this.video;
    if (video && this.rvfcHandle && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rvfcHandle = 0;
    this.rafHandle = 0;
    this.video = null;
    this.onSample = null;
  }

  deliveredFps(): number {
    if (!this.running) return 0;
    const now = performance.now();
    const elapsed = now - this.startedAt;
    if (elapsed < 250) return 0;
    const span = Math.min(LOW_FPS_WINDOW_S * 1000, elapsed);
    const cutoff = now - span;
    let n = 0;
    for (let k = 0; k < this.count; k++) {
      const idx = (this.head - 1 - k + STAMP_RING) % STAMP_RING;
      if (this.stamps[idx] < cutoff) break;
      n++;
    }
    return n / (span / 1000);
  }

  private readonly onVideoFrame = (_now: DOMHighResTimeStamp, meta: VideoFrameCallbackMetadata): void => {
    const video = this.video;
    if (!this.running || !video) return;
    // Re-register first so a throw in process() cannot silently end the loop.
    this.rvfcHandle = video.requestVideoFrameCallback(this.onVideoFrame);
    this.process(meta.mediaTime, meta.presentedFrames);
  };

  private readonly onAnimationFrame = (): void => {
    const video = this.video;
    if (!this.running || !video) return;
    this.rafHandle = requestAnimationFrame(this.onAnimationFrame);
    const ct = video.currentTime;
    if (ct === this.lastCurrentTime) return; // same frame still showing
    this.lastCurrentTime = ct;
    this.frameCounter++;
    this.process(performance.now() / 1000, this.frameCounter);
  };

  private process(t: number, frame: number): void {
    const video = this.video;
    const ctx = this.ctx;
    const onSample = this.onSample;
    if (!video || !ctx || !onSample) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return;
    const sw = Math.max(1, Math.round(vw * this.cropFraction));
    const sh = Math.max(1, Math.round(vh * this.cropFraction));
    const sx = (vw - sw) >> 1;
    const sy = (vh - sh) >> 1;
    const grid = this.grid;
    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, grid, grid);
    } catch {
      return; // the stream is (re)starting; skip this frame
    }
    const data = ctx.getImageData(0, 0, grid, grid).data;
    const lvl = this.satLevel;
    let r = 0;
    let g = 0;
    let b = 0;
    let sat = 0;
    for (let i = 0; i < data.length; i += 4) {
      const rv = data[i];
      r += rv;
      g += data[i + 1];
      b += data[i + 2];
      if (rv >= lvl) sat++;
    }
    const n = grid * grid;
    this.stamps[this.head] = performance.now();
    this.head = (this.head + 1) % STAMP_RING;
    if (this.count < STAMP_RING) this.count++;
    onSample({ t, r: r / n, g: g / n, b: b / n, sat: sat / n, frame });
  }
}
