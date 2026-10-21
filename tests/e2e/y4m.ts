/**
 * Renders the seeded synthetic pulse as a tiny Y4M video for Chromium's
 * file-backed fake camera (--use-file-for-fake-video-capture). Every frame
 * is one uniform colour whose red channel follows the clean pulse shape of
 * the generator (systole = darker, like a transilluminated fingertip), so the
 * centre-crop means the app samples reproduce the generator's beat times.
 *
 * Playwright transpiles this file; it imports the generator from src/ by a
 * relative path and has no dependency beyond node:fs.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSynthetic, pulseShape, SYNTHETIC_DEFAULTS } from '../../src/dsp/synthetic';

export interface Y4mOptions {
  /** Frame width in pixels (even). */
  width?: number;
  /** Frame height in pixels (even). */
  height?: number;
  fps?: number;
  durationS?: number;
  /** Seed of the synthetic RR series (same generator as the unit tests). */
  seed: number;
}

export interface Y4mInfo {
  path: string;
  width: number;
  height: number;
  fps: number;
  durationS: number;
  seed: number;
  frames: number;
  bytes: number;
  /** True systolic-peak times of the rendered pulse, seconds from the first frame. */
  beatTimes: number[];
  /** Mean heart rate of the RR model (60000 / RR0), bpm. */
  expectedHrBpm: number;
}

/** The fixture the e2e camera tier records against (written by global-setup.ts). */
export const FIXTURE: Required<Y4mOptions> = { width: 64, height: 48, fps: 30, durationS: 75, seed: 7 };

/** Heart rate the fixture encodes: the generator's default RR0 of 900 ms → 66.7 bpm. */
export const FIXTURE_HR_BPM = 60000 / SYNTHETIC_DEFAULTS.rr0Ms;

/** Absolute path of the cached fixture, next to this file (git-ignored). */
export function fixtureY4mPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '.cache', 'finger.y4m');
}

/**
 * Plain `C420` (not ffmpeg's `C420mpeg2`, which Chromium rejects); `Ip`
 * progressive, square pixels, `F<fps>:1`.
 */
export function y4mHeader(width: number, height: number, fps: number): string {
  return `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420\n`;
}

/** Red level of the frame at pulse value p: 190 at rest, darker in systole, never near clipping. */
export function redForPulse(p: number): number {
  // p peaks at ~1.0 (systolic Gaussian) so red stays in 165..190; clamp as a guard.
  return Math.min(200, Math.max(100, 190 - 25 * p));
}

export const FRAME_GREEN = 60;
export const FRAME_BLUE = 50;

/** BT.601 limited-range (studio swing) Y'CbCr of an 8-bit RGB triple. */
export function rgbToYuv601(r: number, g: number, b: number): [number, number, number] {
  const y = 16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255;
  const cb = 128 + (-37.797 * r - 74.203 * g + 112.0 * b) / 255;
  const cr = 128 + (112.0 * r - 93.786 * g - 18.214 * b) / 255;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return [clamp(y, 16, 235), clamp(cb, 16, 240), clamp(cr, 16, 240)];
}

/** Writes the Y4M file and returns what was rendered. Pure apart from the file write. */
export function writeY4m(path: string, opts: Y4mOptions): Y4mInfo {
  const width = opts.width ?? FIXTURE.width;
  const height = opts.height ?? FIXTURE.height;
  const fps = opts.fps ?? FIXTURE.fps;
  const durationS = opts.durationS ?? FIXTURE.durationS;
  if (width % 2 !== 0 || height % 2 !== 0 || width <= 0 || height <= 0) {
    throw new Error(`y4m 4:2:0 needs even, positive dimensions (got ${width}x${height})`);
  }
  if (!(fps > 0) || !(durationS > 0)) throw new Error('y4m needs positive fps and duration');

  // Only the beat times are used: the frame colour is the noise-free pulse
  // shape, the camera path adds its own quantisation and timing jitter.
  const synth = generateSynthetic({ seed: opts.seed, fps, durationS });
  const beatTimes = Array.from(synth.beatTimes);

  const frames = Math.round(durationS * fps);
  const header = Buffer.from(y4mHeader(width, height, fps), 'ascii');
  const frameTag = Buffer.from('FRAME\n', 'ascii');
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  const frameBytes = frameTag.length + ySize + 2 * cSize;
  const out = Buffer.alloc(header.length + frames * frameBytes);
  header.copy(out, 0);

  let offset = header.length;
  for (let k = 0; k < frames; k++) {
    const t = k / fps;
    const p = pulseShape(beatTimes, t);
    const [y, cb, cr] = rgbToYuv601(redForPulse(p), FRAME_GREEN, FRAME_BLUE);
    frameTag.copy(out, offset);
    offset += frameTag.length;
    out.fill(y, offset, offset + ySize);
    offset += ySize;
    out.fill(cb, offset, offset + cSize);
    offset += cSize;
    out.fill(cr, offset, offset + cSize);
    offset += cSize;
  }

  writeFileSync(path, out);
  return {
    path,
    width,
    height,
    fps,
    durationS,
    seed: opts.seed,
    frames,
    bytes: out.length,
    beatTimes,
    expectedHrBpm: 60000 / synth.options.rr0Ms,
  };
}
