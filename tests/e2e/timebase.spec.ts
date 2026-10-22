/**
 * Frozen frame clock: some engines (iOS Safari for camera streams) report a
 * requestVideoFrameCallback mediaTime that never advances. The sampler must
 * then fall back to another frame clock, and a measurement must still complete
 * with the heart rate encoded in the fake-camera video.
 */
import { expect, test } from '@playwright/test';
import { TID } from '../../src/app/testids';
import { FIXTURE_HR_BPM } from './y4m';

test.describe.configure({ timeout: 180_000 });

test('fake camera with a frozen mediaTime: the sampler falls back to another clock and the measurement completes', async ({ page }) => {
  await page.addInitScript(() => {
    const proto = HTMLVideoElement.prototype as HTMLVideoElement & {
      requestVideoFrameCallback: (cb: (now: number, meta: VideoFrameCallbackMetadata) => void) => number;
    };
    const orig = proto.requestVideoFrameCallback;
    proto.requestVideoFrameCallback = function (this: HTMLVideoElement, cb) {
      return orig.call(this, (now: number, meta: VideoFrameCallbackMetadata) => cb(now, { ...meta, mediaTime: 0 }));
    };
  });

  await page.goto('/#/profile');
  await page.getByTestId(TID.profileBirthYear).fill('1985');
  await page.getByTestId(TID.profileAccept).check();
  await page.getByTestId(TID.profileSave).click();
  // Save navigates onward asynchronously; jumping to the measure route before
  // that lands would be overridden by it.
  await expect.poll(() => page.url(), { timeout: 10_000 }).not.toMatch(/#\/profile/);

  await page.goto('/#/measure');
  await expect(page.getByTestId(TID.measureStart)).toBeVisible();
  await page.getByTestId(TID.measureStart).click();

  await expect
    .poll(
      async () => {
        const err = page.getByTestId(TID.measureError);
        if (await err.isVisible().catch(() => false)) {
          const text = (await err.textContent()) ?? '';
          throw new Error(`measurement failed: ${text}`);
        }
        return page.url();
      },
      { timeout: 150_000, intervals: [1000] },
    )
    .toMatch(/#\/result\//);

  const hrText = (await page.getByTestId(TID.resultHr).textContent()) ?? '';
  const hr = Number(/\d+(?:\.\d+)?/.exec(hrText)?.[0]);
  expect(Math.abs(hr - FIXTURE_HR_BPM)).toBeLessThanOrEqual(3);

  // The stored record must carry the fallback clock, not the frozen mediaTime.
  const timeBase = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = indexedDB.open('fatigue-meter');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('records', 'readonly');
          const all = tx.objectStore('records').getAll();
          all.onsuccess = () => {
            const recs = all.result as Array<{ capture?: { timeBase?: string } }>;
            resolve(recs[recs.length - 1]?.capture?.timeBase ?? '');
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
  expect(timeBase).not.toBe('mediaTime');
  expect(['captureTime', 'presentationTime', 'performance']).toContain(timeBase);
});
