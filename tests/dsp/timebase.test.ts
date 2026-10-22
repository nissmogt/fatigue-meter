import { describe, expect, it } from 'vitest';
import { chooseTimeBase, isDecidable, stampSeconds, type FrameStamps } from '../../src/capture/timebase';

function frames(n: number, opts: { media?: (i: number) => number; capture?: (i: number) => number | undefined; pres?: (i: number) => number } = {}): FrameStamps[] {
  const out: FrameStamps[] = [];
  for (let i = 0; i < n; i++) {
    const now = 1000 + i * 33.3;
    const f: FrameStamps = {
      mediaTime: opts.media ? opts.media(i) : i / 30,
      presentationTime: opts.pres ? opts.pres(i) : now + 5,
      now,
    };
    const c = opts.capture ? opts.capture(i) : undefined;
    if (c !== undefined) f.captureTime = c;
    out.push(f);
  }
  return out;
}

describe('time base choice', () => {
  it('needs enough frames or enough wall-clock time', () => {
    expect(isDecidable(frames(2))).toBe(false);
    expect(chooseTimeBase(frames(5))).toBeNull();
    expect(isDecidable(frames(8))).toBe(true);
    const sparse = frames(3).map((f, i) => ({ ...f, now: 1000 + i * 250 }));
    expect(isDecidable(sparse)).toBe(true);
  });

  it('keeps mediaTime when it advances', () => {
    expect(chooseTimeBase(frames(8))?.base).toBe('mediaTime');
    const f = frames(8);
    expect(stampSeconds(f[3], 'mediaTime')).toBeCloseTo(0.1, 6);
  });

  it('falls back to captureTime, then presentationTime, when mediaTime is frozen', () => {
    const frozenWithCapture = frames(8, { media: () => 0, capture: (i) => 500 + i * 33.3 });
    expect(chooseTimeBase(frozenWithCapture)?.base).toBe('captureTime');
    const frozen = frames(8, { media: () => 0 });
    expect(chooseTimeBase(frozen)?.base).toBe('presentationTime');
    const nan = frames(8, { media: () => NaN });
    expect(chooseTimeBase(nan)?.base).toBe('presentationTime');
    expect(stampSeconds(frozen[2], 'presentationTime')).toBeCloseTo((1000 + 2 * 33.3 + 5) / 1000, 6);
  });

  it('rejects a clock that creeps far slower than wall time or runs backwards', () => {
    const creeping = frames(8, { media: (i) => i / 3000 });
    expect(chooseTimeBase(creeping)?.base).toBe('presentationTime');
    const backwards = frames(8, { media: (i) => (i === 4 ? 0.05 : i / 30) });
    expect(chooseTimeBase(backwards)?.base).toBe('presentationTime');
  });

  it('uses the callback clock when nothing else advances', () => {
    const dead = frames(8, { media: () => 0, pres: () => 42 });
    expect(chooseTimeBase(dead)?.base).toBe('performance');
    expect(stampSeconds(dead[1], 'performance')).toBeCloseTo((1000 + 33.3) / 1000, 6);
  });
});
