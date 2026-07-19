import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import {
  PROXY_PATH,
  type ProxyServerMessage,
  type WireCallResult,
  type WireToolDescriptor,
} from '@/shared/proxyProtocol';

import { type FrontBackend } from './mcpFront';

const HELLO_TIMEOUT_MS = 3_000;
const LIST_TIMEOUT_MS = 10_000;
// wait_until runs up to 60s and app launches can take tens of seconds — the
// proxy-side cap only exists so a dead daemon can't hang a call forever.
const CALL_TIMEOUT_MS = 130_000;

export class VersionMismatchError extends Error {
  constructor(
    readonly daemonVersion: string,
    readonly daemonPid: number,
    ownVersion: string
  ) {
    super(
      `Daemon (pid ${daemonPid}) runs react-native-mcp-kit v${daemonVersion}, this session runs v${ownVersion}. ` +
        `They ship in one package and must match. Close the sessions using the old version (the daemon exits on its own ~1min later), or kill pid ${daemonPid} — the next session respawns a fresh daemon.`
    );
  }
}

interface PendingRequest {
  reject: (err: Error) => void;
  resolve: (message: ProxyServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RemoteBackendEvents {
  down: [];
}

/**
 * Session-proxy side of the daemon connection: implements `FrontBackend` by
 * forwarding tools/list and tools/call over the proxy WebSocket. Emits `down`
 * when the socket drops so the proxy main loop can reconnect (respawning the
 * daemon if it died).
 */
export class RemoteBackend extends EventEmitter<RemoteBackendEvents> implements FrontBackend {
  private pending = new Map<string, PendingRequest>();
  private changedListeners = new Set<() => void>();

  static connect(port: number, ownVersion: string): Promise<RemoteBackend> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${PROXY_PATH}`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Daemon did not answer the proxy handshake in time.'));
      }, HELLO_TIMEOUT_MS);
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('message', (data) => {
        clearTimeout(timer);
        try {
          const hello = JSON.parse(String(data)) as ProxyServerMessage;
          if (hello.type !== 'proxy_hello') {
            ws.close();
            reject(new Error('Unexpected daemon greeting — not a react-native-mcp-kit daemon?'));
            return;
          }
          if (hello.packageVersion !== ownVersion) {
            ws.close();
            reject(new VersionMismatchError(hello.packageVersion, hello.pid, ownVersion));
            return;
          }
          resolve(new RemoteBackend(ws));
        } catch (err) {
          ws.close();
          reject(err as Error);
        }
      });
    });
  }

  private constructor(private readonly ws: WebSocket) {
    super();

    ws.on('message', (data) => {
      let message: ProxyServerMessage;
      try {
        message = JSON.parse(String(data)) as ProxyServerMessage;
      } catch {
        return;
      }
      if (message.type === 'tools_changed') {
        for (const listener of this.changedListeners) {
          listener();
        }
        return;
      }
      if (message.type === 'list_tools_result' || message.type === 'call_tool_result') {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    });

    ws.on('close', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Daemon connection lost.'));
        this.pending.delete(id);
      }
      this.emit('down');
    });

    ws.on('error', () => {
      // 'close' follows and does the bookkeeping.
    });
  }

  async listTools(): Promise<WireToolDescriptor[]> {
    const response = await this.request({ id: randomUUID(), type: 'list_tools' }, LIST_TIMEOUT_MS);
    return response.type === 'list_tools_result' ? response.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<WireCallResult> {
    const response = await this.request(
      { args, id: randomUUID(), name, type: 'call_tool' },
      CALL_TIMEOUT_MS
    );
    if (response.type !== 'call_tool_result') {
      return {
        content: [{ text: JSON.stringify({ error: 'Malformed daemon response.' }), type: 'text' }],
      };
    }
    return response.result;
  }

  onToolsChanged(listener: () => void): () => void {
    this.changedListeners.add(listener);
    return () => {
      this.changedListeners.delete(listener);
    };
  }

  close(): void {
    this.ws.close();
  }

  private request(
    message: { id: string } & Record<string, unknown>,
    timeoutMs: number
  ): Promise<ProxyServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`Daemon did not answer within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(message.id, { reject, resolve, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(message.id);
        reject(err as Error);
      }
    });
  }
}
