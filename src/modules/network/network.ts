import { z } from 'zod';

import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';
import {
  compileRedact,
  redactHeaders as redactHeadersMap,
  redactValue,
  type RedactPatterns,
} from '@/shared/projection/redact';

import {
  applyMockToXhr,
  clearMocks,
  consumeMatch,
  listMocks,
  removeMock,
  setMock,
  type XhrMockMark,
} from './mocks';
import {
  type MockMode,
  type MockPatchSpec,
  type MockResponseSpec,
  type NetworkEntry,
  type NetworkModuleOptions,
} from './types';

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

    // Recording must not depend on event delivery: RN's EventTarget refuses
    // synthetically dispatched events for addEventListener listeners (only
    // `onX` attribute handlers fire), so mock short-circuits invoke this
    // recorder directly via __mcp_record. Real requests reach it through
    // the native loadend dispatch. `recorded` keeps the two paths idempotent.
    let recorded = false;
    const recordResponse = () => {
      if (recorded) return;
      recorded = true;
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

      const mark = (this as unknown as Record<string, unknown>).__mcp_mock as
        XhrMockMark | undefined;
      if (mark) {
        const originalStatus = mark.realStatus ? Number(mark.realStatus()) : undefined;
        entry.mock = {
          id: mark.id,
          mode: mark.mode,
          ...(originalStatus !== undefined && !Number.isNaN(originalStatus)
            ? { originalStatus }
            : {}),
          ...(mark.patchError ? { patchError: mark.patchError } : {}),
        };
      }
    };
    this.addEventListener('loadend', recordResponse);
    (this as unknown as Record<string, unknown>).__mcp_record = recordResponse;

    const mock = consumeMatch(method ?? 'GET', url, body);
    if (mock) {
      console.info(`[mcp-kit] network mock #${mock.id} (${mock.mode}) → ${method} ${url}`);
      const proceed = applyMockToXhr(this, mock);
      if (!proceed) return;
    }

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

const statsHandler = (): unknown => {
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
X-Auth-Token, X-Access-Token) and body keys (password, token, accessToken, refreshToken,
apiKey, secret, otp, pin) are redacted at capture time. Capture starts at
module-import time so cold-start traffic is not lost.

Listing tools accept path / depth / maxBytes (default depth ${NETWORK_DEFAULT_DEPTH}). WebSocket /
Metro / symbolicate traffic is auto-ignored. Buffer size, body cap, and
redaction lists are configurable via networkModule options.

