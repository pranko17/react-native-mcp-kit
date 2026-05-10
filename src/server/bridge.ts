import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

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

/**
 * Lifecycle events emitted by `Bridge`. The `McpServerWrapper` subscribes to
 * these to keep its top-level tool registry in sync with connected RN clients
 * and their `useMcpTool`-driven dynamic tools.
 *
 * Snapshots are captured before the corresponding mutation so subscribers can
 * diff or release deterministically (e.g. `clientReregistered` carries the
 * pre-mutation module list, `clientRemoved` carries the modules+dynamics that
 * existed at disconnect time).
 */
export interface BridgeEvents {
  bridgeStopping: [];
  clientAdded: [client: ClientEntry];
  clientRemoved: [
    clientId: string,
    modulesSnapshot: ModuleDescriptor[],
    dynamicSnapshot: Map<string, DynamicToolEntry>,
  ];
  clientReregistered: [client: ClientEntry, prevModules: ModuleDescriptor[]];
  dynamicToolAdded: [client: ClientEntry, fullName: string, entry: DynamicToolEntry];
  dynamicToolRemoved: [client: ClientEntry, fullName: string];
}

export class Bridge extends EventEmitter<BridgeEvents> {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientEntry>();
  private socketToClientId = new WeakMap<WebSocket, string>();
  private platformSequences = new Map<string, number>();
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(private readonly port: number) {
    super();
  }

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
          if (clientId) {
            const entry = this.clients.get(clientId);
            // Snapshot modules + dynamic tools BEFORE delete so subscribers
            // can release their per-tool refcounts. Empty arrays/maps if the
            // entry is missing — defensive, should not happen in practice.
            const modulesSnapshot = entry ? [...entry.modules] : [];
            const dynamicSnapshot = entry
              ? new Map(entry.dynamicTools)
              : new Map<string, DynamicToolEntry>();
            this.clients.delete(clientId);
            this.socketToClientId.delete(ws);
            this.rejectPendingForClient(clientId, `Client '${clientId}' disconnected`);
            this.emit('clientRemoved', clientId, modulesSnapshot, dynamicSnapshot);
          }
        });
      });

      this.wss.on('listening', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.emit('bridgeStopping');
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
            // Snapshot BEFORE mutation so subscribers can diff old vs new.
            const prevModules = [...existing.modules];
            existing.modules = message.modules;
            this.emit('clientReregistered', existing, prevModules);
          }
          break;
        }

        const id = this.nextClientId(message.platform);
        const entry: ClientEntry = {
          appName: message.appName,
          appVersion: message.appVersion,
          bundleId: message.bundleId,
          connectedAt: Date.now(),
          devServer: message.devServer,
          deviceId: message.deviceId,
          dynamicTools: new Map(),
          id,
          label: message.label,
          modules: message.modules,
          platform: message.platform,
          socket,
        };
        this.clients.set(id, entry);
        this.socketToClientId.set(socket, id);
        this.emit('clientAdded', entry);
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
          const entry: DynamicToolEntry = {
            description: message.tool.description,
            inputSchema: message.tool.inputSchema,
            module: message.module,
          };
          client.dynamicTools.set(fullName, entry);
          this.emit('dynamicToolAdded', client, fullName, entry);
        }
        break;
      }
      case 'tool_unregister': {
        const client = this.clientForSocket(socket);
        if (client) {
          const fullName = `${message.module}${MODULE_SEPARATOR}${message.toolName}`;
          if (client.dynamicTools.delete(fullName)) {
            this.emit('dynamicToolRemoved', client, fullName);
          }
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
