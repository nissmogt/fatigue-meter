/**
 * Five-level semicircular gauge (SVG). Level 1 is the "good" end, level 5
 * the "warning" end, for both brain fatigue and stress. Colour never carries
 * the meaning alone: the level number and its label are always printed.
 */
import { el, svg, tid } from './dom';

export interface GaugeOptions {
  title: string;
  /** 1..levels, or null when the score is unavailable. */
  level: number | null;
  levels?: number;
  /** Large number shown in the gauge. */
  valueText: string;
  /** Text label of the level (e.g. "Average"). */
  levelLabel: string;
  /** Word printed before the level number ("Level"). */
  levelWord: string;
  valueTestId?: string;
  levelTestId?: string;
  /** Optional badge (e.g. "provisional") shown under the label. */
  badge?: HTMLElement | null;
  /** Optional note shown when the score is unavailable or needs context. */
  note?: string | null;
}

/** CSS colour for a level (status scale, light/dark variants live in styles.css). */
export function levelColor(level: number | null): string {
  if (level == null) return 'var(--muted)';
  return `var(--level-${Math.min(5, Math.max(1, Math.round(level)))})`;
}

const CX = 100;
const CY = 104;
const R = 72;
const GAP_DEG = 2;

function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
}

function arcPath(fromDeg: number, toDeg: number, r: number): string {
  // Angles run from 180 (left) down to 0 (right); the sweep is clockwise on screen.
  const [x1, y1] = polar(fromDeg, r);
  const [x2, y2] = polar(toDeg, r);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Small triangle outside the arc pointing at the active segment. */
function pointerPath(deg: number): string {
  const [ax, ay] = polar(deg, R + 11);
  const [bx, by] = polar(deg - 5, R + 22);
  const [cx, cy] = polar(deg + 5, R + 22);
  return `M ${ax.toFixed(2)} ${ay.toFixed(2)} L ${bx.toFixed(2)} ${by.toFixed(2)} L ${cx.toFixed(2)} ${cy.toFixed(2)} Z`;
}

export function renderGauge(o: GaugeOptions): HTMLElement {
  const levels = o.levels ?? 5;
  const segDeg = 180 / levels;
  const root = svg('svg', {
    viewBox: '0 0 200 118',
    class: 'gauge',
    role: 'img',
    // An unavailable score is announced with its explanation, not as two dashes.
    'aria-label': o.level == null ? `${o.title}: ${o.note ?? o.levelLabel}` : `${o.title}: ${o.valueText}, ${o.levelLabel}`,
  });

  for (let i = 0; i < levels; i++) {
    const from = 180 - i * segDeg - GAP_DEG / 2;
    const to = 180 - (i + 1) * segDeg + GAP_DEG / 2;
    const active = o.level != null && i === o.level - 1;
    root.appendChild(
      svg('path', {
        d: arcPath(from, to, R),
        class: 'gauge-seg' + (active ? ' gauge-seg-active' : ''),
        style: { stroke: levelColor(i + 1) },
        'stroke-width': active ? 16 : 12,
        fill: 'none',
        opacity: active ? 1 : 0.28,
      }),
    );
  }

  if (o.level != null) {
    const mid = 180 - (o.level - 0.5) * segDeg;
    root.appendChild(svg('path', { d: pointerPath(mid), class: 'gauge-pointer', style: { fill: levelColor(o.level) } }));
  }

  root.appendChild(
    svg(
      'text',
      { x: CX, y: CY, class: 'gauge-value', 'text-anchor': 'middle', ...(o.valueTestId ? tid(o.valueTestId) : {}) },
      o.valueText,
    ),
  );

  const levelLine = el(
    'p',
    { class: 'gauge-level' },
    el('span', { class: 'gauge-level-word' }, o.levelWord, ' '),
    el(
      'span',
      { class: 'gauge-level-num', style: { color: levelColor(o.level) }, ...(o.levelTestId ? tid(o.levelTestId) : {}) },
      o.level == null ? '' : String(o.level),
    ),
    o.level == null ? null : el('span', { class: 'gauge-level-sep' }, ' · '),
    el('span', { class: 'gauge-level-label' }, o.levelLabel),
  );

  return el(
    'div',
    { class: 'gauge-card card' },
    el('h2', { class: 'card-title' }, o.title),
    root,
    levelLine,
    o.badge ?? null,
    o.note ? el('p', { class: 'gauge-note' }, o.note) : null,
  );
}
