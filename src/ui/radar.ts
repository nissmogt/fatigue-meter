/**
 * Pentagon radar of the five VAS answers (0–100), with an optional dashed
 * overlay of the previous measurement.
 */
import { el, svg, tid } from './dom';

export interface RadarOptions {
  axes: string[];
  current: number[];
  previous?: number[] | null;
  max?: number;
  currentLabel: string;
  previousLabel: string;
  testid?: string;
}

// Wider than tall so the side labels ("Relaxation", "Sleep") fit inside the viewBox.
const W = 360;
const H = 250;
const CX = W / 2;
const CY = H / 2 + 6;
const R = 88;

function point(i: number, n: number, r: number): [number, number] {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function polygon(values: number[], max: number): string {
  const n = values.length;
  return values
    .map((v, i) => {
      const [x, y] = point(i, n, (Math.min(max, Math.max(0, v)) / max) * R);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function renderRadar(o: RadarOptions): HTMLElement {
  const n = o.axes.length;
  const max = o.max ?? 100;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'radar',
    role: 'img',
    'aria-label': o.axes.map((a, i) => `${a} ${Math.round(o.current[i] ?? 0)}`).join(', '),
    ...(o.testid ? tid(o.testid) : {}),
  });

  // Grid rings and spokes.
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    root.appendChild(svg('polygon', { points: polygon(new Array(n).fill(max * frac), max), class: 'radar-grid' }));
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, n, R);
    root.appendChild(svg('line', { x1: CX, y1: CY, x2: x.toFixed(1), y2: y.toFixed(1), class: 'radar-grid' }));
  }

  if (o.previous && o.previous.length === n) {
    root.appendChild(svg('polygon', { points: polygon(o.previous, max), class: 'radar-previous' }));
  }
  root.appendChild(svg('polygon', { points: polygon(o.current, max), class: 'radar-current' }));
  o.current.forEach((v, i) => {
    const [x, y] = point(i, n, (Math.min(max, Math.max(0, v)) / max) * R);
    root.appendChild(svg('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 4, class: 'radar-marker' }));
  });

  // Axis labels, anchored by their side of the chart.
  o.axes.forEach((label, i) => {
    const [x, y] = point(i, n, R + 18);
    const anchor = Math.abs(x - CX) < 6 ? 'middle' : x < CX ? 'end' : 'start';
    root.appendChild(
      svg('text', { x: x.toFixed(1), y: (y + 4).toFixed(1), 'text-anchor': anchor, class: 'radar-label' }, label),
    );
  });

  const legend = o.previous
    ? el(
        'div',
        { class: 'legend' },
        el('span', { class: 'legend-item' }, el('span', { class: 'swatch swatch-current' }), o.currentLabel),
        el('span', { class: 'legend-item' }, el('span', { class: 'swatch swatch-previous' }), o.previousLabel),
      )
    : null;

  return el('div', { class: 'radar-wrap' }, root, legend);
}
