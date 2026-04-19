import { type McpModule } from '@/client/models/types';

import { type NetworkEntry, type NetworkModuleOptions } from './types';

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_IGNORE_URLS = [/^ws:/, /^wss:/, /localhost:8081/, /symbolicate/];

const shouldIgnore = (url: string, patterns: Array<string | RegExp>): boolean => {
  return patterns.some((pattern) => {
    if (typeof pattern === 'string') {
      return url.includes(pattern);
    }
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

const tryParseBody = (body: unknown): unknown => {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
};

export const networkModule = (options?: NetworkModuleOptions): McpModule => {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const includeBodies = options?.includeBodies ?? true;
  const ignoreUrls = [...DEFAULT_IGNORE_URLS, ...(options?.ignoreUrls ?? [])];
  const buffer: NetworkEntry[] = [];

  const addEntry = (entry: NetworkEntry) => {
    buffer.push(entry);
    if (buffer.length > maxEntries) {
      buffer.splice(0, buffer.length - maxEntries);
    }
  };

  // Intercept global fetch
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = async (input: any, init?: any): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (shouldIgnore(url, ignoreUrls)) {
      return originalFetch(input, init);
    }

    const entry: NetworkEntry = {
      duration: null,
      method: method.toUpperCase(),
      request: {
        body: includeBodies ? tryParseBody(init?.body) : undefined,
        headers: parseHeaders(init?.headers as Record<string, string>),
      },
      response: null,
      startedAt: new Date().toISOString(),
      status: 'pending',
      url,
    };

    addEntry(entry);
    const startTime = Date.now();

    try {
      const response = await originalFetch(input, init);
      entry.duration = Date.now() - startTime;
      entry.status = 'success';

      let responseBody: unknown;
      if (includeBodies) {
        try {
          const cloned = response.clone();
          responseBody = await cloned.json();
        } catch {
          try {
            const cloned = response.clone();
            responseBody = await cloned.text();
          } catch {
            responseBody = undefined;
          }
        }
      }

      entry.response = {
        body: responseBody,
        headers: parseHeaders(response.headers),
        status: response.status,
      };

      return response;
    } catch (error) {
      entry.duration = Date.now() - startTime;
      entry.status = 'error';
      entry.response = {
        body: error instanceof Error ? error.message : String(error),
        headers: {},
        status: 0,
      };
      throw error;
    }
  };

  // Intercept XMLHttpRequest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XHR = (global as any).XMLHttpRequest;
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
    if (headers) {
      headers[name] = value;
    }
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

    const entry: NetworkEntry = {
      duration: null,
      method: (method ?? 'GET').toUpperCase(),
      request: {
        body: includeBodies ? tryParseBody(body) : undefined,
        headers: headers ?? {},
      },
      response: null,
      startedAt: new Date().toISOString(),
      status: 'pending',
      url,
    };

    addEntry(entry);
    const startTime = Date.now();

    this.addEventListener('loadend', () => {
      entry.duration = Date.now() - startTime;
      entry.status = this.status >= 200 && this.status < 400 ? 'success' : 'error';

      let responseBody: unknown;
      if (includeBodies) {
        const responseType = this.responseType;
        if (responseType === '' || responseType === 'text') {
          try {
            responseBody = tryParseBody(this.responseText);
          } catch {
            responseBody = undefined;
          }
        } else if (responseType === 'json') {
          responseBody = this.response;
        } else {
          // blob | arraybuffer | document — don't serialize binary/DOM payloads
          responseBody = `[${responseType}]`;
        }
      }

      entry.response = {
        body: responseBody,
        headers: parseHeaders(
          this.getAllResponseHeaders?.()
            ?.split('\r\n')
            .filter(Boolean)
            .reduce((acc: Record<string, string>, line: string) => {
              const [key, ...rest] = line.split(': ');
              if (key) {
                acc[key] = rest.join(': ');
              }
              return acc;
            }, {})
        ),
        status: this.status,
      };
    });

    return originalSend.call(this, body);
  };

  return {
    description: `Intercepted fetch + XMLHttpRequest — method, URL, status, duration, headers, bodies.

WebSocket / Metro / symbolicate traffic is auto-ignored. Buffer size,
body capture, and custom ignore patterns are configurable via
networkModule options.`,
    name: 'network',
    tools: {
      clear_requests: {
        description: 'Clear the request buffer.',
        handler: () => {
          buffer.length = 0;
          return { success: true };
        },
      },
      get_errors: {
        description: 'Failed requests only (non-2xx or network errors).',
        handler: (args) => {
          let result = buffer.filter((e) => {
            return e.status === 'error';
          });
          if (args.limit) {
            result = result.slice(-(args.limit as number));
          }
          return result;
        },
        inputSchema: {
          limit: { description: 'Max entries to return.', type: 'number' },
        },
      },
      get_pending: {
        description: 'In-flight requests.',
        handler: () => {
          return buffer.filter((e) => {
            return e.status === 'pending';
          });
        },
      },
      get_request: {
        description: 'Requests whose URL contains the given substring.',
        handler: (args) => {
          const urlFilter = args.url as string;
          return buffer.filter((e) => {
            return e.url.includes(urlFilter);
          });
        },
        inputSchema: {
          url: { description: 'URL substring.', type: 'string' },
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
          if (args.limit) {
            result = result.slice(-(args.limit as number));
          }
          return result;
        },
        inputSchema: {
          limit: { description: 'Max entries to return.', type: 'number' },
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
        description: 'Counts — total, by status, by method.',
        handler: () => {
          const byMethod: Record<string, number> = {};
          const byStatus: Record<string, number> = { error: 0, pending: 0, success: 0 };

          for (const entry of buffer) {
            byMethod[entry.method] = (byMethod[entry.method] ?? 0) + 1;
            byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
          }

          return {
            byMethod,
            byStatus,
            total: buffer.length,
          };
        },
      },
    },
  };
};
