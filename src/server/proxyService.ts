import { type WebSocket } from 'ws';

import {
  type ProxyClientMessage,
  type ProxyHelloMessage,
  type ProxyServerMessage,
} from '@/shared/proxyProtocol';

import { type Bridge } from './bridge';
import { type DaemonCore } from './daemonCore';

/** How long the daemon outlives its last session proxy. Long enough to ride
 * out an editor restart, short enough that closing the last session doesn't
 * leave a stray process holding the port for hours. */
export const DAEMON_IDLE_TIMEOUT_MS = 60_000;

export interface ProxyServiceOptions {
  /** Called after the last proxy has been gone for the idle timeout. */
  onIdle: () => void;
  packageVersion: string;
  idleTimeoutMs?: number;
}

/**
 * Daemon-side counterpart of the session proxies: serves the shared tool
 * catalog over proxy WebSocket connections (routed here by the bridge via the
 * `proxyConnection` event) and owns the daemon's idle lifecycle — when the
 * last proxy disconnects and none returns within the timeout, `onIdle` fires
 * and the daemon shuts down.
 */
export class ProxyService {
  private connections = new Set<WebSocket>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number;
  private firstClientGate: Promise<void> | null = null;

  constructor(
    bridge: Bridge,
    private readonly core: DaemonCore,
    private readonly options: ProxyServiceOptions
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS;

    core.registry.on('changed', () => {
      this.broadcast({ type: 'tools_changed' });
    });

    bridge.on('proxyConnection', (socket) => {
      this.attach(socket);
    });

    // The daemon starts with zero proxies (its spawner hasn't connected yet) —
    // arm the timer so a daemon nobody ever connects to still cleans itself up.
    this.armIdleTimer();
  }

  proxyCount(): number {
    return this.connections.size;
  }

  private attach(socket: WebSocket): void {
    this.connections.add(socket);
    this.cancelIdleTimer();

    const hello: ProxyHelloMessage = {
      packageVersion: this.options.packageVersion,
      pid: process.pid,
      type: 'proxy_hello',
    };
    socket.send(JSON.stringify(hello));

    socket.on('message', (data) => {
      let message: ProxyClientMessage;
      try {
        message = JSON.parse(String(data)) as ProxyClientMessage;
      } catch {
        return;
      }
      void this.handleMessage(socket, message);
    });

    socket.on('close', () => {
      this.connections.delete(socket);
      if (this.connections.size === 0) {
        this.armIdleTimer();
      }
    });
  }

  private async handleMessage(socket: WebSocket, message: ProxyClientMessage): Promise<void> {
    switch (message.type) {
      case 'list_tools': {
        // Gate the first catalog on the initial client-connect window so an
        // already-running app lands its module tools in the session's very
        // first tools/list. One gate per daemon lifetime — later lists reuse
        // the settled promise and answer instantly.
        this.firstClientGate ??= this.core.waitForFirstClient(2000);
        await this.firstClientGate;
        this.send(socket, {
          id: message.id,
          tools: this.core.registry.list(),
          type: 'list_tools_result',
        });
        break;
      }
      case 'call_tool': {
        const result = await this.core.registry.call(message.name, message.args);
        this.send(socket, {
          id: message.id,
          result,
          type: 'call_tool_result',
        });
        break;
      }
    }
  }

  private send(socket: WebSocket, message: ProxyServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Socket died mid-response — its close handler does the bookkeeping.
    }
  }

  private broadcast(message: ProxyServerMessage): void {
    for (const socket of this.connections) {
      this.send(socket, message);
    }
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.connections.size === 0) {
        this.options.onIdle();
      }
    }, this.idleTimeoutMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
