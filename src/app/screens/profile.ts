import { S } from '../../strings';
import { TID } from '../testids';
import type { RouteContext, Router } from '../router';
import type { Profile, Sex } from '../../scoring/types';
import { getDb } from '../state';
import { button, el, tid, topbar } from '../../ui/dom';

const SEX_ORDER: Sex[] = ['unspecified', 'female', 'male'];

export async function renderProfile(root: HTMLElement, ctx: RouteContext, router: Router): Promise<void> {
  const fromSettings = ctx.query.get('from') === 'settings';
  const next = fromSettings ? '/settings' : '/vas';

  let existing: Profile | null = null;
  try {
    existing = await (await getDb()).getProfile();
  } catch (e) {
    console.warn('profile lookup failed', e);
  }

  const thisYear = new Date().getFullYear();
  const yearInput = el('input', {
    type: 'number',
    inputmode: 'numeric',
    min: 1900,
    max: thisYear,
    step: 1,
    placeholder: String(thisYear - 40),
    value: existing ? String(existing.birthYear) : '',
    id: 'profile-year',
    ...tid(TID.profileBirthYear),
  });
  const sexSelect = el(
    'select',
    { id: 'profile-sex', value: existing?.sex ?? 'unspecified', ...tid(TID.profileSex) },
    SEX_ORDER.map((s) => el('option', { value: s }, S.profile.sexOptions[s])),
  );
  const accept = el('input', { type: 'checkbox', id: 'profile-accept', checked: existing != null, ...tid(TID.profileAccept) });
  const errorEl = el('p', { class: 'field-error', role: 'alert', hidden: true });

  const validYear = (): number | null => {
    const v = Number(yearInput.value);
    return yearInput.value !== '' && Number.isInteger(v) && v >= 1900 && v <= thisYear ? v : null;
  };

  async function onSave(): Promise<void> {
    const birthYear = validYear();
    if (birthYear == null) {
      errorEl.textContent = S.profile.invalidYear;
      errorEl.hidden = false;
      yearInput.focus();
      return;
    }
    if (!accept.checked) {
      errorEl.textContent = S.profile.acceptRequired;
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;
    const profile: Profile = {
      birthYear,
      sex: (SEX_ORDER as string[]).includes(sexSelect.value) ? (sexSelect.value as Sex) : 'unspecified',
      acceptedAt: existing?.acceptedAt ?? Date.now(),
    };
    try {
      await (await getDb()).putProfile(profile);
    } catch (e) {
      console.error('saving the profile failed', e);
      errorEl.textContent = S.common.error;
      errorEl.hidden = false;
      return;
    }
    router.navigate(next);
  }

  yearInput.addEventListener('input', () => {
    errorEl.hidden = true;
  });

  root.append(
    topbar(existing ? S.profile.editTitle : S.profile.title, {
      label: S.common.back,
      path: fromSettings ? '/settings' : '/home',
    }),
    el('p', { class: 'intro' }, S.profile.intro),
    el(
      'form',
      {
        class: 'form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          void onSave();
        },
      },
      el('div', { class: 'field' }, el('label', { for: 'profile-year' }, S.profile.birthYear), yearInput, el('p', { class: 'field-hint' }, S.profile.yearHint)),
      el('div', { class: 'field' }, el('label', { for: 'profile-sex' }, S.profile.sex), sexSelect),
      el('label', { class: 'check', for: 'profile-accept' }, accept, el('span', null, S.profile.accept)),
      errorEl,
      el(
        'div',
        { class: 'btn-col' },
        button(S.profile.save, () => void onSave(), { class: 'btn-primary btn-block', ...tid(TID.profileSave) }),
        fromSettings ? null : button(S.profile.skip, () => router.navigate(next), { class: 'btn-ghost btn-block' }),
      ),
    ),
  );
}
