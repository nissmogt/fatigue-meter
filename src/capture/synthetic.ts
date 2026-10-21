/**
 * Timer-driven SampleSource over the seeded generator in dsp/synthetic.ts.
 * Used by the in-app demo (`#/measure?source=synthetic`) and the e2e tests:
 * samples are released by a setInterval that checks performance.now(), so
 * Playwright's page.clock can fast-forward a whole measurement in a moment.
 */
import { generateSynthetic, syntheticPreset, type SyntheticOptions } from '../dsp/synthetic';
import type { Sample, SampleSeries } from '../dsp/types';
import {
  SourceError,
  type LockResult,
  type SampleSource,
  type SourceEvent,
  type SourceInfo,
  type SyntheticSourceOptions,
} from './source';

/** Long enough for the 120-s "precise" mode plus filter padding. */
export const SYNTHETIC_DEFAULT_DURATION_S = 140;
export const SYNTHETIC_DEFAULT_FPS = 30;

export function createSyntheticSource(opts: SyntheticSourceOptions): SampleSource {
  return new SyntheticSource(opts);
}

function buildOptions(o: SyntheticSourceOptions, fps: number): SyntheticOptions {
  const base: SyntheticOptions = o.preset ? syntheticPreset(o.preset, o.seed) : { seed: o.seed };
  const gen: SyntheticOptions = { ...base, fps, durationS: o.durationS ?? SYNTHETIC_DEFAULT_DURATION_S };
  if (o.hrBpm !== undefined && o.hrBpm > 0) gen.rr0Ms = 60000 / o.hrBpm;
  if (o.aLfMs !== undefined) gen.aLfMs = o.aLfMs;
  if (o.aHfMs !== undefined) gen.aHfMs = o.aHfMs;
  if (o.fingerOffWindows) gen.fingerOffWindows = o.fingerOffWindows;
  return gen;
}

class SyntheticSource implements SampleSource {
  readonly kind = 'synthetic' as const;
  private readonly fps: number;
  private readonly speed: number;
  private series: SampleSeries | null = null;
  private idx = 0;
  private t0 = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private exhausted = false;
  private readonly sampleCbs = new Set<(s: Sample) => void>();
  private readonly eventCbs = new Set<(e: SourceEvent) => void>();

  constructor(private readonly opts: SyntheticSourceOptions) {
    this.fps = opts.fps && opts.fps > 0 ? opts.fps : SYNTHETIC_DEFAULT_FPS;
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  }

  // The video element is not needed: nothing is drawn, samples come from the generator.
  async start(_video: HTMLVideoElement): Promise<SourceInfo> {
    if (this.running) throw new SourceError('unknown', 'synthetic source already started');
    this.series = generateSynthetic(buildOptions(this.opts, this.fps)).series;
    this.idx = 0;
    this.exhausted = false;
    this.running = true;
    this.t0 = performance.now();
    this.timer = setInterval(() => this.tick(), Math.max(1, Math.round(1000 / this.fps)));
    const info: SourceInfo = {
      kind: 'synthetic',
      label: 'Synthetic PPG',
      width: 64,
      height: 48,
      nominalFps: this.fps,
      timeBase: 'performance',
      capabilities: {
        torch: false,
        exposureLock: false,
        focusLock: false,
        whiteBalanceLock: false,
        frameCallback: 'timer',
      },
    };
    this.emit({ type: 'started', info });
    return info;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    this.series = null;
    this.emit({ type: 'stopped' });
  }

  onSample(cb: (s: Sample) => void): () => void {
    this.sampleCbs.add(cb);
    return () => void this.sampleCbs.delete(cb);
  }

  onEvent(cb: (e: SourceEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => void this.eventCbs.delete(cb);
  }

  async setTorch(_on: boolean): Promise<boolean> {
    this.emit({ type: 'torch', on: false, verified: false });
    return false;
  }

  async lockControls(): Promise<LockResult> {
    const result: LockResult = { exposure: false, focus: false, whiteBalance: false };
    this.emit({ type: 'locked', result });
    return result;
  }

  deliveredFps(): number {
    return this.running && !this.exhausted ? this.fps : 0;
  }

  /** Release every sample whose series time has been reached on the (scaled) wall clock. */
  private tick(): void {
    const series = this.series;
    if (!series || !this.running) return;
    const elapsedS = ((performance.now() - this.t0) / 1000) * this.speed;
    while (this.idx < series.length && series.t[this.idx] <= elapsedS) {
      const i = this.idx++;
      const s: Sample = {
        t: series.t[i],
        r: series.r[i],
        g: series.g[i],
        b: series.b[i],
        sat: series.sat[i],
        frame: series.frame[i],
      };
      for (const cb of this.sampleCbs) {
        try {
          cb(s);
        } catch (e) {
          console.error('sample listener failed', e);
        }
      }
    }
    if (this.idx >= series.length && !this.exhausted) {
      // Out of data: behave like a camera whose track ended.
      this.exhausted = true;
      this.clearTimer();
      this.emit({ type: 'interrupted', reason: 'track-ended' });
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private emit(e: SourceEvent): void {
    for (const cb of this.eventCbs) {
      try {
        cb(e);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
  }
}
