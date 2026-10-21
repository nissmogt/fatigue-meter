import { S } from '../../strings';
import { ANALYSIS_VERSION } from '../../dsp/pipeline';
import type { RouteContext, Router } from '../router';
import { el, topbar } from '../../ui/dom';

export function renderAbout(root: HTMLElement, _ctx: RouteContext, _router: Router): void {
  root.append(
    topbar(S.about.title, { label: S.common.back, path: '/home' }),
    el('p', { class: 'intro' }, S.about.intro),
    el(
      'section',
      { class: 'card prose' },
      el('h2', { class: 'card-title' }, S.about.methodTitle),
      S.about.method.map((p) => el('p', null, p)),
    ),
    el(
      'section',
      { class: 'card prose' },
      el('h2', { class: 'card-title' }, S.about.limitationsTitle),
      el('ul', null, S.about.limitations.map((p) => el('li', null, p))),
    ),
    el(
      'section',
      { class: 'card prose' },
      el('h2', { class: 'card-title' }, S.about.sourcesTitle),
      el('ul', null, S.about.sources.map((p) => el('li', null, p))),
    ),
    el(
      'section',
      { class: 'card prose' },
      el('h2', { class: 'card-title' }, S.about.disclaimerTitle),
      el('p', null, S.about.disclaimer),
    ),
    el('p', { class: 'muted small' }, `${S.about.versionLabel}: ${ANALYSIS_VERSION}`),
  );
}
