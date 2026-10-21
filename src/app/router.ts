/**
 * Minimal hash router. Routes are '#/path/:param'. Each screen renders into
 * the root element and may return a cleanup function that runs on leave.
 */
export type RouteParams = Record<string, string>;

export interface RouteContext {
  path: string;
  params: RouteParams;
  query: URLSearchParams;
}

export type Cleanup = () => void;
export type ScreenRenderer = (
  root: HTMLElement,
  ctx: RouteContext,
) => void | Cleanup | Promise<void | Cleanup>;

interface Route {
  pattern: string;
  parts: string[];
  render: ScreenRenderer;
}

export class Router {
  private routes: Route[] = [];
  private root: HTMLElement | null = null;
  private cleanup: Cleanup | null = null;
  private fallback: string = '/home';
  private renderSeq = 0;
  private listeners = new Set<(ctx: RouteContext) => void>();

  add(pattern: string, render: ScreenRenderer): this {
    this.routes.push({ pattern, parts: pattern.split('/').filter(Boolean), render });
    return this;
  }

  setFallback(path: string): this {
    this.fallback = path;
    return this;
  }

  onChange(cb: (ctx: RouteContext) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(root: HTMLElement): void {
    this.root = root;
    window.addEventListener('hashchange', () => void this.render());
    if (!window.location.hash || window.location.hash === '#') {
      this.navigate(this.fallback, { replace: true });
    } else {
      void this.render();
    }
  }

  current(): RouteContext {
    return parseHash(window.location.hash);
  }

  navigate(path: string, opts: { replace?: boolean } = {}): void {
    const hash = '#' + (path.startsWith('/') ? path : '/' + path);
    if (opts.replace) {
      const url = window.location.pathname + window.location.search + hash;
      window.history.replaceState(null, '', url);
      void this.render();
    } else if (window.location.hash === hash) {
      void this.render();
    } else {
      window.location.hash = hash;
    }
  }

  private match(path: string): { route: Route; params: RouteParams } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: RouteParams = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i];
        const p = parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(p);
        else if (rp !== p) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  private async render(): Promise<void> {
    if (!this.root) return;
    const seq = ++this.renderSeq;
    const ctx = parseHash(window.location.hash);
    const m = this.match(ctx.path);
    if (!m) {
      this.navigate(this.fallback, { replace: true });
      return;
    }
    if (this.cleanup) {
      try {
        this.cleanup();
      } catch (e) {
        console.error('route cleanup failed', e);
      }
      this.cleanup = null;
    }
    // Each render gets its own container. A render that is still awaiting
    // (e.g. loading settings) when the next navigation arrives keeps writing
    // into a container that has already been detached, so stale screens can
    // never appear next to the live one.
    const container = document.createElement('div');
    container.className = 'screen';
    this.root.replaceChildren(container);
    this.root.scrollTop = 0;
    window.scrollTo(0, 0);
    const fullCtx: RouteContext = { ...ctx, params: m.params };
    for (const l of this.listeners) l(fullCtx);
    try {
      const result = await m.route.render(container, fullCtx);
      if (seq !== this.renderSeq) {
        // Navigated away while rendering; run the late cleanup immediately.
        if (typeof result === 'function') result();
        return;
      }
      if (typeof result === 'function') this.cleanup = result;
    } catch (e) {
      console.error('screen render failed', e);
      if (seq !== this.renderSeq) return;
      const pre = document.createElement('pre');
      pre.className = 'error';
      pre.textContent = `Screen failed to render: ${e instanceof Error ? e.message : String(e)}`;
      container.replaceChildren(pre);
    }
  }
}

export function parseHash(hash: string): RouteContext {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qi = raw.indexOf('?');
  const path = (qi >= 0 ? raw.slice(0, qi) : raw) || '/';
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  return { path: path.startsWith('/') ? path : '/' + path, params: {}, query };
}
