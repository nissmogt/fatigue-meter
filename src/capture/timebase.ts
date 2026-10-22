/**
 * Choice of the per-frame clock. requestVideoFrameCallback offers several
 * timestamps per frame; which of them actually advances for a camera stream
 * differs between engines (iOS Safari has delivered a frozen mediaTime for
 * MediaStream sources). The base is chosen once per session from the first
 * frames and never mixed afterwards; a frozen clock would otherwise make every
 * downstream window zero-length and the countdown stand still.
 */
export type TimeBase = 'mediaTime' | 'captureTime' | 'presentationTime' | 'performance';

/** Raw stamps of one presented frame. mediaTime is seconds; the others are DOMHighResTimeStamps (ms). */
export interface FrameStamps {
  mediaTime: number;
  captureTime?: number;
  presentationTime: number;
  /** performance.now() when the callback ran. */
  now: number;
}

/** Frames needed before deciding, or the wall-clock span that decides earlier. */
export const DECISION_FRAMES = 8;
export const DECISION_MS = 400;
/** A candidate must cover at least this fraction of the wall-clock span to count as advancing. */
const MIN_SPAN_FRACTION = 0.5;

export interface TimeBaseDecision {
  base: TimeBase;
  reason: string;
}

export function isDecidable(frames: readonly FrameStamps[]): boolean {
  if (frames.length >= DECISION_FRAMES) return true;
  if (frames.length < 3) return false;
  return frames[frames.length - 1].now - frames[0].now >= DECISION_MS;
}

function advancing(values: readonly number[], nowSpanMs: number): boolean {
  if (values.length < 2) return false;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
    if (i > 0 && values[i] <= values[i - 1]) return false;
  }
  const span = values[values.length - 1] - values[0];
  if (nowSpanMs > 0) return span >= MIN_SPAN_FRACTION * nowSpanMs;
  return span > 0;
}

/** Pick the first clock that really advances; null until enough frames were seen. */
export function chooseTimeBase(frames: readonly FrameStamps[]): TimeBaseDecision | null {
  if (!isDecidable(frames)) return null;
  const nowSpan = frames[frames.length - 1].now - frames[0].now;
  if (advancing(frames.map((f) => f.mediaTime * 1000), nowSpan)) return { base: 'mediaTime', reason: 'mediaTime advances' };
  if (frames.every((f) => typeof f.captureTime === 'number') && advancing(frames.map((f) => f.captureTime as number), nowSpan)) {
    return { base: 'captureTime', reason: 'mediaTime frozen; captureTime advances' };
  }
  if (advancing(frames.map((f) => f.presentationTime), nowSpan)) {
    return { base: 'presentationTime', reason: 'mediaTime frozen; presentationTime advances' };
  }
  return { base: 'performance', reason: 'no frame clock advances; callback time' };
}

/** Seconds on the chosen base. */
export function stampSeconds(f: FrameStamps, base: TimeBase): number {
  switch (base) {
    case 'mediaTime':
      return f.mediaTime;
    case 'captureTime':
      return (f.captureTime ?? f.now) / 1000;
    case 'presentationTime':
      return f.presentationTime / 1000;
    default:
      return f.now / 1000;
  }
}
