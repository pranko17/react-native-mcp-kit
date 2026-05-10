import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projectValue';
import {
  compileRedact,
  redactHeaders as redactHeadersMap,
  redactValue,
  type RedactPatterns,
} from '@/shared/redact';

import { type NetworkEntry, type NetworkModuleOptions } from './types';

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_BODY_MAX_BYTES = 20_000;
const DEFAULT_BODY_PREVIEW = 200;
const DEFAULT_IGNORE_URLS: ReadonlyArray<string | RegExp> = [
  /^ws:/,
  /^wss:/,
  /localhost:8081/,
  /symbolicate/,
];

const DEFAULT_REDACT_HEADERS: ReadonlyArray<string | RegExp> = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
];
const DEFAULT_REDACT_BODY_KEYS: ReadonlyArray<string | RegExp> = [
  'accessToken',
  'apiKey',
  'otp',
  'password',
  'pin',
  'refreshToken',
  'secret',
  'token',
];

// Network entries top-level shape: array of entries, each with nested
// request/response objects holding headers map + body. Default depth 3
// means: array (1) → entry (2) → request/response (3) expanded; headers map
// and body collapse to markers. Drill via `path` or bump `depth`.
const NETWORK_DEFAULT_DEPTH = 3;

const PROJECTION_SCHEMA = makeProjectionSchema(NETWORK_DEFAULT_DEPTH);

const shouldIgnore = (url: string, patterns: ReadonlyArray<string | RegExp>): boolean => {
  return patterns.some((pattern) => {
    if (typeof pattern === 'string') return url.includes(pattern);
    return pattern.test(url);
  });
};

const parseHeaders = (
  headers: Headers | Record<string, string> | undefined
): Record<string, string> => {
  if (!headers) return {};
  if (typeof headers.forEach === 'function') {
    const result: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return headers as Record<string, string>;
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const byteLengthOf = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

interface CapturedBody {
  body: unknown;
  bodyBytes: number;
}

/**
 * Capture a request / response body into the buffer. JSON-parses string
 * input, applies the body-key redactor, and either stores the raw value or,
 * if its serialized size exceeds `bodyMaxBytes`, replaces it with a
 * `${str}` marker that carries the original size + a short preview.
 *
 * The result is held in raw form (no `projectValue` walk) so query-time
 * `path`/`depth` can drill freely; projection happens at the handler exit.
 */
const captureBody = (
  raw: unknown,
  bodyMaxBytes: number,
  compiledBodyRedact: ReturnType<typeof compileRedact>
): CapturedBody | undefined => {
  if (raw === null || raw === undefined) return undefined;
  if (bodyMaxBytes <= 0) return undefined;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    parsed = tryParseJson(raw);
  }

  const redacted = redactValue(parsed, compiledBodyRedact);
  const bytes = byteLengthOf(redacted);

  if (bytes > bodyMaxBytes) {
    const previewStr =
      typeof redacted === 'string'
        ? redacted.slice(0, DEFAULT_BODY_PREVIEW)
        : (JSON.stringify(redacted) ?? '').slice(0, DEFAULT_BODY_PREVIEW);
    return {
      body: { ['${str}']: { len: bytes, preview: previewStr } },
      bodyBytes: bytes,
    };
  }
  return { body: redacted, bodyBytes: bytes };
};

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
};

// === Module-level capture state — auto-starts at import time. ===
//
// Rationale: without cold-start capture, any fetch / XHR issued before
// McpProvider mounts (analytics bootstrap, OAuth refresh, config fetch)
// is invisible to the agent. Installing patches at module-import time
// catches them. The factory below adopts the already-running buffer and
// applies caller options (maxEntries, redaction lists) forward.

const buffer: NetworkEntry[] = [];
let nextId = 1;
let maxEntries = DEFAULT_MAX_ENTRIES;
let bodyMaxBytes = DEFAULT_BODY_MAX_BYTES;
let ignoreUrls: ReadonlyArray<string | RegExp> = [...DEFAULT_IGNORE_URLS];
let compiledHeaderRedact = compileRedact(DEFAULT_REDACT_HEADERS);
let compiledBodyRedact = compileRedact(DEFAULT_REDACT_BODY_KEYS);

const addEntry = (base: Omit<NetworkEntry, 'id'>): NetworkEntry => {
  const entry: NetworkEntry = { ...base, id: nextId++ };
  buffer.push(entry);
  if (buffer.length > maxEntries) {
    buffer.splice(0, buffer.length - maxEntries);
  }
  return entry;
};

