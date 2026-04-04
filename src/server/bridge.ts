import { randomUUID } from 'node:crypto';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { ClientMessage, ToolRequest } from '../shared/protocol';
import type { BridgeEvents } from './types';

const REQUEST_TIMEOUT = 10_000;

export class Bridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pendingRequests = new Map<string, {
    reject: (reason: Error) => void;
    resolve: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private events: Partial<BridgeEvents> = {};

  constructor(private readonly port: number) {}

  onRegistration(handler: BridgeEvents['onRegistration']): void {
    this.events.onRegistration = handler;
  }

  onStateUpdate(handler: BridgeEvents['onStateUpdate']): void {
    this.events.onStateUpdate = handler;
  }

  onStateRemove(handler: BridgeEvents['onStateRemove']): void {
    this.events.onStateRemove = handler;
  }

  onToolRegister(handler: BridgeEvents['onToolRegister']): void {
    this.events.onToolRegister = handler;
  }

  onToolUnregister(handler: BridgeEvents['onToolUnregister']): void {
    this.events.onToolUnregister = handler;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on('connection', (ws) => {
        this.client = ws;

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(String(data)) as ClientMessage;
            this.handleMessage(message);
          } catch {
            // ignore malformed messages
          }
        });

        ws.on('close', () => {
          if (this.client === ws) {
            this.client = null;
            this.rejectAllPending('Client disconnected');
          }
        });
      });

      this.wss.on('listening', () => {
        resolve();
      });
    });
  }

  async call(module: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      throw new Error('No client connected');
    }

    const id = randomUUID();
    const request: ToolRequest = {
      args,
      id,
      method,
      module,
      type: 'tool_request',
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${module}.${method} timed out after ${REQUEST_TIMEOUT}ms`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { reject, resolve, timer });
      this.client!.send(JSON.stringify(request));
    });
  }

  isClientConnected(): boolean {
    return this.client !== null;
  }

  async stop(): Promise<void> {
    this.rejectAllPending('Server stopping');
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'registration': {
        this.events.onRegistration?.(message.modules);
        break;
      }
      case 'tool_response': {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message.result);
          }
        }
        break;
      }
      case 'state_update': {
        this.events.onStateUpdate?.(message.key, message.value);
        break;
      }
      case 'state_remove': {
        this.events.onStateRemove?.(message.key);
        break;
      }
      case 'tool_register': {
        this.events.onToolRegister?.(message.module, message.tool);
        break;
      }
      case 'tool_unregister': {
        this.events.onToolUnregister?.(message.module, message.toolName);
        break;
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }
}
