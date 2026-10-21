/**
 * Live pulse-wave trace on a <canvas>. Draws whatever band-passed window the
 * live snapshot provides (positive = systole), auto-scaled to its own range.
 */

export interface Waveform {
  draw(wave: ArrayLike<number>): void;
  clear(): void;
  destroy(): void;
}

export function createWaveform(canvas: HTMLCanvasElement): Waveform {
  const ctx = canvas.getContext('2d');
  let last: ArrayLike<number> | null = null;

  const fit = (): boolean => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round((canvas.clientWidth || 320) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || 96) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  };

  const cssVar = (name: string, fallback: string): string => {
    const v = getComputedStyle(canvas).getPropertyValue(name).trim();
    return v || fallback;
  };

  const render = () => {
    if (!ctx) return;
    fit();
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    // Baseline.
    ctx.strokeStyle = cssVar('--wave-grid', 'rgba(148, 163, 184, 0.35)');
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const wave = last;
    if (!wave || wave.length < 2) return;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < wave.length; i++) {
      const v = wave[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const span = max - min || 1;
    const pad = 6 * dpr;
    const n = wave.length;

    ctx.strokeStyle = cssVar('--wave', '#38bdf8');
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - pad - ((wave[i] - min) / span) * (h - 2 * pad);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => render()) : null;
  ro?.observe(canvas);
  render();

  return {
    draw(wave) {
      last = wave;
      render();
    },
    clear() {
      last = null;
      render();
    },
    destroy() {
      ro?.disconnect();
      last = null;
    },
  };
}
