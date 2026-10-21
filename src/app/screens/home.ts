import { S } from '../../strings';
import { TID } from '../testids';
import type { Cleanup, RouteContext, Router } from '../router';
import { applyPendingUpdate, getDb, hasUpdate, onStateChange } from '../state';
import { button, el, link, tid } from '../../ui/dom';

export function renderHome(root: HTMLElement, _ctx: RouteContext, router: Router): Cleanup {
  const banner = el(
    'div',
    { class: 'banner', role: 'status', hidden: !hasUpdate() },
    el('span', null, S.home.updateAvailable),
    button(S.home.reload, () => void applyPendingUpdate(), { class: 'btn-small' }),
  );
  const unsubscribe = onStateChange(() => {
    banner.hidden = !hasUpdate();
  });

  async function onStart(): Promise<void> {
    let hasProfile = false;
    try {
      hasProfile = (await (await getDb()).getProfile()) != null;
    } catch (e) {
      console.warn('profile lookup failed', e);
    }
    router.navigate(hasProfile ? '/vas' : '/profile');
  }

  root.append(
    el(
      'header',
      { class: 'hero' },
      el('h1', { class: 'hero-title' }, S.appName),
      el('p', { class: 'hero-tagline' }, S.tagline),
    ),
    banner,
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card-title' }, S.home.howItWorks),
      el(
        'ol',
        { class: 'steps' },
        S.home.steps.map((step) => el('li', null, step)),
      ),
    ),
    button(S.home.start, () => void onStart(), { class: 'btn-primary btn-block btn-large', ...tid(TID.homeStart) }),
    el('p', { class: 'disclaimer' }, S.disclaimerShort),
    el(
      'nav',
      { class: 'nav-links' },
      link(S.nav.history, '/history', tid(TID.homeHistory)),
      link(S.nav.settings, '/settings'),
      link(S.nav.about, '/about'),
    ),
  );

  return () => unsubscribe();
}
