/**
 * Real-camera SampleSource: getUserMedia → <video> → frame sampler, plus
 * torch, AE/AF/AWB locks, wake lock and interruption reporting. start() must
 * run from a user-gesture chain (tap handler) so getUserMedia and play() are
 * allowed on iOS. All user-visible wording is mapped from SourceError codes
 * by the UI; messages here are technical.
 */
import type { Sample } from '../dsp/types';
import {
  IDEAL_FPS,
  IDEAL_HEIGHT,
  IDEAL_WIDTH,
  LOW_FPS_GRACE_S,
  LOW_FPS_LIMIT,
  LOW_FPS_WINDOW_S,
  RECENT_SAMPLES_S,
  START_TIMEOUT_MS,
  TORCH_VERIFY_BASELINE_S,
  TORCH_VERIFY_DELAY_MS,
  TORCH_VERIFY_MIN_RISE,
  TORCH_VERIFY_SAMPLE_MS,
} from './config';
import { createSampler, supportsFrameCallback, type Sampler } from './sampler';
import {
  SourceError,
  type CameraDevice,
  type CameraSourceOptions,
  type LockResult,
  type SampleSource,
  type SourceErrorCode,
  type SourceEvent,
  type SourceInfo,
} from './source';

export function createCameraSource(opts: CameraSourceOptions = {}): SampleSource {
  return new CameraSource(opts);
}

/** Video inputs known to the browser; labels are empty until permission was granted once. */
export async function listCameras(): Promise<CameraDevice[]> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  try {
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

// --- helpers -------------------------------------------------------------------

const REAR_LABEL = /back|rear|environment/i;
/** iOS virtual multi-lens devices switch lenses mid-measurement; avoid them. */
const MULTI_LENS_LABEL = /dual|triple|ultra|tele|wide/i;

function mapMediaError(e: unknown): SourceError {
  if (e instanceof SourceError) return e;
  const name = typeof (e as { name?: unknown })?.name === 'string' ? (e as { name: string }).name : '';
  const detail = e instanceof Error ? e.message : String(e);
  let code: SourceErrorCode = 'unknown';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      code = 'permission-denied';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      code = 'no-camera';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      code = 'in-use';
      break;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      code = 'overconstrained';
      break;
  }
  return new SourceError(code, `${name || 'Error'}: ${detail}`, e);
}

function constraintsFor(opts: CameraSourceOptions, deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: opts.idealWidth ?? IDEAL_WIDTH },
    height: { ideal: opts.idealHeight ?? IDEAL_HEIGHT },
    frameRate: { ideal: opts.idealFps ?? IDEAL_FPS },
  };
  // facingMode is never `exact`: the fake camera and some multi-lens Androids reject it.
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: opts.facing ?? 'environment' };
  return { video, audio: false };
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

function readCapabilities(track: MediaStreamTrack): MediaTrackCapabilities {
  if (typeof track.getCapabilities !== 'function') return {};
  try {
    return track.getCapabilities() ?? {};
  } catch {
    return {};
  }
}

function hasManual(modes: unknown): boolean {
  return Array.isArray(modes) && modes.includes('manual');
}

/** A finite number that violates no reported bound (missing bounds do not block). */
function inRange(v: number | undefined, range: MediaSettingsRange | undefined): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (range?.min !== undefined && v < range.min) return false;
  if (range?.max !== undefined && v > range.max) return false;
  return true;
}

/**
 * Apply one advanced constraint set. Browsers drop unsatisfiable advanced
 * sets silently, so a resolved promise is confirmed against the settings
 * when the browser reports the mode back.
 */
async function tryLock(
  track: MediaStreamTrack,
  set: MediaTrackConstraintSet,
  mode: (s: MediaTrackSettings) => string | undefined,
): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [set] });
  } catch {
    return false;
  }
  let reported: string | undefined;
  try {
    reported = mode(track.getSettings());
  } catch {
    reported = undefined;
  }
  return reported === undefined || reported === 'manual';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once the element shows real frames; rejects 'unknown' at the deadline. */
function waitForVideo(video: HTMLVideoElement, deadline: number, cause: unknown): Promise<void> {
  const ready = () => video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = 0;
    let poll = 0;
    const cleanup = () => {
      video.removeEventListener('playing', check);
      video.removeEventListener('loadedmetadata', check);
      clearTimeout(timer);
      clearInterval(poll);
    };
    const check = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    video.addEventListener('playing', check);
    video.addEventListener('loadedmetadata', check);
    // Events may have fired before the listeners were attached; poll as well.
    poll = window.setInterval(check, 100);
    timer = window.setTimeout(() => {
      cleanup();
      reject(new SourceError('unknown', 'no video frames before the start timeout', cause));
    }, Math.max(0, deadline - performance.now()));
  });
}

