export type HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';

export interface NetworkEntry {
  duration: number | null;
  method: string;
  request: {
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    headers: Record<string, string>;
    status: number;
    body?: unknown;
  } | null;
  startedAt: string;
  status: 'error' | 'pending' | 'success';
  url: string;
}

export interface NetworkModuleOptions {
  /** Ignore URLs matching these patterns (e.g. WebSocket, Metro bundler) */
  ignoreUrls?: Array<string | RegExp>;
  /** Include request/response bodies (default: true) */
  includeBodies?: boolean;
  /** Max entries in the buffer (default: 100) */
  maxEntries?: number;
}
