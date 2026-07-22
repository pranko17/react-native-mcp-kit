export type HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';

/**
 * Captured request / response side of a network entry. Body is stored raw
 * (post JSON-parse + redact) when the captured size is below `bodyMaxBytes`;
 * otherwise it is replaced with a `${str}` marker carrying the original
 * size and a short preview. Either way `bodyBytes` reflects the original
 * captured size for stats.
 */
export interface NetworkRequestSide {
  headers: Record<string, string>;
  body?: unknown;
  bodyBytes?: number;
}

export interface NetworkResponseSide {
  headers: Record<string, string>;
  status: number;
  body?: unknown;
  bodyBytes?: number;
}

export type MockMode = 'error' | 'modify' | 'replace' | 'timeout';

/** Synthesized response for `replace` mode. */
export interface MockResponseSpec {
  body?: unknown;
  headers?: Record<string, string>;
  status?: number;
  statusText?: string;
}

/** One RFC 6902 JSON Patch operation. */
export interface JsonPatchOp {
  op: 'add' | 'copy' | 'move' | 'remove' | 'replace' | 'test';
  path: string;
  from?: string;
  value?: unknown;
}

/** Patch applied over the real response in `modify` mode. */
export interface MockPatchSpec {
  /** Full body replacement (string or JSON-serializable). */
  body?: unknown;
  /**
   * RFC 6902 JSON Patch ops over the real JSON body — array surgery by
   * index (`/items/2`, `-` appends), move / copy / test. Applied after
   * bodyMergePatch when both are given.
   */
  bodyJsonPatch?: JsonPatchOp[];
  /** RFC 7396 JSON Merge Patch over the real JSON body; null deletes a key. */
  bodyMergePatch?: Record<string, unknown>;
  /** Header overrides, merged case-insensitively over the real headers. */
  headers?: Record<string, string>;
  status?: number;
}

export interface NetworkEntry {
  duration: number | null;
  id: number;
  method: string;
  request: NetworkRequestSide;
  response: NetworkResponseSide | null;
  startedAt: string;
  status: 'error' | 'pending' | 'success';
  url: string;
  /** Present when a mock fired for this request; response fields reflect what the app saw. */
  mock?: {
    id: number;
    mode: MockMode;
    /** Real backend status before the patch (modify mode only). */
    originalStatus?: number;
    /** Set when a bodyJsonPatch op failed — the body was delivered unpatched. */
    patchError?: string;
  };
}

export interface NetworkModuleOptions {
  /**
   * Cap on stored body size (bytes). Bodies above this are replaced with a
   * `${str}` marker carrying len + preview. Default 20_000 (20KB) — protects
   * memory against megabyte feeds. Pass 0 to disable body capture entirely.
   */
  bodyMaxBytes?: number;
  /** Ignore URLs matching these patterns (e.g. WebSocket, Metro bundler) */
  ignoreUrls?: Array<string | RegExp>;
  /** Max entries in the buffer (default: 100) */
  maxEntries?: number;
  /**
   * Body keys (case-insensitive) to redact before storing. Recursively matches
   * nested objects. Default: ['password','token','accessToken','refreshToken',
   * 'apiKey','secret','otp','pin']. Pass false to disable.
   */
  redactBodyKeys?: ReadonlyArray<string | RegExp> | false;
  /**
   * Header names (case-insensitive) to replace with "[redacted]" before
   * storing. Default: ['authorization','cookie','set-cookie','x-api-key',
   * 'x-auth-token','x-access-token']. Pass false to disable.
   */
  redactHeaders?: ReadonlyArray<string | RegExp> | false;
}
