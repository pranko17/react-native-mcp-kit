import { randomUUID } from 'node:crypto';

import { WebSocketServer } from 'ws';
import { type WebSocket } from 'ws';

import {
  type ClientMessage,
  type DevServerInfo,
  MODULE_SEPARATOR,
  type ModuleDescriptor,
  PROTOCOL_VERSION,
  type ServerHelloMessage,
  type ToolRequest,
  type VersionMismatchMessage,
  WS_CLOSE_PROTOCOL_MISMATCH,
} from '@/shared/protocol';

const REQUEST_TIMEOUT = 10_000;
// When a client's WebSocket drops, we keep its ID slot reserved for this long
// so a reconnect from the same `(deviceId, bundleId, platform)` triple lands
// back on the same id (e.g. `ios-1`). 10 minutes covers the long tail —
// Metro fast-refresh bounces, app backgrounded during a coffee break,
// Xcode rebuild + relaunch, brief network blips, longer pauses while the
// agent thinks. Stale entries are still cheap (just a ClientEntry copy
// holding a dead socket reference), so a longer window costs little.
const RECONNECT_GRACE_MS = 10 * 60_000;

export interface DynamicToolEntry {
  description: string;
  module: string;
  inputSchema?: Record<string, unknown>;
}

export interface ClientEntry {
  readonly connectedAt: number;
  readonly dynamicTools: Map<string, DynamicToolEntry>;
  readonly id: string;
  modules: ModuleDescriptor[];
  readonly socket: WebSocket;
  readonly appName?: string;
  readonly appVersion?: string;
  readonly bundleId?: string;
  readonly devServer?: DevServerInfo;
  readonly deviceId?: string;
  readonly isSimulator?: boolean;
  readonly label?: string;
  readonly platform?: string;
}

export type ClientResolution = { client: ClientEntry; ok: true } | { error: string; ok: false };

interface PendingRequest {
  clientId: string;
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Identity facts we use to recognise the same physical client on reconnect.
// platform + deviceId + bundleId is unique enough in practice — two apps on
// one phone differ by bundleId, two phones differ by deviceId. label /
// appVersion / devServer can drift between sessions and aren't used to match.
interface DisconnectedClient {
  entry: ClientEntry;
  timer: ReturnType<typeof setTimeout>;
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientEntry>();
  private disconnectedClients = new Map<string, DisconnectedClient>();
  private socketToClientId = new WeakMap<WebSocket, string>();
  private platformSequences = new Map<string, number>();
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on('connection', (ws) => {
        // Greet the client with the protocol version so it can bail early if
        // incompatible instead of waiting for its registration to be rejected.
        const hello: ServerHelloMessage = {
          protocolVersion: PROTOCOL_VERSION,
          type: 'server_hello',
        };
        ws.send(JSON.stringify(hello));

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(String(data)) as ClientMessage;
            this.handleMessage(ws, message);
          } catch {
            // ignore malformed messages
          }
        });

