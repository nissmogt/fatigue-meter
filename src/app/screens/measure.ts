/**
 * Measurement screen: an in-page state machine. There is no hash change
 * between camera start and stream stop (home-screen web apps on iOS can lose
 * the camera on navigation). The countdown is driven by sample time, so the
 * synthetic source under a fake clock behaves exactly like the camera.
 *
 *   idle -> starting -> placing-finger -> settling -> measuring -> analysing -> done
 *                                   ^__________________|                  \-> failed
 */
import { S } from '../../strings';
import { TID } from '../testids';
import type { Cleanup, RouteContext, Router } from '../router';
import type { Sample } from '../../dsp/types';
import { toSeries } from '../../dsp/types';
import { analyzePPG, liveSnapshot } from '../../dsp/pipeline-impl';
import type { AnalysisResult, GateReason, LiveSnapshot } from '../../dsp/pipeline';
import { SourceError, type LockResult, type SampleSource, type SourceEvent, type SourceInfo } from '../../capture/source';
import { createCameraSource } from '../../capture/camera';
import { createSyntheticSource } from '../../capture/synthetic';
import { compareScores, scoreInputFromAnalysis, scoreMeasurement } from '../../scoring/score';
import { buildComments } from '../../scoring/comments';
import { makeSleepInfo } from '../../scoring/vas';
import { SCHEMA_VERSION, type CaptureMeta, type MeasurementRecord, type Settings } from '../../storage/types';
import { newRecordId } from '../../storage/db';
import {
  clearSession,
  getDb,
  getSession,
  getSourceChoice,
  setDiagnostics,
  sourceChoiceFromQuery,
  vasAnswersOrDefault,
  type SourceChoice,
} from '../state';
import { createWaveform } from '../../ui/waveform';
import { append, button, el, tid, topbar } from '../../ui/dom';

type Phase = 'idle' | 'starting' | 'placing-finger' | 'settling' | 'measuring' | 'analysing' | 'done' | 'failed';

const SETTLE_S = 2; // continuous good signal before the clock starts
const FINGER_OFF_S = 1; // finger off this long during measuring -> restart placement
const POST_PAD_S = 2; // extra samples after the window (zero-phase filter padding)
const LIVE_WINDOW_S = 8;
const TICK_MS = 250;
const PAD_TIMEOUT_MS = 4000; // wall-clock guard if samples stop arriving during post-pad

const VIDEO_ID = 'ppg-video';
const VIDEO_HIDDEN_CLASS = 'ppg-hidden';

/** The persistently mounted preview element; created if the shell lacks it (tests). */
function getVideo(): HTMLVideoElement {
  let v = document.getElementById(VIDEO_ID) as HTMLVideoElement | null;
  if (!v) {
    v = el('video', { id: VIDEO_ID, class: VIDEO_HIDDEN_CLASS, autoplay: true, muted: true, playsinline: true });
    v.muted = true;
    document.body.appendChild(v);
  }
  return v;
}

function makeSource(choice: SourceChoice, settings: Settings): SampleSource {
  if (choice.kind === 'synthetic') {
    return createSyntheticSource({
      seed: choice.seed,
      preset: choice.preset,
      fingerOffWindows: choice.fingerOffWindows,
      // The source default covers one settle + window + post-pad; a scripted
      // finger-off restart needs a second window on top.
      durationS: choice.fingerOffWindows ? settings.measureSeconds * 2 + 40 : undefined,
    });
  }
  return createCameraSource({ deviceId: settings.preferredCameraId ?? undefined });
}

function startErrorMessage(e: unknown): string {
  if (e instanceof SourceError) return S.measure.errors[e.code] ?? S.measure.errors.unknown;
  return S.measure.errors.unknown;
}

function fingerStatus(snap: LiveSnapshot): string {
  if (!snap.fingerOn) {
    switch (snap.fingerReason) {
      case 'too-dark':
        return S.measure.tooDark;
      case 'saturated':
        return S.measure.saturated;
      case 'moving':
        return S.measure.moving;
      default:
        return S.measure.placeFinger;
    }
  }
  if (snap.fingerReason === 'moving') return S.measure.moving;
  return snap.quality === 'good' ? S.measure.holdStill : S.measure.waitingSignal;
}

function qualityLabel(q: LiveSnapshot['quality']): string {
  return q === 'good' ? S.measure.good : q === 'poor' ? S.measure.poor : S.measure.qualityNone;
}

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

