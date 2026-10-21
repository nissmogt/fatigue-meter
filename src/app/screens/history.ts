import { S } from '../../strings';
import { TID } from '../testids';
import type { RouteContext, Router } from '../router';
import type { ExportBundle, MeasurementSummary } from '../../storage/types';
import { getDb } from '../state';
import { levelColor } from '../../ui/gauge';
import { button, el, fmt, formatDateTime, formatNumber, svg, tid, topbar } from '../../ui/dom';

const TREND_N = 30;

/** Brain fatigue (0–100) over the last measurements, oldest left, 50 = age average. */
function renderTrend(items: MeasurementSummary[]): HTMLElement {
  const w = 320;
  const h = 90;
  const padX = 8;
  const padY = 10;
  const n = items.length;
  const x = (i: number) => (n === 1 ? w / 2 : padX + (i / (n - 1)) * (w - 2 * padX));
  const y = (v: number) => padY + (1 - Math.min(100, Math.max(0, v)) / 100) * (h - 2 * padY);

  const chart = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'trend', role: 'img', 'aria-label': fmt(S.history.trend, { n }) });
  chart.appendChild(svg('line', { x1: 0, x2: w, y1: y(50).toFixed(1), y2: y(50).toFixed(1), class: 'trend-mid' }));
  const points = items
    .map((it, i) => (it.brainFatigue == null ? null : `${x(i).toFixed(1)},${y(it.brainFatigue).toFixed(1)}`))
    .filter((p): p is string => p !== null);
  if (points.length > 1) chart.appendChild(svg('polyline', { points: points.join(' '), class: 'trend-line' }));
  items.forEach((it, i) => {
    if (it.brainFatigue == null) return;
    chart.appendChild(
      svg('circle', { cx: x(i).toFixed(1), cy: y(it.brainFatigue).toFixed(1), r: 4, style: { fill: levelColor(it.fatigueLevel) }, class: 'trend-dot' }),
    );
  });
  return el('section', { class: 'card' }, el('h2', { class: 'card-title' }, fmt(S.history.trend, { n })), chart);
}

function levelChip(level: number | null, labels: readonly string[]): HTMLElement {
  return el(
    'span',
    { class: 'chip' },
    el('span', { class: 'chip-dot', style: { background: levelColor(level) } }),
    level != null ? `${level} · ${labels[level - 1]}` : S.common.notAvailable,
  );
}

export async function renderHistory(root: HTMLElement, _ctx: RouteContext, router: Router): Promise<void> {
  const db = await getDb();
  const listEl = el('div', { class: 'list' });
  const trendEl = el('div');
  const countEl = el('p', { class: 'muted small' });
  const msgEl = el('p', { class: 'msg', role: 'status', hidden: true });

  function say(text: string): void {
    msgEl.textContent = text;
    msgEl.hidden = false;
  }

  function row(it: MeasurementSummary): HTMLElement {
    const open = () => router.navigate(`/result/${encodeURIComponent(it.id)}`);
    return el(
      'div',
      {
        class: 'row',
        role: 'button',
        tabindex: 0,
        onclick: open,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        },
        ...tid(TID.historyItem),
      },
      el('div', { class: 'row-main' }, el('span', { class: 'row-date' }, formatDateTime(it.createdAt))),
      el(
        'div',
        { class: 'row-chips' },
        el('span', { class: 'row-key' }, S.history.fatigueShort, ' '),
        levelChip(it.fatigueLevel, S.result.fatigueLevels),
        el('span', { class: 'row-key' }, S.history.stressShort, ' '),
        levelChip(it.stressLevel, S.result.stressLevels),
        el('span', { class: 'row-key' }, `${formatNumber(it.meanHR, 0)} ${S.common.bpm}`),
      ),
    );
  }

  async function refresh(): Promise<void> {
    const items = await db.listSummaries({ limit: 500 });
    listEl.replaceChildren();
    trendEl.replaceChildren();
    countEl.textContent = fmt(S.history.count, { n: items.length });
    if (items.length === 0) {
      listEl.append(el('p', { class: 'empty', ...tid(TID.historyEmpty) }, S.history.empty));
      return;
    }
    trendEl.append(renderTrend(items.slice(0, TREND_N).reverse()));
    for (const it of items) listEl.append(row(it));
  }

  async function exportJson(): Promise<void> {
    const bundle = await db.exportAll();
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = el('a', { href: url, download: `fatigue-meter-${stamp}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', 'aria-label': S.history.import });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void (async () => {
      try {
        const parsed: unknown = JSON.parse(await file.text());
        if (!parsed || typeof parsed !== 'object' || (parsed as { app?: unknown }).app !== 'fatigue-meter') {
          throw new Error('not a fatigue-meter export');
        }
        const r = await db.importAll(parsed as ExportBundle, 'merge');
        say(fmt(S.history.importDone, { added: r.added, skipped: r.skipped }));
        await refresh();
      } catch (e) {
        console.warn('import failed', e);
        say(S.history.importFailed);
      }
    })();
  });

  async function clearAll(): Promise<void> {
    if (!window.confirm(S.history.confirmClear)) return;
    await db.clearRecords();
    say(S.history.cleared);
    await refresh();
  }

  root.append(
    topbar(S.history.title, { label: S.common.back, path: '/home' }),
    countEl,
    msgEl,
    trendEl,
    listEl,
    el(
      'div',
      { class: 'btn-row wrap' },
      button(S.history.export, () => void exportJson(), { class: 'btn-secondary', ...tid(TID.historyExport) }),
      button(S.history.import, () => fileInput.click(), { class: 'btn-secondary' }),
      button(S.history.clear, () => void clearAll(), { class: 'btn-danger', ...tid(TID.historyClear) }),
    ),
    fileInput,
  );
  await refresh();
}
