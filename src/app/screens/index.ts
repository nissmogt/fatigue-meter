/** Registers every screen on the router (hash routes). */
import type { Router } from '../router';
import { renderHome } from './home';
import { renderProfile } from './profile';
import { renderVas } from './vas';
import { renderSleep } from './sleep';
import { renderMeasure } from './measure';
import { renderResult } from './result';
import { renderHistory } from './history';
import { renderSettings } from './settings';
import { renderAbout } from './about';

export function registerScreens(router: Router): void {
  router
    .add('/home', (root, ctx) => renderHome(root, ctx, router))
    .add('/profile', (root, ctx) => renderProfile(root, ctx, router))
    .add('/vas', (root, ctx) => renderVas(root, ctx, router))
    .add('/sleep', (root, ctx) => renderSleep(root, ctx, router))
    .add('/measure', (root, ctx) => renderMeasure(root, ctx, router))
    .add('/result/:id', (root, ctx) => renderResult(root, ctx, router))
    .add('/history', (root, ctx) => renderHistory(root, ctx, router))
    .add('/settings', (root, ctx) => renderSettings(root, ctx, router))
    .add('/about', (root, ctx) => renderAbout(root, ctx, router))
    .setFallback('/home');
}