export async function renderMeasure(root: HTMLElement, ctx: RouteContext, router: Router): Promise<Cleanup> {
  const choice = sourceChoiceFromQuery(ctx.query) ?? getSourceChoice();
  // Settings and profile are loaded up front so the Start tap calls
  // source.start() synchronously inside the user-gesture chain.
  const db = await getDb();
  const [settings, profile] = await Promise.all([db.getSettings(), db.getProfile()]);
  const measureSeconds = settings.measureSeconds;

  // --- DOM ----------------------------------------------------------------
  const video = getVideo();
  const preview = el('div', { class: 'preview' }, video);
  video.classList.remove(VIDEO_HIDDEN_CLASS);

  const statusEl = el('p', { class: 'status', role: 'status', ...tid(TID.measureStatus) }, S.measure.ready);
  const countdownEl = el('div', { class: 'countdown num-xl', ...tid(TID.measureCountdown) }, String(measureSeconds));
  const qualityEl = el('span', { class: 'pill pill-none', ...tid(TID.measureQuality) }, S.common.notAvailable);
  const hrEl = el('span', { class: 'num-md', ...tid(TID.measureHr) }, S.common.notAvailable);
  const canvas = el('canvas', { class: 'wave', width: 320, height: 96, 'aria-hidden': 'true' });
  const waveform = createWaveform(canvas);
  const torchHint = el('p', { class: 'hint-box', hidden: true }, S.measure.torchOff);
  const tipsEl = el(
    'section',
    { class: 'tips' },
    el('h2', { class: 'card-title' }, S.measure.tipsTitle),
    el('ul', null, S.measure.tips.map((t) => el('li', null, t))),
  );
  const errorEl = el('div', { class: 'error-box', role: 'alert', hidden: true, ...tid(TID.measureError) });
  const startBtn = button(S.measure.start, () => void start(), { class: 'btn-primary btn-block btn-large', ...tid(TID.measureStart) });
  const retryBtn = button(S.measure.retry, () => void start(), { class: 'btn-primary btn-block', hidden: true, ...tid(TID.measureRetry) });
  const cancelBtn = button(S.measure.cancel, () => void cancel(), { class: 'btn-ghost btn-block' });

  append(root, [
    topbar(S.measure.title),
    choice.kind === 'synthetic' ? el('p', { class: 'badge badge-demo' }, S.measure.demoBadge) : null,
    el(
      'div',
      { class: 'measure-head' },
      preview,
      el(
        'div',
        { class: 'measure-live' },
        el('div', { class: 'live-row' }, el('span', { class: 'live-label' }, S.measure.qualityLabel), qualityEl),
        el('div', { class: 'live-row' }, el('span', { class: 'live-label' }, S.measure.hrLabel), hrEl, el('span', { class: 'unit' }, S.common.bpm)),
      ),
    ),
    el('div', { class: 'countdown-wrap' }, countdownEl, el('span', { class: 'countdown-label' }, S.measure.remaining)),
    statusEl,
    canvas,
    torchHint,
    errorEl,
    el('div', { class: 'btn-col' }, startBtn, retryBtn, cancelBtn),
    tipsEl,
  ]);

  // --- State ----------------------------------------------------------------
  let phase: Phase = 'idle';
  let source: SampleSource | null = null;
  let unsubscribes: Array<() => void> = [];
  let samples: Sample[] = [];
  let info: SourceInfo | null = null;
  let torchOn = false;
  let lock: LockResult | null = null;
  let lockRequested = false;
  let t0: number | null = null;
  let goodSince: number | null = null;
  let fingerOffSince: number | null = null;
  let padStartedAt = 0;
  let timer: number | null = null;
  let finishing = false;
  let disposed = false;
  let runId = 0;

  function setPhase(p: Phase, status?: string): void {
    phase = p;
    if (status !== undefined) statusEl.textContent = status;
    root.dataset.phase = p;
    tipsEl.hidden = !(p === 'idle' || p === 'placing-finger' || p === 'failed');
  }

  function stopTimer(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  async function stopSource(): Promise<void> {
    const s = source;
    for (const u of unsubscribes) u();
    unsubscribes = [];
    source = null;
    if (!s) return;
    try {
      await s.stop();
    } catch (e) {
      console.warn('source stop failed', e);
    }
  }

  function recentSamples(fromT: number): Sample[] {
    let i = samples.length;
    while (i > 0 && samples[i - 1].t >= fromT) i--;
    return samples.slice(i);
  }

  function resetClock(): void {
    t0 = null;
    goodSince = null;
    fingerOffSince = null;
    countdownEl.textContent = String(measureSeconds);
  }

  function captureMeta(deliveredFps: number): CaptureMeta {
    const first = samples[0];
    const last = samples[samples.length - 1];
    return {
      kind: info?.kind ?? choice.kind,
      label: info?.label ?? '',
      width: info?.width ?? 0,
      height: info?.height ?? 0,
      nominalFps: info?.nominalFps ?? 0,
      deliveredFps,
      torch: torchOn,
      locked: !!lock && (lock.exposure || lock.focus || lock.whiteBalance),
      durationS: first && last ? last.t - first.t : 0,
      timeBase: info?.timeBase ?? '',
      userAgent: navigator.userAgent,
    };
  }

  // --- Flow ------------------------------------------------------------------
  async function start(): Promise<void> {
    if (phase !== 'idle' && phase !== 'failed') return;
    const run = ++runId;
    samples = [];
    info = null;
    torchOn = false;
    lock = null;
    lockRequested = false;
    finishing = false;
    resetClock();
    errorEl.hidden = true;
    errorEl.replaceChildren();
    torchHint.hidden = true;
    retryBtn.hidden = true;
    startBtn.hidden = true;
    cancelBtn.hidden = false;
    waveform.clear();
    setPhase('starting', S.measure.starting);

    const s = makeSource(choice, settings);
    source = s;
    unsubscribes.push(s.onSample(onSample), s.onEvent(onEvent));
    try {
      // Called synchronously from the tap handler chain (getUserMedia needs the gesture).
      info = await s.start(video);
    } catch (e) {
      if (run !== runId || disposed) return;
      await fail(startErrorMessage(e));
      return;
    }
    if (run !== runId || disposed) return;

    setPhase('placing-finger', S.measure.placeFinger);
    timer = window.setInterval(tick, TICK_MS);

    let on = false;
    try {
      on = await s.setTorch(true);
    } catch {
      on = false;
    }
    if (run !== runId || disposed) return;
    torchOn = on;
    torchHint.hidden = on;
  }

  function onSample(sample: Sample): void {
    samples.push(sample);
  }

  function onEvent(e: SourceEvent): void {
    switch (e.type) {
      case 'started':
        info = e.info;
        break;
      case 'torch':
        torchOn = e.on;
        torchHint.hidden = e.on;
        break;
      case 'locked':
        lock = e.result;
        break;
      case 'interrupted':
        if (phase === 'analysing') void finish(); // the window is complete; use what we have
        else if (isActive()) void fail(S.measure.interrupted);
        break;
      case 'error':
        if (isActive()) void fail(S.measure.errors[e.error.code] ?? S.measure.errors.unknown);
        break;
      case 'stopped':
        break;
    }
  }

  function isActive(): boolean {
    return phase === 'starting' || phase === 'placing-finger' || phase === 'settling' || phase === 'measuring';
  }

  function updateLive(snap: LiveSnapshot): void {
    qualityEl.textContent = qualityLabel(snap.quality);
    qualityEl.className = `pill pill-${snap.quality}`;
    hrEl.textContent = snap.hrBpm != null && Number.isFinite(snap.hrBpm) ? String(Math.round(snap.hrBpm)) : S.common.notAvailable;
    waveform.draw(snap.wave);
  }

  function tick(): void {
    if (samples.length === 0) return;
    const last = samples[samples.length - 1];
    const snap = liveSnapshot(toSeries(recentSamples(last.t - LIVE_WINDOW_S)), LIVE_WINDOW_S);
    updateLive(snap);

    switch (phase) {
      case 'placing-finger':
      case 'settling': {
        const ok = snap.fingerOn && snap.quality === 'good';
        if (!ok) {
          goodSince = null;
          setPhase('placing-finger', fingerStatus(snap));
          break;
        }
        if (goodSince === null) {
          goodSince = last.t;
          setPhase('settling', S.measure.settling);
        }
        if (last.t - goodSince >= SETTLE_S) beginMeasuring(last.t);
        break;
      }
      case 'measuring': {
        const elapsed = last.t - (t0 ?? last.t);
        countdownEl.textContent = String(Math.max(0, Math.ceil(measureSeconds - elapsed)));
        if (!snap.fingerOn) {
          if (fingerOffSince === null) fingerOffSince = last.t;
          if (last.t - fingerOffSince >= FINGER_OFF_S) {
            restartPlacement();
            break;
          }
        } else {
          fingerOffSince = null;
        }
        statusEl.textContent = fingerStatus(snap);
        if (elapsed >= measureSeconds) {
          countdownEl.textContent = '0';
          padStartedAt = performance.now();
          setPhase('analysing', S.measure.analyzing);
        }
        break;
      }
      case 'analysing': {
        if (t0 === null) break;
        const padded = last.t >= t0 + measureSeconds + POST_PAD_S;
        if (padded || performance.now() - padStartedAt >= PAD_TIMEOUT_MS) void finish();
        break;
      }
      default:
        break;
    }
  }

  function beginMeasuring(t: number): void {
    t0 = t;
    fingerOffSince = null;
    setPhase('measuring', S.measure.holdStill);
    if (!lockRequested && source) {
      lockRequested = true;
      source
        .lockControls()
        .then((r) => {
          lock = r;
        })
        .catch(() => undefined);
    }
  }

  /** Finger off for too long: keep the samples collected so far, restart the clock. */
  function restartPlacement(): void {
    resetClock();
    setPhase('placing-finger', S.measure.fingerMoved);
  }

  async function fail(message: string, reasons: readonly GateReason[] = []): Promise<void> {
    runId++;
    stopTimer();
    const deliveredFps = source?.deliveredFps() ?? 0;
    await stopSource();
    if (disposed) return;
    setPhase('failed', message);
    errorEl.replaceChildren();
    append(errorEl, [
      el('p', { class: 'error-title' }, message),
      reasons.length ? el('ul', null, reasons.map((r) => el('li', null, S.measure.gate[r] ?? r))) : null,
    ]);
    errorEl.hidden = false;
    retryBtn.hidden = false;
    cancelBtn.hidden = false;
    resetClock();
    if (samples.length > 0) {
      setDiagnostics({
        at: Date.now(),
        capture: captureMeta(deliveredFps),
        verdict: reasons.length ? 'fail' : null,
        reasons: [...reasons],
        fsSource: null,
        dropFraction: null,
        error: message,
      });
    }
  }

  async function finish(): Promise<void> {
    if (finishing || t0 === null) return;
    finishing = true;
    stopTimer();
    const startS = t0;
    const deliveredFps = source?.deliveredFps() ?? 0;
    await stopSource(); // torch off, camera released before the heavy analysis
    if (disposed) return;
    setPhase('analysing', S.measure.analyzing);
    await new Promise<void>((r) => window.setTimeout(r, 0)); // let the status paint

    let analysis: AnalysisResult;
    try {
      analysis = analyzePPG(toSeries(samples), { window: { startS, endS: startS + measureSeconds } });
    } catch (e) {
      console.error('analysis failed', e);
      finishing = false;
      await fail(S.measure.analysisFailed);
      return;
    }
    const capture = captureMeta(deliveredFps);
    setDiagnostics({
      at: Date.now(),
      capture,
      verdict: analysis.quality.verdict,
      reasons: [...analysis.quality.reasons],
      fsSource: analysis.fsSource,
      dropFraction: analysis.quality.dropFraction,
      error: null,
    });
    if (analysis.quality.verdict === 'fail') {
      finishing = false;
      await fail(S.measure.failedTitle, analysis.quality.reasons);
      return;
    }

    try {
      const scores = scoreMeasurement(scoreInputFromAnalysis(analysis), profile);
      const [previous, history] = await Promise.all([db.latestScores(1), db.latestScores(30)]);
      const comparison = compareScores(scores, previous[0] ?? null, history);
      const session = getSession();
      const vas = vasAnswersOrDefault(session.vas);
      const sleep = session.didNotSleep ? makeSleepInfo(null, null) : makeSleepInfo(session.bedtime, session.wake);
      const comments = buildComments(scores, comparison, vas, sleep);
      const { waveform: _waveform, ...analysisStored } = analysis;
      const record: MeasurementRecord = {
        id: newRecordId(),
        createdAt: Date.now(),
        tz: timeZone(),
        schemaVersion: SCHEMA_VERSION,
        analysisVersion: analysis.version,
        vas,
        sleep,
        profile,
        capture,
        series: settings.keepRawSeries ? toSeries(samples) : null,
        analysis: analysisStored,
        scores,
        comparison,
        comments,
      };
      await db.putRecord(record);
      if (disposed) return;
      clearSession();
      setPhase('done');
      router.navigate(`/result/${encodeURIComponent(record.id)}`);
    } catch (e) {
      console.error('scoring or saving failed', e);
      finishing = false;
      await fail(S.measure.analysisFailed);
    }
  }

  async function cancel(): Promise<void> {
    runId++;
    stopTimer();
    await stopSource();
    if (disposed) return;
    router.navigate('/home');
  }

  // --- Cleanup on route leave --------------------------------------------------
  return () => {
    disposed = true;
    runId++;
    stopTimer();
    void stopSource();
    waveform.destroy();
    // Keep the video mounted (and never display:none) for the next measurement.
    video.classList.add(VIDEO_HIDDEN_CLASS);
    document.body.appendChild(video);
  };
}
