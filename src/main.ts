/// <reference types="vite-plugin-pwa/client" />
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { Router } from './app/router';
import { registerScreens } from './app/screens';
import { markNeedRefresh } from './app/state';

const root = document.getElementById('app');
if (!root) throw new Error('index.html is missing <main id="app">');

const router = new Router();
registerScreens(router);
router.start(root);

// 'prompt' semantics: a waiting service worker only sets a flag that the home
// screen shows as a banner. The page is never reloaded on its own, because a
// reload would kill a running measurement.
const updateSW = registerSW({
  onNeedRefresh() {
    markNeedRefresh(() => updateSW(true));
  },
  onRegisterError(error: unknown) {
    console.warn('service worker registration failed', error);
  },
});
