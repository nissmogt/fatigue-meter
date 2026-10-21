/**
 * Playwright global setup: makes sure the fake-camera fixture exists before
 * any browser launches. The path itself is computed in playwright.config.ts
 * (launch arguments are fixed when the config loads, before this runs).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FIXTURE, fixtureY4mPath, writeY4m } from './y4m';

export default async function globalSetup(): Promise<void> {
  const path = fixtureY4mPath();
  mkdirSync(dirname(path), { recursive: true });

  // A sidecar records the parameters the cached file was rendered with, so a
  // change to FIXTURE regenerates it instead of reusing a stale video.
  const stampPath = `${path}.json`;
  const stamp = JSON.stringify(FIXTURE);
  const cached =
    existsSync(path) &&
    statSync(path).size > 0 &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === stamp;

  if (!cached) {
    const info = writeY4m(path, FIXTURE);
    writeFileSync(stampPath, stamp);
    console.log(
      `[e2e] wrote fake-camera fixture ${path} (${info.frames} frames, ${(info.bytes / 1e6).toFixed(1)} MB, ${info.expectedHrBpm.toFixed(1)} bpm)`,
    );
  }
  process.env.FAKE_CAMERA_Y4M = path;
}