let patchesInstalled = false;
const installPatches = (): void => {
  if (patchesInstalled) return;
  patchesInstalled = true;

  // Intercept global fetch.
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = async (input: any, init?: any): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (shouldIgnore(url, ignoreUrls)) {
      return originalFetch(input, init);
    }

    const reqBody = captureBody(init?.body, bodyMaxBytes, compiledBodyRedact);
    const entry = addEntry({
      duration: null,
      method: method.toUpperCase(),
      request: {
        body: reqBody?.body,
        bodyBytes: reqBody?.bodyBytes,
        headers: redactHeadersMap(
          parseHeaders(init?.headers as Record<string, string>),
          compiledHeaderRedact
        ),
      },
      response: null,
      startedAt: new Date().toISOString(),
      status: 'pending',
      url,
    });

    const startTime = Date.now();

    try {
      const response = await originalFetch(input, init);
      entry.duration = Date.now() - startTime;
      entry.status = 'success';

      let resBody: CapturedBody | undefined;
      if (bodyMaxBytes > 0) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          resBody = captureBody(text, bodyMaxBytes, compiledBodyRedact);
        } catch {
          resBody = undefined;
        }
      }

      entry.response = {
        body: resBody?.body,
        bodyBytes: resBody?.bodyBytes,
        headers: redactHeadersMap(parseHeaders(response.headers), compiledHeaderRedact),
        status: response.status,
      };

      return response;
    } catch (error) {
      entry.duration = Date.now() - startTime;
      entry.status = 'error';
      const message = error instanceof Error ? error.message : String(error);
      entry.response = {
        body: message,
        bodyBytes: message.length,
        headers: {},
        status: 0,
      };
      throw error;
    }
  };

  // Intercept XMLHttpRequest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XHR = (global as any).XMLHttpRequest;
  if (!XHR) return;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetRequestHeader = XHR.prototype.setRequestHeader;

  XHR.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const urlStr = typeof url === 'string' ? url : url.toString();
    (this as unknown as Record<string, unknown>).__mcp_method = method;
    (this as unknown as Record<string, unknown>).__mcp_url = urlStr;
    (this as unknown as Record<string, unknown>).__mcp_headers = {};
    return originalOpen.apply(this, [method, url, ...rest] as unknown as Parameters<
      typeof originalOpen
    >);
  };

  XHR.prototype.setRequestHeader = function (name: string, value: string) {
    const headers = (this as unknown as Record<string, unknown>).__mcp_headers as Record<
      string,
      string
    >;
    if (headers) headers[name] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  XHR.prototype.send = function (body?: any) {
    const url = (this as unknown as Record<string, unknown>).__mcp_url as string;
    const method = (this as unknown as Record<string, unknown>).__mcp_method as string;
    const headers = (this as unknown as Record<string, unknown>).__mcp_headers as Record<
      string,
      string
    >;

    if (!url || shouldIgnore(url, ignoreUrls)) {
      return originalSend.call(this, body);
    }

    const reqBody = captureBody(body, bodyMaxBytes, compiledBodyRedact);
    const entry = addEntry({
      duration: null,
      method: (method ?? 'GET').toUpperCase(),
      request: {
        body: reqBody?.body,
        bodyBytes: reqBody?.bodyBytes,
        headers: redactHeadersMap(headers ?? {}, compiledHeaderRedact),
      },
      response: null,
      startedAt: new Date().toISOString(),
      status: 'pending',
      url,
    });

    const startTime = Date.now();

    this.addEventListener('loadend', () => {
      entry.duration = Date.now() - startTime;
      entry.status = this.status >= 200 && this.status < 400 ? 'success' : 'error';

      let resBody: CapturedBody | undefined;
      if (bodyMaxBytes > 0) {
        const responseType = this.responseType;
        if (responseType === '' || responseType === 'text') {
          try {
            resBody = captureBody(this.responseText, bodyMaxBytes, compiledBodyRedact);
          } catch {
            resBody = undefined;
          }
        } else if (responseType === 'json') {
          resBody = captureBody(this.response, bodyMaxBytes, compiledBodyRedact);
        } else {
          // blob | arraybuffer | document — don't serialize binary / DOM payloads.
          resBody = { body: `[${responseType}]`, bodyBytes: 0 };
        }
      }

      entry.response = {
        body: resBody?.body,
        bodyBytes: resBody?.bodyBytes,
        headers: redactHeadersMap(
          parseHeaders(
            this.getAllResponseHeaders?.()
              ?.split('\r\n')
              .filter(Boolean)
              .reduce((acc: Record<string, string>, line: string) => {
                const [key, ...rest] = line.split(': ');
                if (key) acc[key] = rest.join(': ');
                return acc;
              }, {})
          ),
          compiledHeaderRedact
        ),
        status: this.status,
      };
    });

    return originalSend.call(this, body);
  };
};

