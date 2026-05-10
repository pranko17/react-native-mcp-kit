import WebSocket from 'ws';

const DEFAULT_BUFFER_LIMIT = 200;
const RECONNECT_MS = 3_000;

export interface CapturedMetroEvent {
  data: Record<string, unknown>;
  id: number;
  receivedAt: number;
  type: string;
}

/**
 * Maintains a single WebSocket to Metro's `/events` endpoint and buffers the
 * last N events with server-side timestamps. Tools query the buffer with
 * filters; we never stream back to the agent directly. Connection is lazy
 * (first call to `ensureConnected`), auto-reconnecting with fixed backoff.
 */
class MetroEventCapture {
  private ws: WebSocket | null = null;
  private buffer: CapturedMetroEvent[] = [];
  private nextId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastError: string | null = null;

  constructor(
    private readonly metroUrl: string,
    private readonly bufferLimit: number
  ) {}

  ensureConnected(): void {
    if (this.disposed) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const wsUrl = this.metroUrl.replace(/^http/, 'ws') + '/events';
    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      this.lastError = null;

      socket.on('message', (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as { type?: unknown } & Record<string, unknown>;
          if (typeof parsed.type !== 'string') return;
          const { type, ...data } = parsed;
          const entry: CapturedMetroEvent = {
            data,
            id: this.nextId++,
            receivedAt: Date.now(),
            type,
          };
          this.buffer.push(entry);
          if (this.buffer.length > this.bufferLimit) {
            this.buffer.splice(0, this.buffer.length - this.bufferLimit);
          }
        } catch {
          // malformed message — skip
        }
      });

      socket.on('error', (err) => {
        this.lastError = (err as Error).message;
      });

      socket.on('close', () => {
        this.ws = null;
        this.scheduleReconnect();
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, RECONNECT_MS);
  }

  getEvents(filter: { since?: number; type?: string | string[] }): {
    connected: boolean;
    events: CapturedMetroEvent[];
    lastError: string | null;
    total: number;
  } {
    this.ensureConnected();
    const typeFilter = filter.type;
    const matchType = Array.isArray(typeFilter)
      ? (t: string): boolean => {
          return typeFilter.includes(t);
        }
      : typeof typeFilter === 'string'
        ? (t: string): boolean => {
            return t === typeFilter;
          }
        : null;

    const since = typeof filter.since === 'number' ? filter.since : null;
    const filtered = this.buffer.filter((e) => {
      if (matchType && !matchType(e.type)) return false;
      if (since !== null && e.receivedAt < since) return false;
      return true;
    });
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      events: filtered,
      lastError: this.lastError,
      total: filtered.length,
    };
  }

  clear(): void {
    this.buffer = [];
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

const captures = new Map<string, MetroEventCapture>();

export const getEventCapture = (
  metroUrl: string,
  bufferLimit: number = DEFAULT_BUFFER_LIMIT
): MetroEventCapture => {
  let capture = captures.get(metroUrl);
  if (!capture) {
    capture = new MetroEventCapture(metroUrl, bufferLimit);
    captures.set(metroUrl, capture);
  }
  capture.ensureConnected();
  return capture;
};
