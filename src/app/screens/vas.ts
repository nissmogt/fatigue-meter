import { S } from '../../strings';
import { TID } from '../testids';
import type { RouteContext, Router } from '../router';
import { getSession, setVasAnswer } from '../state';
import { createSlider } from '../../ui/slider';
import { button, el, fmt, topbar } from '../../ui/dom';

/** One question at a time; no hash change between questions. */
export function renderVas(root: HTMLElement, _ctx: RouteContext, router: Router): void {
  const items = S.vas.items;
  const answers = getSession().vas;
  let index = 0;

  const container = el('div', { class: 'vas' });

  function show(): void {
    container.replaceChildren();
    const item = items[index];
    const saved = answers[item.key];

    const next = button(
      S.vas.next,
      () => {
        const value = slider.value();
        setVasAnswer(item.key, value);
        answers[item.key] = value;
        if (index + 1 < items.length) {
          index++;
          show();
        } else {
          router.navigate('/sleep');
        }
      },
      // An item answered earlier (returning via Back) needs no new interaction.
      { class: 'btn-primary', disabled: saved == null, 'data-testid': TID.vasNext },
    );
    const slider = createSlider({
      value: saved ?? 50,
      leftLabel: item.left,
      rightLabel: item.right,
      ariaLabel: item.question,
      testid: TID.vasSlider(index),
      onInteract: () => {
        next.disabled = false;
      },
    });
    const back = button(
      S.vas.back,
      () => {
        if (index > 0) {
          index--;
          show();
        } else {
          router.navigate('/home');
        }
      },
      { class: 'btn-secondary', 'data-testid': TID.vasBack },
    );

    container.append(
      el('p', { class: 'progress' }, fmt(S.vas.progress, { i: index + 1, n: items.length })),
      el('h2', { class: 'question' }, item.question),
      el('p', { class: 'hint' }, S.vas.hint),
      slider.root,
      el('div', { class: 'btn-row' }, back, next),
    );
    slider.input.focus({ preventScroll: true });
  }

  // Attach before the first show(): focus() on a detached slider is a no-op.
  root.append(topbar(S.vas.title), container);
  show();
}