installPatches();

const project = (entries: NetworkEntry[], args: ProjectionArgs): unknown => {
  return applyProjection(entries, args, projectAsValue, NETWORK_DEFAULT_DEPTH);
};

const resolveRedactList = (
  override: RedactPatterns | undefined,
  defaults: ReadonlyArray<string | RegExp>
): ReturnType<typeof compileRedact> => {
  // override === false → disable; undefined → defaults; array → override list
  return compileRedact(override ?? defaults);
};

export const networkModule = (options?: NetworkModuleOptions): McpModule => {
  if (typeof options?.maxEntries === 'number') {
    maxEntries = options.maxEntries;
    if (buffer.length > maxEntries) {
      buffer.splice(0, buffer.length - maxEntries);
    }
  }
  if (typeof options?.bodyMaxBytes === 'number') {
    bodyMaxBytes = options.bodyMaxBytes;
  }
  if (Array.isArray(options?.ignoreUrls)) {
    ignoreUrls = [...DEFAULT_IGNORE_URLS, ...options.ignoreUrls];
  }
  if (options?.redactHeaders !== undefined) {
    compiledHeaderRedact = resolveRedactList(options.redactHeaders, DEFAULT_REDACT_HEADERS);
  }
  if (options?.redactBodyKeys !== undefined) {
    compiledBodyRedact = resolveRedactList(options.redactBodyKeys, DEFAULT_REDACT_BODY_KEYS);
  }

  return {
    description: `Intercepted fetch + XMLHttpRequest — method, URL, status, duration, headers, bodies.

Each entry carries a numeric \`id\`. Bodies are stored raw up to bodyMaxBytes
(default 20KB); larger payloads collapse at capture time to a \`\${str}\`
marker. Sensitive headers (Authorization, Cookie, Set-Cookie, X-Api-Key,
X-Auth-*) and body keys (password, token, accessToken, refreshToken,
apiKey, secret, otp, pin) are redacted at capture time. Capture starts at
module-import time so cold-start traffic is not lost.

Listing tools accept path / depth / maxBytes (default depth ${NETWORK_DEFAULT_DEPTH}). WebSocket /
Metro / symbolicate traffic is auto-ignored. Buffer size, body cap, and
redaction lists are configurable via networkModule options.`,
    name: 'network',
    tools: {
      clear_requests: {
        description: 'Clear the request buffer.',
        handler: () => {
          buffer.length = 0;
          return { success: true };
        },
      },
      get_requests: {
        description: 'All captured requests; filterable by method / status / URL substring.',
        handler: (args) => {
          let result = [...buffer];
          if (args.method) {
            const method = (args.method as string).toUpperCase();
            result = result.filter((e) => {
              return e.method === method;
            });
          }
          if (args.status) {
            result = result.filter((e) => {
              return e.status === (args.status as string);
            });
          }
          if (args.url) {
            const urlFilter = args.url as string;
            result = result.filter((e) => {
              return e.url.includes(urlFilter);
            });
          }
          return project(result, args as ProjectionArgs);
        },
        inputSchema: {
          ...PROJECTION_SCHEMA,
          method: {
            description: 'HTTP method filter.',
            examples: ['GET', 'POST', 'PUT', 'DELETE'],
            type: 'string',
          },
          status: {
            description: 'Status filter.',
            examples: ['pending', 'success', 'error'],
            type: 'string',
          },
          url: { description: 'URL substring filter.', type: 'string' },
        },
      },
      get_stats: {
        description:
          'Counts — total, by status, by method — plus duration percentiles (min / p50 / p95 / max) and total bytes stored.',
        handler: () => {
          const byMethod: Record<string, number> = {};
          const byStatus: Record<string, number> = { error: 0, pending: 0, success: 0 };
          let bytes = 0;
          const durations: number[] = [];

          for (const entry of buffer) {
            byMethod[entry.method] = (byMethod[entry.method] ?? 0) + 1;
            byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
            if (typeof entry.duration === 'number') durations.push(entry.duration);
            bytes += entry.request.bodyBytes ?? 0;
            bytes += entry.response?.bodyBytes ?? 0;
          }

          durations.sort((a, b) => {
            return a - b;
          });

          return {
            byMethod,
            byStatus,
            bytes,
            durationMs: {
              max: durations.length ? durations[durations.length - 1] : null,
              min: durations.length ? durations[0] : null,
              p50: percentile(durations, 50),
              p95: percentile(durations, 95),
            },
            total: buffer.length,
          };
        },
      },
    },
  };
};
