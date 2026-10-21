import { defineConfig } from '@playwright/test';
import { fixtureY4mPath } from './tests/e2e/y4m';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Chromium's file-backed fake camera plays this Y4M in a loop at its own
// frame rate; tests/e2e/global-setup.ts renders it before the browser starts.
const FAKE_CAMERA_Y4M = fixtureY4mPath();

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  // The camera tier records in real time and the synthetic tier drives a
  // fake clock; neither tolerates a second browser competing for CPU.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 90_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    permissions: ['camera'],
    // The PWA service worker must not serve a stale build or intercept the preview server.
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${FAKE_CAMERA_Y4M}`,
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