// --- source ----------------------------------------------------------------------

type State = 'idle' | 'starting' | 'running';

class CameraSource implements SampleSource {
  readonly kind = 'camera' as const;
  private readonly opts: CameraSourceOptions;
  private readonly sampler: Sampler;
  private readonly sampleCbs = new Set<(s: Sample) => void>();
  private readonly eventCbs = new Set<(e: SourceEvent) => void>();
  private state: State = 'idle';
  /** Bumped by every start()/stop(); in-flight async work aborts on mismatch. */
  private gen = 0;
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private video: HTMLVideoElement | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  /** Our belief about the physical torch (getSettings().torch is not trustworthy). */
  private torchOn = false;
  private interrupted = false;
  private startedAt = 0;
  private fpsTimer: ReturnType<typeof setInterval> | null = null;
  private trackCleanup: (() => void) | null = null;
  /** Last RECENT_SAMPLES_S seconds, for torch verification. */
  private readonly recent: Sample[] = [];
  private firstSampleResolve: (() => void) | null = null;

  constructor(opts: CameraSourceOptions) {
    this.opts = opts;
    this.sampler = createSampler({
      cropFraction: opts.cropFraction,
      gridSize: opts.gridSize,
      saturationLevel: opts.saturationLevel,
    });
  }

  async start(video: HTMLVideoElement): Promise<SourceInfo> {
    if (this.state !== 'idle') throw new SourceError('unknown', 'camera source already started');
    const gen = ++this.gen;
    this.state = 'starting';
    this.video = video;
    this.interrupted = false;
    this.torchOn = false;
    this.recent.length = 0;
    try {
      const info = await this.doStart(video, gen);
      this.state = 'running';
      this.emit({ type: 'started', info });
      return info;
    } catch (e) {
      if (gen !== this.gen) {
        // stop() ran meanwhile and already released everything.
        throw new SourceError('ended', 'stopped during start', e);
      }
      const err = mapMediaError(e);
      await this.teardown();
      this.state = 'idle';
      this.emit({ type: 'error', error: err });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    this.gen++;
    this.state = 'idle';
    await this.teardown();
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

  async setTorch(on: boolean): Promise<boolean> {
    const track = this.track;
    if (!track || this.state !== 'running') return false;
    const tApplied = this.lastSampleT();
    const baseline = this.meanRed((t) => t >= tApplied - TORCH_VERIFY_BASELINE_S);
    try {
      // Always attempted: Chromium rejects when the capability is absent;
      // WebKit >= 17.4 honours it on a camera with a flash.
      await track.applyConstraints({ advanced: [{ torch: on }] });
    } catch {
      // Nothing changed physically. A torch that cannot be switched off goes
      // out when stop() stops the track.
      this.emit({ type: 'torch', on: this.torchOn, verified: false });
      return this.torchOn;
    }
    // A resolved promise is not proof: Firefox (no `torch` member), WebKit < 17.4
    // and WebKit on a camera without a flash drop the advanced set silently.
    // Chromium rejects when the capability is absent and WebKit 17.4+ reports
    // capabilities.torch === true only when the device has one, so a reported
    // capability plus a resolved promise counts as confirmation; otherwise the
    // brightness change is the only evidence (plan: promise + brightness jump).
    // getSettings().torch is never consulted (not trustworthy, absent in WebKit).
    this.torchOn = on; // belief for reapplyTorch()/teardown(); a wrong belief only costs a harmless no-op request
    const rise = await this.verifyTorch(on, baseline, tApplied);
    if (this.state !== 'running') return false;
    const verified = rise || readCapabilities(track).torch === true;
    const result = on && verified;
    this.emit({ type: 'torch', on: result, verified: rise });
    return result;
  }

  async lockControls(): Promise<LockResult> {
    const result: LockResult = { exposure: false, focus: false, whiteBalance: false };
    const track = this.track;
    if (!track || this.state !== 'running') return result;
    const caps = readCapabilities(track);
    const settings = track.getSettings();
    // Manual exposure without an exposureTime would leave the sensor at an
    // undefined setting, so each lock needs a valid current value.
    if (hasManual(caps.exposureMode) && inRange(settings.exposureTime, caps.exposureTime)) {
      result.exposure = await tryLock(
        track,
        { exposureMode: 'manual', exposureTime: settings.exposureTime },
        (s) => s.exposureMode,
      );
    }
    if (hasManual(caps.focusMode) && inRange(settings.focusDistance, caps.focusDistance)) {
      result.focus = await tryLock(
        track,
        { focusMode: 'manual', focusDistance: settings.focusDistance },
        (s) => s.focusMode,
      );
    }
    if (hasManual(caps.whiteBalanceMode)) {
      result.whiteBalance = await tryLock(track, { whiteBalanceMode: 'manual' }, (s) => s.whiteBalanceMode);
    }
    if (this.state !== 'running') return result; // stopped while locking
    this.emit({ type: 'locked', result });
    return result;
  }

  deliveredFps(): number {
    return this.state === 'running' ? this.sampler.deliveredFps() : 0;
  }

  // --- start sequence ---------------------------------------------------------

  private async doStart(video: HTMLVideoElement, gen: number): Promise<SourceInfo> {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new SourceError('insecure-context', 'getUserMedia needs a secure context');
    }
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      throw new SourceError('unsupported', 'navigator.mediaDevices.getUserMedia is unavailable');
    }
    // Checked before the permission prompt: without requestVideoFrameCallback
    // there is no way to observe camera frames (see sampler.ts).
    if (!supportsFrameCallback(video)) {
      throw new SourceError('unsupported', 'HTMLVideoElement.requestVideoFrameCallback is required');
    }

    let stream = await this.acquire(md, this.opts.deviceId);
    this.checkGen(gen, stream);
    if (!this.opts.deviceId) {
      const preferred = await this.findPlainRearCamera(md, stream);
      this.checkGen(gen, stream);
      if (preferred) {
        try {
          const better = await md.getUserMedia(constraintsFor(this.opts, preferred));
          stopStream(stream);
          stream = better;
        } catch {
          /* keep the stream we already have */
        }
        this.checkGen(gen, stream);
      }
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stopStream(stream);
      throw new SourceError('no-camera', 'stream has no video track');
    }
    this.stream = stream;
    this.track = track;

    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.srcObject = stream;
    let playError: unknown = null;
    try {
      await video.play();
    } catch (e) {
      // AbortError = a newer load interrupted play(); other rejections are
      // judged by whether frames arrive before the deadline.
      if ((e as { name?: string })?.name !== 'AbortError') playError = e;
    }
    this.checkGen(gen);
    const deadline = performance.now() + START_TIMEOUT_MS;
    await waitForVideo(video, deadline, playError);
    this.checkGen(gen);

    const { loop, timeBase } = this.sampler.start(video, this.handleSample);
    await this.waitForFirstSample(deadline);
    this.checkGen(gen);

    const settings = track.getSettings();
    const caps = readCapabilities(track);
    const info: SourceInfo = {
      kind: 'camera',
      label: track.label || '',
      deviceId: settings.deviceId,
      width: settings.width ?? video.videoWidth,
      height: settings.height ?? video.videoHeight,
      nominalFps: settings.frameRate ?? this.opts.idealFps ?? IDEAL_FPS,
      timeBase,
      capabilities: {
        torch: caps.torch === true,
        exposureLock: hasManual(caps.exposureMode),
        focusLock: hasManual(caps.focusMode),
        whiteBalanceLock: hasManual(caps.whiteBalanceMode),
        frameCallback: loop,
      },
    };

    await this.requestWakeLock();
    this.checkGen(gen);
    this.attachTrackListeners(track);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.startedAt = performance.now();
    this.fpsTimer = setInterval(() => this.checkFps(), 1000);
    return info;
  }

