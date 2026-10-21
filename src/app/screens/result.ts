import { S } from '../../strings';
import { TID } from '../testids';
import type { RouteContext, Router } from '../router';
import type { VasAnswers } from '../../scoring/types';
import { VAS_KEYS } from '../../scoring/vas';
import type { MeasurementRecord } from '../../storage/types';
import { getDb } from '../state';
import { renderGauge } from '../../ui/gauge';
import { renderRadar } from '../../ui/radar';
import { button, el, fmt, formatDateTime, formatDurationMin, formatNumber, tid, topbar } from '../../ui/dom';

function radarValues(v: VasAnswers): number[] {
  return VAS_KEYS.map((k) => v[k]);
}

function statCard(label: string, value: string, unit: string, testid?: string): HTMLElement {
  return el(
    'div',
    { class: 'stat-card' },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value num-lg', ...(testid ? tid(testid) : {}) }, value),
    el('span', { class: 'stat-unit' }, unit),
  );
}

export async function renderResult(root: HTMLElement, ctx: RouteContext, router: Router): Promise<void> {
  const db = await getDb();
  const record: MeasurementRecord | undefined = await db.getRecord(ctx.params.id ?? '');
  const done = button(S.result.home, () => router.navigate('/home'), { class: 'btn-primary btn-block', ...tid(TID.resultHome) });

  if (!record) {
    root.append(topbar(S.result.title), el('p', { class: 'empty' }, S.common.notFound), done);
    return;
  }

  const settings = await db.getSettings();
  let previousVas: VasAnswers | null = null;
  try {
    const [prev] = await db.listSummaries({ limit: 1, before: record.createdAt });
    if (prev) previousVas = (await db.getRecord(prev.id))?.vas ?? null;
  } catch (e) {
    console.warn('previous record lookup failed', e);
  }

  const sc = record.scores;
  const fatigueLevel = sc.fatigue.level;
  const stressLevel = sc.stress.level;
  const time = record.analysis.time;
  const freq = record.analysis.freq;

  const fatigueGauge = renderGauge({
    title: S.result.brainFatigue,
    level: fatigueLevel,
    valueText: formatNumber(sc.brainFatigue, 0),
    levelLabel: fatigueLevel != null ? S.result.fatigueLevels[fatigueLevel - 1] : S.common.notAvailable,
    levelWord: S.common.level,
    valueTestId: TID.resultFatigueScore,
    levelTestId: TID.resultFatigueLevel,
    note: fatigueLevel == null ? S.result.needProfile : null,
  });

  const stressGauge = renderGauge({
    title: S.result.stress,
    level: stressLevel,
    valueText: formatNumber(sc.stress.value, 2),
    levelLabel: stressLevel != null ? S.result.stressLevels[stressLevel - 1] : S.common.notAvailable,
    levelWord: S.common.level,
    levelTestId: TID.resultStressLevel,
    badge: sc.stress.provisional ? el('span', { class: 'badge', ...tid(TID.resultProvisional) }, S.result.provisional) : null,
    note: stressLevel == null ? S.result.stressUnavailable : null,
  });

  const recoveryLine = el(
    'div',
    { class: 'card recovery-line' },
    el(
      'div',
      { class: 'recovery-main' },
      el('span', { class: 'stat-label' }, S.result.recovery),
      el('span', { class: 'num-md' }, formatNumber(sc.recovery.value, 0)),
    ),
    sc.recovery.value != null ? el('span', { class: 'muted small' }, S.result.deviationHint) : null,
  );

  const sleepText =
    record.sleep.durationMin != null
      ? formatDurationMin(record.sleep.durationMin, S.common.hours, S.common.minutes)
      : S.result.noSleepData;

  const details = el(
    'section',
    { class: 'card' },
    el('h2', { class: 'card-title' }, S.result.details),
    el(
      'div',
      { class: 'stat-grid' },
      statCard(S.result.heartRate, formatNumber(time?.meanHR, 0), S.common.bpm, TID.resultHr),
      statCard(S.result.rmssd, formatNumber(time?.rmssd, 1), S.common.ms, TID.resultRmssd),
      statCard(S.result.hf, formatNumber(freq?.hf, 0), S.common.ms2),
      statCard(S.result.lf, formatNumber(freq?.lf, 0), S.common.ms2),
      statCard(S.result.lfHf, formatNumber(freq?.lfHf, 2), ''),
      statCard(S.result.sleepDuration, sleepText, ''),
    ),
    settings.showStressT && sc.stressT != null
      ? el('p', { class: 'muted' }, `${S.result.stressT}: ${formatNumber(sc.stressT, 0)}`)
      : null,
    sc.autonomicAge != null
      ? el('p', { class: 'muted' }, `${S.result.autonomicAge}: ${formatNumber(sc.autonomicAge, 0)} ${S.result.years}`)
      : null,
  );

  const comments = el(
    'section',
    { class: 'card comments', ...tid(TID.resultComments) },
    el('h2', { class: 'card-title' }, S.result.comments),
    el('p', { class: 'headline' }, record.comments.headline),
    record.comments.lines.length ? el('ul', null, record.comments.lines.map((l) => el('li', null, l))) : null,
    record.comparison.usesPersonalBaseline
      ? el('p', { class: 'muted small' }, fmt(S.result.personalBaseline, { n: record.comparison.nHistory }))
      : null,
  );

  const radar = el(
    'section',
    { class: 'card' },
    el('h2', { class: 'card-title' }, S.result.subjective),
    renderRadar({
      axes: VAS_KEYS.map((k) => S.vas.shortLabels[k]),
      current: radarValues(record.vas),
      previous: previousVas ? radarValues(previousVas) : null,
      currentLabel: S.result.title,
      previousLabel: S.result.previous,
      testid: TID.resultRadar,
    }),
  );

  root.append(
    topbar(S.result.title),
    el('p', { class: 'muted small' }, `${S.result.measuredAt}: ${formatDateTime(record.createdAt)}`),
    fatigueGauge,
    stressGauge,
    recoveryLine,
    comments,
    details,
    radar,
    el('p', { class: 'footnote' }, S.result.footnote),
    done,
  );
}