        ws.on('close', () => {
          const clientId = this.socketToClientId.get(ws);
          if (!clientId) return;
          const entry = this.clients.get(clientId);
          this.clients.delete(clientId);
          this.socketToClientId.delete(ws);
          this.rejectPendingForClient(clientId, `Client '${clientId}' disconnected`);
          if (entry) {
            // Reserve the ID for a reconnect from the same identity. While the
            // ghost lives, the client is invisible to `listClients` /
            // `getClient` (so tools fail with "not connected"), but a
            // re-registering app matching this entry's `(platform, deviceId,
            // bundleId)` will pick the slot back up.
            const timer = setTimeout(() => {
              this.disconnectedClients.delete(clientId);
            }, RECONNECT_GRACE_MS);
            // Don't keep the event loop alive solely for ghost expiry.
            timer.unref?.();
            this.disconnectedClients.set(clientId, { entry, timer });
          }
        });
      });

      this.wss.on('listening', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.rejectAllPending('Server stopping');
    for (const ghost of this.disconnectedClients.values()) {
      clearTimeout(ghost.timer);
    }
    this.disconnectedClients.clear();
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

  async call(
    clientId: string,
    module: string,
    method: string,
    args: Record<string, unknown>,
    timeout?: number
  ): Promise<unknown> {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client '${clientId}' not connected`);
    }

    const id = randomUUID();
    const request: ToolRequest = {
      args,
      id,
      method,
      module,
      type: 'tool_request',
    };

    const timeoutMs = timeout ?? REQUEST_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${clientId} ${module}.${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { clientId, reject, resolve, timer });
      client.socket.send(JSON.stringify(request));
    });
  }

  isAnyClientConnected(): boolean {
    return this.clients.size > 0;
  }

  listClients(): ClientEntry[] {
    return [...this.clients.values()];
  }

  getClient(id: string): ClientEntry | undefined {
    return this.clients.get(id);
  }

  resolveClient(explicitId?: string): ClientResolution {
    if (explicitId) {
      const client = this.clients.get(explicitId);
      if (!client) {
        const available = [...this.clients.keys()].join(', ') || '(none)';
        return {
          error: `Client '${explicitId}' not connected. Available: ${available}`,
          ok: false,
        };
      }
      return { client, ok: true };
    }

    if (this.clients.size === 0) {
      return { error: 'No React Native clients connected', ok: false };
    }

    if (this.clients.size === 1) {
      const [client] = this.clients.values();
      return { client: client!, ok: true };
    }

    const labels = [...this.clients.values()]
      .map((c) => {
        return c.label ? `${c.id} (${c.label})` : c.id;
      })
      .join(', ');
    return {
      error: `Multiple clients connected: ${labels}. Specify clientId.`,
      ok: false,
    };
  }

  private handleMessage(socket: WebSocket, message: ClientMessage): void {
    switch (message.type) {
      case 'registration': {
        const clientVersion =
          typeof message.protocolVersion === 'number' ? message.protocolVersion : undefined;
        if (clientVersion !== PROTOCOL_VERSION) {
          const reason =
            clientVersion === undefined
              ? `Client did not send protocolVersion — upgrade the app's mcp-kit to one that speaks protocol v${PROTOCOL_VERSION}.`
              : `Client protocol v${clientVersion} does not match server v${PROTOCOL_VERSION}. Align mcp-kit versions across server and app.`;
          const reject: VersionMismatchMessage = {
            clientVersion,
            reason,
            serverVersion: PROTOCOL_VERSION,
            type: 'version_mismatch',
          };
          socket.send(JSON.stringify(reject));
          socket.close(WS_CLOSE_PROTOCOL_MISMATCH, reason);
          break;
        }

        const existingId = this.socketToClientId.get(socket);
        if (existingId) {
          // Re-registration on existing socket — just update the module list.
          // Identity metadata is fixed for the lifetime of the connection.
          const existing = this.clients.get(existingId);
          if (existing) {
            existing.modules = message.modules;
          }
          break;
        }

        // If a recently-disconnected client matches this registration's
        // identity triple, reuse its ID instead of allocating a fresh one —
        // keeps `ios-1` stable across Fast Refresh reloads / WS blips.
        const stickyId = this.findGhostMatch(message);
        let id: string;
        if (stickyId) {
          const ghost = this.disconnectedClients.get(stickyId)!;
          clearTimeout(ghost.timer);
          this.disconnectedClients.delete(stickyId);
          id = stickyId;
        } else {
          id = this.nextClientId(message.platform);
        }
        const entry: ClientEntry = {
          appName: message.appName,
          appVersion: message.appVersion,
          bundleId: message.bundleId,
          connectedAt: Date.now(),
          devServer: message.devServer,
          deviceId: message.deviceId,
          dynamicTools: new Map(),
          id,
          isSimulator: message.isSimulator,
          label: message.label,
          modules: message.modules,
          platform: message.platform,
          socket,
        };
        this.clients.set(id, entry);
        this.socketToClientId.set(socket, id);
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
      case 'tool_register': {
        const client = this.clientForSocket(socket);
        if (client) {
          const fullName = `${message.module}${MODULE_SEPARATOR}${message.tool.name}`;
          client.dynamicTools.set(fullName, {
            description: message.tool.description,
            inputSchema: message.tool.inputSchema,
            module: message.module,
          });
        }
        break;
      }
      case 'tool_unregister': {
        const client = this.clientForSocket(socket);
        if (client) {
          const fullName = `${message.module}${MODULE_SEPARATOR}${message.toolName}`;
          client.dynamicTools.delete(fullName);
        }
        break;
      }
    }
  }

  private clientForSocket(socket: WebSocket): ClientEntry | undefined {
    const id = this.socketToClientId.get(socket);
    if (!id) {
      return undefined;
    }
    return this.clients.get(id);
  }

  private nextClientId(platform?: string): string {
    const prefix = platform ?? 'client';
    const next = (this.platformSequences.get(prefix) ?? 0) + 1;
    this.platformSequences.set(prefix, next);
    return `${prefix}-${next}`;
  }

  // Look for a ghost ClientEntry whose identity triple (platform, deviceId,
  // bundleId) matches this incoming registration. All three must be present
  // and identical — partial matches are too risky (two apps on the same
  // device, two devices of the same model with no deviceId set, …).
  private findGhostMatch(message: {
    bundleId?: string;
    deviceId?: string;
    platform?: string;
  }): string | null {
    if (!message.deviceId || !message.bundleId || !message.platform) return null;
    for (const [id, ghost] of this.disconnectedClients) {
      if (
        ghost.entry.platform === message.platform &&
        ghost.entry.deviceId === message.deviceId &&
        ghost.entry.bundleId === message.bundleId
      ) {
        return id;
      }
    }
    return null;
  }

  private rejectPendingForClient(clientId: string, reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
        this.pendingRequests.delete(id);
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
