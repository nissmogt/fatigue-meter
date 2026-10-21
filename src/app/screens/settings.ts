import { S } from '../../strings';
import { TID } from '../testids';
import type { RouteContext, Router } from '../router';
import { listCameras } from '../../capture/camera';
import type { Settings } from '../../storage/types';
import { getDb, getDiagnostics, type Diagnostics } from '../state';
import { button, el, fmt, formatDateTime, formatNumber, link, tid, topbar } from '../../ui/dom';

function diagnosticsPanel(d: Diagnostics | null): HTMLElement {
  if (!d) return el('p', { class: 'muted' }, S.settings.diagNone);
  const L = S.settings.diag;
  const yn = (b: boolean) => (b ? L.yes : L.no);
  const c = d.capture;
  const rows: Array<[string, string]> = [
    [L.at, formatDateTime(d.at)],
    [L.kind, c.kind],
    [L.label, c.label || S.common.notAvailable],
    [L.size, c.width && c.height ? `${c.width}×${c.height}` : S.common.notAvailable],
    [L.fps, `${formatNumber(c.nominalFps, 0)} / ${formatNumber(c.deliveredFps, 1)}`],
    [L.torch, yn(c.torch)],
    [L.locked, yn(c.locked)],
    [L.duration, `${formatNumber(c.durationS, 1)} s`],
    [L.timeBase, c.timeBase || S.common.notAvailable],
    [L.verdict, d.verdict ?? S.common.notAvailable],
    [L.reasons, d.reasons.length ? d.reasons.join(', ') : S.common.notAvailable],
    [L.fsSource, d.fsSource != null ? `${formatNumber(d.fsSource, 0)} Hz` : S.common.notAvailable],
    [L.dropFraction, d.dropFraction != null ? `${formatNumber(d.dropFraction * 100, 1)} %` : S.common.notAvailable],
  ];
  if (d.error) rows.push([L.error, d.error]);
  return el(
    'dl',
    { class: 'diag' },
    rows.map(([k, v]) => [el('dt', null, k), el('dd', null, v)]),
  );
}

export async function renderSettings(root: HTMLElement, _ctx: RouteContext, _router: Router): Promise<void> {
  const db = await getDb();
  let settings: Settings = await db.getSettings();
  const profile = await db.getProfile();

  const savedEl = el('span', { class: 'saved', role: 'status', hidden: true }, S.settings.saved);
  let savedTimer: number | null = null;
  async function save(patch: Partial<Settings>): Promise<void> {
    settings = await db.putSettings(patch);
    savedEl.hidden = false;
    if (savedTimer !== null) window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => {
      savedEl.hidden = true;
    }, 1500);
  }

  const radio = (value: 60 | 120, label: string): HTMLElement =>
    el(
      'label',
      { class: 'radio' },
      el('input', {
        type: 'radio',
        name: 'measureSeconds',
        value: String(value),
        checked: settings.measureSeconds === value,
        onchange: () => void save({ measureSeconds: value }),
      }),
      el('span', null, label),
    );
  const lengthGroup = el(
    'fieldset',
    { class: 'radio-group', ...tid(TID.settingsMeasureSeconds) },
    el('legend', null, S.settings.measureSeconds),
    radio(60, S.settings.seconds60),
    radio(120, S.settings.seconds120),
  );

  const keepRaw = el('input', {
    type: 'checkbox',
    id: 'settings-keep-raw',
    checked: settings.keepRawSeries,
    onchange: () => void save({ keepRawSeries: keepRaw.checked }),
  });
  const showStressT = el('input', {
    type: 'checkbox',
    id: 'settings-stress-t',
    checked: settings.showStressT,
    onchange: () => void save({ showStressT: showStressT.checked }),
  });

  const cameraSelect = el(
    'select',
    { id: 'settings-camera', onchange: () => void save({ preferredCameraId: cameraSelect.value || null }) },
    el('option', { value: '' }, S.settings.cameraAuto),
  );
  if (settings.preferredCameraId) {
    // Keep the stored choice selectable even before the device list arrives.
    cameraSelect.append(el('option', { value: settings.preferredCameraId }, settings.preferredCameraId.slice(0, 8)));
    cameraSelect.value = settings.preferredCameraId;
  }
  void listCameras()
    .then((devices) => {
      const current = settings.preferredCameraId ?? '';
      cameraSelect.replaceChildren(el('option', { value: '' }, S.settings.cameraAuto));
      devices.forEach((d, i) => {
        cameraSelect.append(el('option', { value: d.deviceId }, d.label || fmt(S.settings.cameraUnknown, { n: i + 1 })));
      });
      if (current && !devices.some((d) => d.deviceId === current)) {
        cameraSelect.append(el('option', { value: current }, current.slice(0, 8)));
      }
      cameraSelect.value = current;
    })
    .catch((e) => console.warn('camera list failed', e));

  root.append(
    topbar(S.settings.title, { label: S.common.back, path: '/home' }),
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { class: 'card-title' }, S.measure.title), savedEl),
      lengthGroup,
      el('label', { class: 'check', for: 'settings-keep-raw' }, keepRaw, el('span', null, S.settings.keepRaw)),
      el('label', { class: 'check', for: 'settings-stress-t' }, showStressT, el('span', null, S.settings.showStressT)),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card-title' }, S.settings.camera),
      el('div', { class: 'field' }, el('label', { for: 'settings-camera' }, S.settings.camera), cameraSelect, el('p', { class: 'field-hint' }, S.settings.cameraHint)),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card-title' }, S.settings.profile),
      el('p', null, profile ? `${fmt(S.settings.profileSummary, { year: profile.birthYear })} · ${S.profile.sexOptions[profile.sex]}` : S.settings.noProfile),
      link(S.settings.editProfile, '/profile?from=settings', { class: 'btn btn-secondary' }),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', { class: 'card-title' }, S.settings.debug),
      diagnosticsPanel(getDiagnostics()),
      link(S.settings.demo, '/measure?source=synthetic&seed=42', { class: 'btn btn-ghost' }),
    ),
    el('p', { class: 'muted small' }, button(S.nav.about, () => (window.location.hash = '#/about'), { class: 'btn-link' })),
  );
}
