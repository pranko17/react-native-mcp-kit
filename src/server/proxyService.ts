import { type WebSocket } from 'ws';

import {
  type ProxyClientMessage,
  type ProxyHelloMessage,
  type ProxyServerMessage,
} from '@/shared/proxyProtocol';

import { type Bridge } from './bridge';
import { type DaemonCore } from './daemonCore';

/** How long the daemon outlives its last connection. Long enough to ride out
 * an editor restart / app reload, short enough that a fully-idle daemon doesn't
 * hold the port for hours. */
export const DAEMON_IDLE_TIMEOUT_MS = 60_000;

export interface ProxyServiceOptions {
  /** Called after the daemon has been fully idle (no proxies AND no app
   * clients) for the idle timeout. */
  onIdle: () => void;
  packageVersion: string;
  idleTimeoutMs?: number;
}

/**
 * Daemon-side counterpart of the session proxies: serves the shared tool
 * catalog over proxy WebSocket connections (routed here by the bridge via the
 * `proxyConnection` event) and owns the daemon's idle lifecycle.
 *
 * "Idle" means neither a session proxy NOR an app client is connected — a
 * daemon with a live app but no agent session stays up (so the next session
 * attaches instantly to a connected app with full sticky state, instead of
 * killing the app connection and forcing a reconnect to a fresh daemon).
 */
export class ProxyService {
  private connections = new Set<WebSocket>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number;
  private firstClientGate: Promise<void> | null = null;

  constructor(
    private readonly bridge: Bridge,
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

    // An app connecting/disconnecting also flips idle state — re-evaluate the
    // timer on both, not just on proxy churn.
    bridge.on('clientAdded', () => {
      this.reevaluateIdle();
    });
    bridge.on('clientRemoved', () => {
      this.reevaluateIdle();
    });

    // The daemon starts with nothing connected — arm so one nobody ever uses
    // still cleans itself up.
    this.reevaluateIdle();
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
      this.reevaluateIdle();
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

  private isIdle(): boolean {
    return this.connections.size === 0 && !this.bridge.isAnyClientConnected();
  }

  // Single source of truth for the idle timer: arm when fully idle, cancel
  // otherwise. Arming is a no-op if a countdown is already running, so a
  // second idle-keeping event doesn't reset the clock.
  private reevaluateIdle(): void {
    if (this.isIdle()) {
      this.armIdleTimer();
    } else {
      this.cancelIdleTimer();
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      // Re-check at fire time — a connection may have arrived without a
      // cancel racing through.
      if (this.isIdle()) {
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