  private async acquire(md: MediaDevices, deviceId: string | undefined): Promise<MediaStream> {
    try {
      return await md.getUserMedia(constraintsFor(this.opts, deviceId));
    } catch (e) {
      const err = mapMediaError(e);
      if (deviceId && (err.code === 'overconstrained' || err.code === 'no-camera')) {
        // A remembered deviceId goes stale when site data is cleared; fall back to facing mode.
        return this.acquire(md, undefined);
      }
      if (!deviceId && err.code === 'overconstrained') {
        try {
          return await md.getUserMedia({ video: true });
        } catch (e2) {
          throw mapMediaError(e2);
        }
      }
      throw err;
    }
  }

  /** deviceId of a plain rear camera when the current track is a different (virtual) one. */
  private async findPlainRearCamera(md: MediaDevices, stream: MediaStream): Promise<string | null> {
    if (typeof md.enumerateDevices !== 'function') return null;
    try {
      const devices = await md.enumerateDevices();
      const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
      const plain = devices.find(
        (d) => d.kind === 'videoinput' && REAR_LABEL.test(d.label) && !MULTI_LENS_LABEL.test(d.label),
      );
      if (!plain || !plain.deviceId || plain.deviceId === current) return null;
      return plain.deviceId;
    } catch {
      return null;
    }
  }

  private checkGen(gen: number, stream?: MediaStream): void {
    if (gen === this.gen) return;
    if (stream && stream !== this.stream) stopStream(stream);
    throw new SourceError('ended', 'stopped during start');
  }

