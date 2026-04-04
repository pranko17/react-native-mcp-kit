import type { ClientMessage, ServerMessage } from '../shared/protocol';

const RECONNECT_INTERVAL = 3000;

export class McpConnection {
  private ws: WebSocket | null = null;
  private messageHandler: ((message: ServerMessage) => void) | null = null;
  private openHandler: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly port: number) {}

  connect(): void {
    if (this.disposed) return;

    try {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);

      this.ws.onopen = () => {
        this.openHandler?.();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          this.messageHandler?.(message);
        } catch {
          // ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: (message: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, RECONNECT_INTERVAL);
  }
}
