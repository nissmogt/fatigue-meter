/**
 * VAS slider: a range input with anchor texts and a live value. Reports the
 * first user interaction of any kind (drag, tap on the track, keyboard), so
 * the questionnaire can enable "Next" only after the user has engaged.
 */
import { el, tid } from './dom';

export interface SliderOptions {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  leftLabel: string;
  rightLabel: string;
  ariaLabel?: string;
  testid?: string;
  onInput?: (value: number) => void;
  /** Fired once, on the first interaction. */
  onInteract?: () => void;
}

export interface Slider {
  root: HTMLElement;
  input: HTMLInputElement;
  value(): number;
  setValue(v: number): void;
  touched(): boolean;
}

const KEYBOARD_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function createSlider(opts: SliderOptions): Slider {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const input = el('input', {
    type: 'range',
    class: 'slider',
    min,
    max,
    step: opts.step ?? 1,
    value: String(opts.value),
    'aria-label': opts.ariaLabel,
    ...(opts.testid ? tid(opts.testid) : {}),
  });
  const output = el('output', { class: 'slider-value', 'aria-live': 'polite' }, String(opts.value));

  let touched = false;
  const markTouched = () => {
    if (touched) return;
    touched = true;
    opts.onInteract?.();
  };
  const onValue = () => {
    output.textContent = input.value;
    markTouched();
    opts.onInput?.(Number(input.value));
  };
  input.addEventListener('input', onValue);
  input.addEventListener('change', onValue);
  input.addEventListener('keydown', (e) => {
    if (KEYBOARD_KEYS.has(e.key)) markTouched();
  });
  // A tap on the track (even one that lands on the current value) counts.
  const track = el('div', { class: 'slider-track', onpointerdown: markTouched }, input);

  const root = el(
    'div',
    { class: 'slider-wrap' },
    el('div', { class: 'slider-value-row' }, output),
    track,
    el(
      'div',
      { class: 'slider-anchors' },
      el('span', { class: 'slider-anchor' }, opts.leftLabel),
      el('span', { class: 'slider-anchor' }, opts.rightLabel),
    ),
  );

  return {
    root,
    input,
    value: () => Number(input.value),
    setValue(v: number) {
      input.value = String(Math.min(max, Math.max(min, v)));
      output.textContent = input.value;
    },
    touched: () => touched,
  };
}
