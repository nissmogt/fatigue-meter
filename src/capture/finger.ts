/**
 * Finger presence and stability: pure functions over recent samples so the
 * measurement screen and the DSP live snapshot can share one definition.
 * Thresholds live in config.ts.
 */
import type { FingerReason } from '../dsp/pipeline';
import type { Sample } from '../dsp/types';
import {
  AMBIENT_LUMA_MAX,
  AMBIENT_LUMA_MIN,
  AMBIENT_RED_RATIO_MIN,
  SATURATED_FRACTION_MAX,
  STABLE_MEAN_DELTA_MAX,
  STABLE_STEP_MAX,
  STABLE_WINDOW_S,
  TORCH_RED_MAX,
  TORCH_RED_MIN,
  TORCH_RED_RATIO_MIN,
  TORCH_RG_RATIO_MIN,
} from './config';

export type { FingerReason };

/** 'torch' when the flash lights the finger, 'ambient' when it could not be switched on. */
export type FingerMode = 'torch' | 'ambient';

/**
 * `on` says whether the latest frame looks like a fingertip; `reason` is 'ok'
 * only when it does AND the recent window is stable, so a gate can simply
 * check `reason === 'ok'`.
 */
export interface FingerState {
  on: boolean;
  reason: FingerReason;
}

/** Red share of the colour sum, 0..1 (0 for a black frame). */
export function redRatio(s: Sample): number {
  const sum = s.r + s.g + s.b;
  return sum > 0 ? s.r / sum : 0;
}

/** Rec. 601 luma of the channel means, 0..255. */
export function luminance(s: Sample): number {
  return 0.299 * s.r + 0.587 * s.g + 0.114 * s.b;
}

/** True when one sample looks like a fingertip covering the lens (and is not clipping). */
export function fingerPresent(s: Sample, mode: FingerMode): boolean {
  if (s.sat >= SATURATED_FRACTION_MAX) return false;
  if (mode === 'torch') {
    return (
      redRatio(s) >= TORCH_RED_RATIO_MIN &&
      s.r >= TORCH_RED_MIN &&
      s.r <= TORCH_RED_MAX &&
      // r/g >= ratio, written without a division so g = 0 cannot blow up.
      s.r >= TORCH_RG_RATIO_MIN * s.g
    );
  }
  const luma = luminance(s);
  return (
    redRatio(s) >= AMBIENT_RED_RATIO_MIN &&
    s.r > s.g &&
    s.g > s.b &&
    luma >= AMBIENT_LUMA_MIN &&
    luma <= AMBIENT_LUMA_MAX
  );
}

/** Presence of one sample with the most likely reason when absent. */
export function classifyFinger(s: Sample, mode: FingerMode): FingerState {
  if (fingerPresent(s, mode)) return { on: true, reason: 'ok' };
  const luma = luminance(s);
  const clipped = mode === 'torch' ? s.r > TORCH_RED_MAX : luma > AMBIENT_LUMA_MAX;
  if (s.sat >= SATURATED_FRACTION_MAX || clipped) return { on: false, reason: 'saturated' };
  // Dark but still red-tinted: a finger with too little light behind it.
  const dark = mode === 'torch' ? s.r < TORCH_RED_MIN : luma < AMBIENT_LUMA_MIN;
  const reddish = mode === 'torch' ? redRatio(s) >= TORCH_RED_RATIO_MIN : redRatio(s) >= AMBIENT_RED_RATIO_MIN;
  if (dark && reddish) return { on: false, reason: 'too-dark' };
  return { on: false, reason: 'no-finger' };
}

/**
 * True when the red mean over the last `windowS` seconds has neither drifted
 * (consecutive half-window means differ by < STABLE_MEAN_DELTA_MAX) nor
 * stepped (no frame-to-frame jump > STABLE_STEP_MAX). False until the window
 * is at least ~75 % filled, so a gate cannot pass on a few frames.
 */
export function isStable(samples: readonly Sample[], windowS = STABLE_WINDOW_S): boolean {
  const n = samples.length;
  if (n < 2) return false;
  const tEnd = samples[n - 1].t;
  const tStart = tEnd - windowS;
  const tMid = tEnd - windowS / 2;
  let first = n - 1;
  while (first > 0 && samples[first - 1].t >= tStart) first--;
  // Coverage: the earliest in-window sample must sit in the first quarter.
  if (samples[first].t > tStart + windowS / 4) return false;

  let sumA = 0;
  let nA = 0;
  let sumB = 0;
  let nB = 0;
  for (let i = first; i < n; i++) {
    const s = samples[i];
    if (i > first && Math.abs(s.r - samples[i - 1].r) > STABLE_STEP_MAX) return false;
    if (s.t < tMid) {
      sumA += s.r;
      nA++;
    } else {
      sumB += s.r;
      nB++;
    }
  }
  if (nA < 2 || nB < 2) return false;
  return Math.abs(sumB / nB - sumA / nA) < STABLE_MEAN_DELTA_MAX;
}

/** Combined state of the latest sample plus stability of the recent window. */
export function fingerState(samples: readonly Sample[], mode: FingerMode): FingerState {
  const n = samples.length;
  if (n === 0) return { on: false, reason: 'no-finger' };
  const last = classifyFinger(samples[n - 1], mode);
  if (!last.on) return last;
  return isStable(samples) ? last : { on: true, reason: 'moving' };
}