MOCKING — set_mock / list_mocks / remove_mock / clear_mocks. Modes:
\`replace\` (synthesize status/headers/body, request never leaves the app),
\`modify\` (real request runs; patch status/headers/body — bodyMergePatch is
RFC 7396: objects merge deep, null deletes a key; bodyJsonPatch is RFC 6902
for array surgery: remove/insert/replace by index, applied after the merge
patch), \`error\` (network failure), \`timeout\`. Matching: first-match-wins
by insertion order; url is
a substring or /regex/; optional method, times (consumed per hit),
bodyContains (substring or /regex/ over the raw request body) and
bodyMatch (dot-paths into the parsed JSON body — tells apart requests
that share a URL and differ only in the payload).
delayMs applies to replace/error/timeout. Mocks work at the XHR layer (RN
fetch rides on XHR, so both are covered), are volatile — a JS reload clears
them — and every affected buffer entry carries \`mock: { id, mode,
originalStatus? }\` so captured traffic never silently lies about being fake.
Mocked JSON stays in React Query caches after clear_mocks — invalidate via
the query module when a screen must drop mocked data.`,
    name: 'network',
    tools: {
      clear_mocks: {
        description: 'Remove all mocks. Returns how many were removed.',
        handler: () => {
          return { removed: clearMocks() };
        },
        inputSchema: z.looseObject({}),
      },
      clear_requests: {
        description: 'Clear the request buffer.',
        handler: () => {
          buffer.length = 0;
          return { success: true };
        },
        inputSchema: z.looseObject({}),
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
        inputSchema: z.looseObject({
          ...PROJECTION_SCHEMA,
          method: z
            .string()
            .describe('HTTP method filter.')
            .meta({ examples: ['GET', 'POST', 'PUT', 'DELETE'] })
            .optional(),
          status: z.enum(['pending', 'success', 'error']).describe('Status filter.').optional(),
          url: z.string().describe('URL substring filter.').optional(),
        }),
      },
      get_stats: {
        description:
          'Counts — total, by status, by method — plus duration percentiles (min / p50 / p95 / max) and total captured body bytes.',
        handler: () => {
          return statsHandler();
        },
        inputSchema: z.looseObject({}),
      },
      list_mocks: {
        description:
          'Active and exhausted mocks with hit counters. `active: false` means times ran out.',
        handler: () => {
          return listMocks().map((mock) => {
            return {
              active: mock.remaining === null || mock.remaining > 0,
              bodyContains: mock.bodyContains,
              bodyMatch: mock.bodyMatch,
              createdAt: mock.createdAt,
              delayMs: mock.delayMs,
              hits: mock.hits,
              id: mock.id,
              method: mock.method,
              mode: mock.mode,
              remaining: mock.remaining,
              url: mock.url,
            };
          });
        },
        inputSchema: z.looseObject({}),
      },
      remove_mock: {
        description: 'Remove one mock by id.',
        handler: (args) => {
          return { removed: removeMock(args.id as number) };
        },
        inputSchema: z.looseObject({
          id: z.number().int().describe('Mock id from set_mock / list_mocks.'),
        }),
      },
      set_mock: {
        description:
          'Register a network mock; returns its id. First matching mock wins. See the module description for modes and matching.',
        handler: (args) => {
          const result = setMock({
            bodyContains: args.bodyContains as string | undefined,
            bodyMatch: args.bodyMatch as Record<string, unknown> | undefined,
            delayMs: args.delayMs as number | undefined,
            errorMessage: args.errorMessage as string | undefined,
            method: args.method as string | undefined,
            mode: args.mode as MockMode,
            patch: args.patch as MockPatchSpec | undefined,
            response: args.response as MockResponseSpec | undefined,
            times: args.times as number | undefined,
            url: args.url as string,
          });
          if ('error' in result) return result;
          return {
            active: true,
            id: result.id,
            mode: result.mode,
            remaining: result.remaining,
            url: result.url,
          };
        },
        inputSchema: z.looseObject({
          bodyContains: z
            .string()
            .min(1)
            .describe(
              'Substring or /regex/ over the raw serialized request body. Body-constrained mocks never match bodyless requests.'
            )
            .optional(),
          bodyMatch: z
            .record(z.string(), z.unknown())
            .describe(
              'Field-level matching over the JSON-parsed request body: dot-path (with [0] / [-1] indices) → expected value. Primitive = strict equality; { contains } / { regex } for strings; objects/arrays deep-equal. All entries must match.'
            )
            .meta({ examples: [{ 'data.type': 'courier' }] })
            .optional(),
          delayMs: z
            .number()
            .min(0)
            .max(60_000)
            .describe('Delay before the mocked outcome fires (replace / error / timeout only).')
            .optional(),
          errorMessage: z
            .string()
            .describe("Message recorded for mode 'error'. Default: 'Mocked network error'.")
            .optional(),
          method: z
            .string()
            .describe('HTTP method filter; omit to match any.')
            .meta({ examples: ['GET', 'POST'] })
            .optional(),
          mode: z
            .enum(['error', 'modify', 'replace', 'timeout'])
            .describe(
              'replace: synthesize the whole response. modify: run the real request, patch it. error: network failure. timeout: never respond.'
            ),
          patch: z
            .looseObject({
              body: z.unknown().describe('Full body replacement.').optional(),
              bodyJsonPatch: z
                .array(
                  z.looseObject({
                    from: z.string().describe('Source pointer for move / copy.').optional(),
                    op: z.enum(['add', 'copy', 'move', 'remove', 'replace', 'test']),
                    path: z
                      .string()
                      .describe('RFC 6901 JSON Pointer, e.g. "/items/2"; "-" appends.'),
                    value: z.unknown().describe('Value for add / replace / test.').optional(),
                  })
                )
                .min(1)
                .describe(
                  'RFC 6902 ops over the real JSON body — array surgery by index. Applied sequentially (indices shift after each remove); runs after bodyMergePatch. On failure the body is delivered unpatched and the entry carries mock.patchError.'
                )
                .meta({
                  examples: [
                    [
                      { op: 'remove', path: '/items/2' },
                      { op: 'remove', path: '/items/0' },
                    ],
                  ],
                })
                .optional(),
              bodyMergePatch: z
                .record(z.string(), z.unknown())
                .describe('RFC 7396 merge patch over the real JSON body; null deletes a key.')
                .optional(),
              headers: z
                .record(z.string(), z.string())
                .describe('Header overrides (case-insensitive merge).')
                .optional(),
              status: z.number().int().describe('Status override.').optional(),
            })
            .describe("mode 'modify': what to change in the real response.")
            .optional(),
          response: z
            .looseObject({
              body: z.unknown().describe('String or JSON-serializable body.').optional(),
              headers: z.record(z.string(), z.string()).optional(),
              status: z.number().int().describe('Default 200.').optional(),
              statusText: z.string().optional(),
            })
            .describe("mode 'replace': the synthesized response.")
            .optional(),
          times: z
            .number()
            .int()
            .min(1)
            .describe('Max hits before the mock deactivates; omit for unlimited.')
            .optional(),
          url: z
            .string()
            .min(1)
            .describe('URL substring or /regex/ to match.')
            .meta({
              examples: ['/orders', '/\\/products\\/\\d+/'],
            }),
        }),
      },
    },
  };
};
