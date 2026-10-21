/**
 * Playwright global setup: makes sure the fake-camera fixture exists before
 * any browser launches. The path itself is computed in playwright.config.ts
 * (launch arguments are fixed when the config loads, before this runs).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FIXTURE, fixtureY4mPath, writeY4m } from './y4m';

export default async function globalSetup(): Promise<void> {
  const path = fixtureY4mPath();
  mkdirSync(dirname(path), { recursive: true });

  // Always re-rendered (tens of milliseconds): the bytes depend on the
  // generator, the pulse shape and the renderer constants as well as FIXTURE,
  // so a cache keyed on FIXTURE alone would keep serving a stale video after
  // src/dsp/synthetic.ts or y4m.ts changed while measure.spec.ts asserts the
  // heart rate derived from the live source.
  const info = writeY4m(path, FIXTURE);
  console.log(
    `[e2e] wrote fake-camera fixture ${path} (${info.frames} frames, ${(info.bytes / 1e6).toFixed(1)} MB, ${info.expectedHrBpm.toFixed(1)} bpm)`,
  );
  process.env.FAKE_CAMERA_Y4M = path;
}