  private waitForFirstSample(deadline: number): Promise<void> {
    if (this.recent.length > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstSampleResolve = null;
        reject(new SourceError('unknown', 'no frames were delivered before the start timeout'));
      }, Math.max(0, deadline - performance.now()));
      this.firstSampleResolve = () => {
        clearTimeout(timer);
        this.firstSampleResolve = null;
        resolve();
      };
    });
  }

  // --- running -----------------------------------------------------------------------

  private readonly handleSample = (s: Sample): void => {
    const recent = this.recent;
    recent.push(s);
    const cutoff = s.t - RECENT_SAMPLES_S;
    while (recent.length > 0 && recent[0].t < cutoff) recent.shift();
    for (const cb of this.sampleCbs) {
      try {
        cb(s);
      } catch (e) {
        console.error('sample listener failed', e);
      }
    }
    if (this.firstSampleResolve) this.firstSampleResolve();
  };

  private attachTrackListeners(track: MediaStreamTrack): void {
    const onEnded = () => this.interrupt('track-ended');
    const onMute = () => this.interrupt('track-muted');
    const onUnmute = () => this.reapplyTorch();
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    this.trackCleanup = () => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    };
  }

  private readonly onVisibility = (): void => {
    if (this.state !== 'running') return;
    if (document.visibilityState === 'hidden') {
      this.interrupt('hidden');
      return;
    }
    void this.requestWakeLock();
    this.reapplyTorch();
  };

  /** One interruption per run: the UI aborts on the first and calls stop(). */
  private interrupt(reason: 'track-ended' | 'track-muted' | 'hidden' | 'low-fps'): void {
    if (this.interrupted || this.state !== 'running') return;
    this.interrupted = true;
    this.emit({ type: 'interrupted', reason });
  }

  private checkFps(): void {
    if (this.state !== 'running' || this.interrupted) return;
    if (performance.now() - this.startedAt < LOW_FPS_GRACE_S * 1000) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // One frame of slack: a source running exactly at the limit otherwise
    // flips between n and n + 1 frames in the window and could abort.
    if (this.sampler.deliveredFps() < LOW_FPS_LIMIT - 1 / LOW_FPS_WINDOW_S) this.interrupt('low-fps');
  }

  private reapplyTorch(): void {
    const track = this.track;
    if (!track || !this.torchOn) return;
    track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {
      /* the next setTorch call reports the real state */
    });
  }

  private async requestWakeLock(): Promise<void> {
    const gen = this.gen;
    try {
      const wl = navigator.wakeLock;
      if (!wl || typeof wl.request !== 'function') return;
      if (this.wakeLock && !this.wakeLock.released) return;
      const sentinel = await wl.request('screen');
      if (gen !== this.gen || this.state === 'idle') {
        // stop() ran while the request was pending; teardown found nothing to release.
        sentinel.release().catch(() => {});
        return;
      }
      this.wakeLock = sentinel;
    } catch {
      this.wakeLock = null; // non-fatal: the screen may just dim
    }
  }

  private lastSampleT(): number {
    const n = this.recent.length;
    return n > 0 ? this.recent[n - 1].t : 0;
  }

  private meanRed(keep: (t: number) => boolean): number | null {
    let sum = 0;
    let n = 0;
    for (const s of this.recent) {
      if (keep(s.t)) {
        sum += s.r;
        n++;
      }
    }
    return n > 0 ? sum / n : null;
  }

  /** The torch is real when the mean red moves the expected way after the request. */
  private async verifyTorch(on: boolean, baseline: number | null, tApplied: number): Promise<boolean> {
    await sleep(TORCH_VERIFY_DELAY_MS + TORCH_VERIFY_SAMPLE_MS);
    if (baseline === null) return false;
    const after = this.meanRed((t) => t > tApplied + TORCH_VERIFY_DELAY_MS / 1000);
    if (after === null) return false;
    const delta = after - baseline;
    return on ? delta >= TORCH_VERIFY_MIN_RISE : delta <= -TORCH_VERIFY_MIN_RISE;
  }

  // --- shutdown ------------------------------------------------------------------------

  private async teardown(): Promise<void> {
    if (this.fpsTimer !== null) {
      clearInterval(this.fpsTimer);
      this.fpsTimer = null;
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.trackCleanup?.();
    this.trackCleanup = null;
    this.sampler.stop();
    this.firstSampleResolve = null;
    const track = this.track;
    const stream = this.stream;
    if (track && this.torchOn) {
      try {
        await track.applyConstraints({ advanced: [{ torch: false }] });
      } catch {
        /* stopping the track below switches the torch off */
      }
    }
    this.torchOn = false;
    if (stream) stopStream(stream);
    if (this.video) this.video.srcObject = null;
    this.stream = null;
    this.track = null;
    this.video = null;
    this.recent.length = 0;
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch {
        /* already released */
      }
      this.wakeLock = null;
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
