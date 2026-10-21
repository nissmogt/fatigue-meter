import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites under /<repo>/. CI sets BASE_PATH
// (see .github/workflows/deploy.yml); local dev and preview use '/'.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // Camera access needs a secure context. localhost counts; phones on the
    // LAN do not, so test on the deployed HTTPS URL or through a tunnel.
    host: true,
  },
  plugins: [
    VitePWA({
      // 'prompt' rather than 'autoUpdate': autoUpdate reloads the page when a
      // new service worker activates, which would kill a running measurement.
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg', 'icons/icon-maskable.svg'],
      manifest: {
        name: 'Fatigue Meter',
        short_name: 'Fatigue Meter',
        description: 'Fingertip pulse-wave (PPG) fatigue and stress scan, computed entirely in your browser.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        // minimal-ui until standalone camera behaviour is verified on iOS
        // (home-screen apps can lose the camera on in-app navigation).
        display: 'minimal-ui',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
});
