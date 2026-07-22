// RN-shaped XMLHttpRequest double, installed as the global at module
// scope. Import this module BEFORE '@/modules/network' — the network
// patches attach to global.XMLHttpRequest at import time, and ESM
// evaluates modules in import-declaration order.
//
// RN-shaped XMLHttpRequest double: `status` / `readyState` are own data
// props the "runtime" assigns into, `responseText` / `response` are
// prototype getters over an internal `_response` slot — the exact layout
// the shadow logic in mocks.ts must handle. dispatchEvent deliberately
// calls `onX` attribute handlers BEFORE addEventListener listeners: the
// worst case for value patching, proving shadows don't depend on listener
// registration order.
export type RouteSpec = { body: string; headers: Record<string, string>; status: number };

export class FakeXHR {
  static routes: Record<string, RouteSpec> = {};

  readyState = 0;
  status = 0;
  statusText = '';
  responseType = '';
  timeout = 0;
  method = '';
  url = '';

  _response = '';
  _responseHeaders: Record<string, string> = {};

  onabort: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onload: ((ev: unknown) => void) | null = null;
  onloadend: ((ev: unknown) => void) | null = null;
  onreadystatechange: ((ev: unknown) => void) | null = null;
  ontimeout: ((ev: unknown) => void) | null = null;

  private listeners: Array<{ fn: (ev: unknown) => void; type: string }> = [];

  get responseText(): string {
    return this._response;
  }

  get response(): unknown {
    if (this.responseType === 'json') {
      try {
        return JSON.parse(this._response || 'null');
      } catch {
        return null;
      }
    }
    return this._response;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(): void {}

  getAllResponseHeaders(): string {
    return Object.entries(this._responseHeaders)
      .map(([key, value]) => {
        return `${key}: ${value}`;
      })
      .join('\r\n');
  }

  getResponseHeader(name: string): string | null {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(this._responseHeaders)) {
      if (key.toLowerCase() === lower) return value;
    }
    return null;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.push({ fn, type });
  }

  removeEventListener(): void {}

  dispatchEvent(ev: { type: string }): boolean {
    const attribute = (this as unknown as Record<string, unknown>)[`on${ev.type}`];
    if (typeof attribute === 'function') attribute.call(this, ev);
    for (const listener of this.listeners) {
      if (listener.type === ev.type) listener.fn.call(this, ev);
    }
    return true;
  }

  send(): void {
    setTimeout(() => {
      const route = FakeXHR.routes[this.url] ?? {
        body: '{"real":true}',
        headers: { 'content-type': 'application/json', 'x-served-by': 'fake-server' },
        status: 200,
      };
      this.readyState = 4;
      this.status = route.status;
      this._responseHeaders = route.headers;
      this._response = route.body;
      this.dispatchEvent({ type: 'readystatechange' });
      this.dispatchEvent({ type: 'load' });
      this.dispatchEvent({ type: 'loadend' });
    }, 0);
  }

  abort(): void {}
}

(globalThis as unknown as Record<string, unknown>).XMLHttpRequest = FakeXHR;
