import { describe, expect, it } from 'vitest';
import { scanLenses } from '../../src/capture/lensScan';
import type { LockResult, SampleSource, SourceEvent, SourceInfo } from '../../src/capture/source';
import { generateSynthetic, syntheticPreset } from '../../src/dsp/synthetic';
import { fromSeries, sliceSeriesByTime } from '../../src/dsp/types';
import type { Sample } from '../../src/dsp/types';

/** A camera stand-in that delivers a canned 3-s sample burst shortly after start(). */
function fakeSource(deviceId: string, samples: Sample[], opts: { failStart?: boolean } = {}): SampleSource & { stops: number } {
  const sampleCbs = new Set<(s: Sample) => void>();
  const eventCbs = new Set<(e: SourceEvent) => void>();
  const src = {
    kind: 'camera' as const,
    stops: 0,
    async start(): Promise<SourceInfo> {
      if (opts.failStart) throw new Error(`cannot open ${deviceId}`);
      setTimeout(() => {
        for (const s of samples) for (const cb of sampleCbs) cb(s);
      }, 5);
      return {
        kind: 'camera',
        label: deviceId,
        deviceId,
        width: 64,
        height: 48,
        nominalFps: 30,
        timeBase: 'performance',
        capabilities: { torch: false, exposureLock: false, focusLock: false, whiteBalanceLock: false, frameCallback: 'rvfc' },
      };
    },
    async stop(): Promise<void> {
      src.stops++;
      for (const cb of eventCbs) cb({ type: 'stopped' });
    },
    onSample(cb: (s: Sample) => void) {
      sampleCbs.add(cb);
      return () => sampleCbs.delete(cb);
    },
    onEvent(cb: (e: SourceEvent) => void) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    async setTorch(): Promise<boolean> {
      return false;
    },
    async lockControls(): Promise<LockResult> {
      return { exposure: false, focus: false, whiteBalance: false };
    },
    deliveredFps(): number {
      return 30;
    },
  };
  return src;
}

function burst(opts: Parameters<typeof generateSynthetic>[0]): Sample[] {
  return fromSeries(sliceSeriesByTime(generateSynthetic({ durationS: 4, ...opts }).series, 0.5, 3.5));
}

describe('scanLenses orchestration', () => {
  const lit = burst({ seed: 3 });
  const dim = burst({ seed: 3, acFractionR: 0.003, acFractionG: 0.004, noiseSd: 0.6 });
  const off = burst({ seed: 3, fingerOffWindows: [[0, 4]] });
  const poor = burst({ ...syntheticPreset('poor', 3) });
  const video = {} as HTMLVideoElement;
  const fast = { settleMs: 0, sampleMs: 40, gapMs: 0 };

  it('tries every lens in order, stops each one, and keeps the lens that sees the pulse best', async () => {
    const made: Record<string, ReturnType<typeof fakeSource>> = {};
    const makeSource = (id: string) => {
      const data = id === 'tele' ? lit : id === 'wide' ? off : dim;
      made[id] = fakeSource(id, data);
      return made[id];
    };
    const progress: string[] = [];
    const res = await scanLenses(
      [
        { deviceId: 'wide', label: 'Back Camera' },
        { deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
        { deviceId: 'tele', label: 'Back Telephoto Camera' },
      ],
      video,
      { ...fast, makeSource, onProgress: (i, total, label) => progress.push(`${i + 1}/${total} ${label}`) },
    );
    expect(progress).toEqual(['1/3 Back Camera', '2/3 Back Ultra Wide Camera', '3/3 Back Telephoto Camera']);
    expect(res.aborted).toBe(false);
    expect(res.scores.map((s) => s.deviceId)).toEqual(['wide', 'ultra', 'tele']);
    expect(res.best?.deviceId).toBe('tele');
    expect(res.best?.label).toBe('Back Telephoto Camera');
    expect(res.scores[0].score).toBe(0); // finger off
    expect(res.scores[1].score).toBeLessThan(res.scores[2].score);
    for (const id of ['wide', 'ultra', 'tele']) expect(made[id].stops).toBe(1);
  });

  it('returns no best lens when nothing sees a pulse, and records start errors', async () => {
    const makeSource = (id: string) => fakeSource(id, id === 'a' ? off : poor, { failStart: id === 'c' });
    const res = await scanLenses(
      [
        { deviceId: 'a', label: 'A' },
        { deviceId: 'b', label: 'B' },
        { deviceId: 'c', label: 'C' },
      ],
      video,
      { ...fast, makeSource },
    );
    expect(res.best).toBeNull();
    expect(res.scores).toHaveLength(3);
    expect(res.scores[2].error).toMatch(/cannot open c/);
  });

  it('aborts between lenses when asked', async () => {
    let calls = 0;
    const makeSource = (id: string) => fakeSource(id, lit);
    const res = await scanLenses(
      [
        { deviceId: 'a', label: 'A' },
        { deviceId: 'b', label: 'B' },
      ],
      video,
      { ...fast, makeSource, shouldAbort: () => ++calls > 2 },
    );
    expect(res.aborted).toBe(true);
    expect(res.best).toBeNull();
    expect(res.scores.length).toBeLessThan(2);
  });
});
