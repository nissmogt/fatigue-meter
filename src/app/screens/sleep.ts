import { S } from '../../strings';
import { TID } from '../testids';
import type { RouteContext, Router } from '../router';
import { makeSleepInfo } from '../../scoring/vas';
import { getSession, setSleep } from '../state';
import { button, el, formatDurationMin, tid, topbar } from '../../ui/dom';

export function renderSleep(root: HTMLElement, _ctx: RouteContext, router: Router): void {
  const session = getSession();

  const bed = el('input', { type: 'time', id: 'sleep-bed', value: session.bedtime ?? '', ...tid(TID.sleepBed) });
  const wake = el('input', { type: 'time', id: 'sleep-wake', value: session.wake ?? '', ...tid(TID.sleepWake) });
  const none = el('input', { type: 'checkbox', id: 'sleep-none', checked: session.didNotSleep, ...tid(TID.sleepNone) });
  const durationEl = el('p', { class: 'num-lg', 'aria-live': 'polite' });

  function update(): void {
    const off = none.checked;
    bed.disabled = off;
    wake.disabled = off;
    if (off) {
      durationEl.textContent = S.sleep.noSleepText;
      return;
    }
    const info = makeSleepInfo(bed.value || null, wake.value || null);
    durationEl.textContent =
      info.durationMin != null ? formatDurationMin(info.durationMin, S.common.hours, S.common.minutes) : S.sleep.notEntered;
  }

  for (const input of [bed, wake]) {
    input.addEventListener('input', update);
    input.addEventListener('change', update);
  }
  none.addEventListener('change', update);
  update();

  function onNext(): void {
    const off = none.checked;
    setSleep({ bedtime: off ? null : bed.value || null, wake: off ? null : wake.value || null, didNotSleep: off });
    router.navigate('/measure');
  }

  root.append(
    topbar(S.sleep.title),
    el(
      'div',
      { class: 'form' },
      el('div', { class: 'field' }, el('label', { for: 'sleep-bed' }, S.sleep.bed), bed),
      el('div', { class: 'field' }, el('label', { for: 'sleep-wake' }, S.sleep.wake), wake),
      el('label', { class: 'check', for: 'sleep-none' }, none, el('span', null, S.sleep.none)),
      el('section', { class: 'card stat' }, el('h2', { class: 'card-title' }, S.sleep.duration), durationEl),
      el(
        'div',
        { class: 'btn-row' },
        button(S.common.back, () => router.navigate('/vas'), { class: 'btn-secondary' }),
        button(S.sleep.next, onNext, { class: 'btn-primary', ...tid(TID.sleepNext) }),
      ),
    ),
  );
}
