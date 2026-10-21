/**
 * Tiny DOM helpers shared by all screens. No framework: `el` builds an
 * element from a tag, an attribute bag and children, `svg` does the same in
 * the SVG namespace.
 */

export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type Attrs = Record<string, unknown>;

/** Attribute keys that must be set as properties to take effect. */
const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate']);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs, false);
  append(node, children);
  // `value` on a <select> only works once its options exist.
  if (attrs && 'value' in attrs && attrs.value != null) (node as unknown as { value: unknown }).value = attrs.value;
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyAttrs(node, attrs, true);
  append(node, children);
  return node;
}

function applyAttrs(node: Element, attrs: Attrs | null | undefined, isSvg: boolean): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'value') continue; // applied after children (see `el`)
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.setAttribute('class', String(value));
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign((node as HTMLElement).style, value);
    } else if (!isSvg && typeof value === 'boolean') {
      if (PROPERTY_KEYS.has(key)) (node as unknown as Record<string, unknown>)[key] = value;
      else node.setAttribute(key, '');
    } else if (!isSvg && PROPERTY_KEYS.has(key)) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

export function append(node: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function button(
  label: Child,
  onClick: (e: MouseEvent) => void,
  attrs: Attrs = {},
): HTMLButtonElement {
  const { class: cls, ...rest } = attrs;
  return el(
    'button',
    { type: 'button', class: ['btn', cls].filter(Boolean).join(' '), onclick: onClick, ...rest },
    label,
  );
}

export function section(title: Child, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card' }, title ? el('h2', { class: 'card-title' }, title) : null, ...children);
}

/** `data-testid` attribute bag, so screens can spread it into `el`. */
export function tid(id: string): Attrs {
  return { 'data-testid': id };
}

/** Replace `{name}` placeholders in a string from `S`. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export function formatNumber(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function formatDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** `7 h 30 min` style duration from minutes. */
export function formatDurationMin(min: number, hourUnit: string, minuteUnit: string): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  if (h === 0) return `${m} ${minuteUnit}`;
  if (m === 0) return `${h} ${hourUnit}`;
  return `${h} ${hourUnit} ${m} ${minuteUnit}`;
}

/** Hash link; the router treats '#/path' as a route change. */
export function link(label: Child, path: string, attrs: Attrs = {}): HTMLAnchorElement {
  return el('a', { href: '#' + path, ...attrs }, label);
}

/** Screen header with an optional back link on the left. */
export function topbar(title: string, back?: { label: string; path: string }): HTMLElement {
  return el(
    'header',
    { class: 'topbar' },
    back ? link(back.label, back.path, { class: 'topbar-back' }) : null,
    el('h1', { class: 'topbar-title' }, title),
  );
}

export function navigateHash(path: string): void {
  window.location.hash = '#' + (path.startsWith('/') ? path : '/' + path);
}
