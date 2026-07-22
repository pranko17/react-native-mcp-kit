// Network mock engine. Everything applies at the XMLHttpRequest layer only:
// in React Native the fetch polyfill rides on XHR, so one interception point
// covers fetch and every other JS-side HTTP client, and every logical request
// consumes a matching mock exactly once. Mocks live in module memory —
// a JS reload wipes them, which is the intended failsafe against a forgotten
// mock silently gaslighting a human tester.

import {
  type JsonPatchOp,
  type MockMode,
  type MockPatchSpec,
  type MockResponseSpec,
} from './types';

export interface NetworkMock {
  createdAt: string;
  hits: number;
  id: number;
  mode: MockMode;
  /** Remaining allowed hits; null = unlimited. */
  remaining: number | null;
  url: string;
  bodyContains?: string;
  bodyMatch?: Record<string, unknown>;
  delayMs?: number;
  errorMessage?: string;
  method?: string;
  patch?: MockPatchSpec;
  response?: MockResponseSpec;
}

export interface MockConfig {
  mode: MockMode;
  url: string;
  bodyContains?: string;
  bodyMatch?: Record<string, unknown>;
  delayMs?: number;
  errorMessage?: string;
  method?: string;
  patch?: MockPatchSpec;
  response?: MockResponseSpec;
  times?: number;
}

/** Marker stashed on the XHR instance; the capture layer reads it into the entry. */
export interface XhrMockMark {
  id: number;
  mode: MockMode;
  patchError?: string;
  realStatus?: () => unknown;
}

const REGEX_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

const mocks: NetworkMock[] = [];
let nextMockId = 1;

/** Shared substring-or-/regex/ text matcher (url and bodyContains). */
const textMatches = (spec: string, text: string): boolean => {
  const literal = spec.match(REGEX_LITERAL);
  if (literal) {
    return new RegExp(literal[1]!, literal[2]).test(text);
  }
  return text.includes(spec);
};

export const setMock = (config: MockConfig): NetworkMock | { error: string } => {
  const literal = config.url.match(REGEX_LITERAL);
  if (literal) {
    try {
      new RegExp(literal[1]!, literal[2]);
    } catch (error) {
      return { error: `Invalid url regex: ${error instanceof Error ? error.message : error}` };
    }
  }
  const bodyContainsLiteral = config.bodyContains?.match(REGEX_LITERAL);
  if (bodyContainsLiteral) {
    try {
      new RegExp(bodyContainsLiteral[1]!, bodyContainsLiteral[2]);
    } catch (error) {
      return {
        error: `Invalid bodyContains regex: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
  for (const [path, expected] of Object.entries(config.bodyMatch ?? {})) {
    const spec = expected as { regex?: unknown } | null;
    if (spec !== null && typeof spec === 'object' && typeof spec.regex === 'string') {
      const literal = spec.regex.match(REGEX_LITERAL);
      try {
        if (literal) new RegExp(literal[1]!, literal[2]);
        else new RegExp(spec.regex);
      } catch (error) {
        return {
          error: `Invalid bodyMatch regex at "${path}": ${error instanceof Error ? error.message : error}`,
        };
      }
    }
  }
  if (config.mode === 'modify') {
    const patch = config.patch ?? {};
    const hasAny =
      patch.body !== undefined ||
      patch.bodyJsonPatch !== undefined ||
      patch.bodyMergePatch !== undefined ||
      patch.headers !== undefined ||
      patch.status !== undefined;
    if (!hasAny) {
      return {
        error:
          "mode 'modify' requires patch with at least one of: status, headers, body, bodyMergePatch, bodyJsonPatch",
      };
    }
  }
  const mock: NetworkMock = {
    bodyContains: config.bodyContains,
    bodyMatch: config.bodyMatch,
    createdAt: new Date().toISOString(),
    delayMs: config.delayMs,
    errorMessage: config.errorMessage,
    hits: 0,
    id: nextMockId++,
    method: config.method?.toUpperCase(),
    mode: config.mode,
    patch: config.patch,
    remaining: typeof config.times === 'number' ? config.times : null,
    response: config.response,
    url: config.url,
  };
  mocks.push(mock);
  return mock;
};

export const listMocks = (): NetworkMock[] => {
  return [...mocks];
};

export const removeMock = (id: number): boolean => {
  const index = mocks.findIndex((mock) => {
    return mock.id === id;
  });
  if (index === -1) return false;
  mocks.splice(index, 1);
  return true;
};

export const clearMocks = (): number => {
  const removed = mocks.length;
  mocks.length = 0;
  return removed;
};

/** Dot-path drill with [n] / [-1] bracket indices — mirrors predicate paths. */
const readPath = (value: unknown, path: string): unknown => {
  const normalized = path.replace(/\[(-?\d+)\]/g, '.$1').replace(/^\./, '');
  let current: unknown = value;
  for (const key of normalized.split('.')) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      if (key === 'length') {
        current = current.length;
        continue;
      }
      const idx = Number.parseInt(key, 10);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx < 0 ? current.length + idx : idx];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    return undefined;
  }
  return current;
};

/**
 * One bodyMatch entry: primitive → strict equality, { contains } /
 * { regex } for strings, anything else object-shaped → deep equality —
 * the same matcher vocabulary fiber_tree uses for props.
 */
const matchValue = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) return deepEqual(actual, expected);
  if (expected !== null && typeof expected === 'object') {
    const spec = expected as { contains?: unknown; regex?: unknown };
    if (typeof spec.contains === 'string') {
      return typeof actual === 'string' && actual.includes(spec.contains);
    }
    if (typeof spec.regex === 'string') {
      if (typeof actual !== 'string') return false;
      const literal = spec.regex.match(REGEX_LITERAL);
      const re = literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(spec.regex);
      return re.test(actual);
    }
    return deepEqual(actual, expected);
  }
  return actual === expected;
};

/**
 * Body-based matching. bodyContains runs substring-or-/regex/ over the raw
 * serialized body; bodyMatch drills dot-paths into the JSON-parsed body and
 * ANDs every entry. Both require a string body (FormData / binary payloads
 * never match), so a GET simply skips body-constrained mocks.
 */
const bodyMatchesSpec = (mock: NetworkMock, rawBody: unknown): boolean => {
  if (mock.bodyContains === undefined && mock.bodyMatch === undefined) return true;
  if (typeof rawBody !== 'string') return false;
  if (mock.bodyContains !== undefined && !textMatches(mock.bodyContains, rawBody)) return false;
  if (mock.bodyMatch !== undefined) {
    const parsed = tryParseJson(rawBody);
    if (parsed === null || typeof parsed !== 'object') return false;
    for (const [path, expected] of Object.entries(mock.bodyMatch)) {
      if (!matchValue(readPath(parsed, path), expected)) return false;
    }
  }
  return true;
};

/** First-match-wins over insertion order; a match consumes one `times` slot. */
export const consumeMatch = (method: string, url: string, body?: unknown): NetworkMock | null => {
  for (const mock of mocks) {
    if (mock.remaining !== null && mock.remaining <= 0) continue;
    if (mock.method && mock.method !== method.toUpperCase()) continue;
    if (!textMatches(mock.url, url)) continue;
    if (!bodyMatchesSpec(mock, body)) continue;
    mock.hits += 1;
    if (mock.remaining !== null) mock.remaining -= 1;
    return mock;
  }
  return null;
};

// RFC 6902 JSON Patch — the array-surgery counterpart to merge patch:
// remove/insert/replace by index (`/items/2`, `-` appends), plus move /
// copy / test. Ops apply sequentially on a clone; any failure (bad pointer,
// failed `test`, out-of-bounds index) throws — the caller decides whether
// to fall back to the unpatched value.

const parsePointer = (pointer: string): string[] => {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`invalid JSON Pointer "${pointer}" — must start with "/"`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => {
      return segment.replace(/~1/g, '/').replace(/~0/g, '~');
    });
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => {
    return deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
  });
};

const resolveContainer = (
  doc: unknown,
  segments: string[],
  pointer: string
): { container: Record<string, unknown> | unknown[]; key: string } => {
  let current: unknown = doc;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const idx = Number.parseInt(segment, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) {
        throw new Error(`"${pointer}": array index "${segment}" out of bounds`);
      }
      current = current[idx];
    } else if (current !== null && typeof current === 'object') {
      if (!(segment in (current as Record<string, unknown>))) {
        throw new Error(`"${pointer}": key "${segment}" not found`);
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`"${pointer}": segment "${segment}" points into a non-container`);
    }
  }
  const key = segments[segments.length - 1]!;
  if (current === null || typeof current !== 'object') {
    throw new Error(`"${pointer}": parent is not a container`);
  }
  return { container: current as Record<string, unknown> | unknown[], key };
};

const readAt = (doc: unknown, pointer: string): unknown => {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return doc;
  const { container, key } = resolveContainer(doc, segments, pointer);
  if (Array.isArray(container)) {
    const idx = Number.parseInt(key, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= container.length) {
      throw new Error(`"${pointer}": array index "${key}" out of bounds`);
    }
    return container[idx];
  }
  if (!(key in container)) throw new Error(`"${pointer}": key "${key}" not found`);
  return container[key];
};

const removeAt = (doc: unknown, pointer: string): unknown => {
  const segments = parsePointer(pointer);
  if (segments.length === 0) throw new Error('cannot remove the whole document');
  const { container, key } = resolveContainer(doc, segments, pointer);
  if (Array.isArray(container)) {
    const idx = Number.parseInt(key, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= container.length) {
      throw new Error(`"${pointer}": array index "${key}" out of bounds`);
    }
    const [removed] = container.splice(idx, 1);
    return removed;
  }
  if (!(key in container)) throw new Error(`"${pointer}": key "${key}" not found`);
  const removed = container[key];
  delete container[key];
  return removed;
};

const addAt = (doc: unknown, pointer: string, value: unknown): void => {
  const segments = parsePointer(pointer);
  if (segments.length === 0) throw new Error('cannot replace the whole document via add');
  const { container, key } = resolveContainer(doc, segments, pointer);
  if (Array.isArray(container)) {
    if (key === '-') {
      container.push(value);
      return;
    }
    const idx = Number.parseInt(key, 10);
    if (Number.isNaN(idx) || idx < 0 || idx > container.length) {
      throw new Error(`"${pointer}": array index "${key}" out of bounds`);
    }
    container.splice(idx, 0, value);
    return;
  }
  container[key] = value;
};

export const applyJsonPatch = (target: unknown, ops: JsonPatchOp[]): unknown => {
  // JSON round-trip clone: bodies arrive JSON-parsed, so this is lossless
  // here and avoids depending on structuredClone in the RN runtime.
  const doc: unknown = JSON.parse(JSON.stringify(target) ?? 'null');
  for (const [index, operation] of ops.entries()) {
    const label = `op #${index} (${operation.op})`;
    try {
      switch (operation.op) {
        case 'add':
          addAt(doc, operation.path, operation.value);
          break;
        case 'remove':
          removeAt(doc, operation.path);
          break;
        case 'replace':
          removeAt(doc, operation.path);
          addAt(doc, operation.path, operation.value);
          break;
        case 'move': {
          if (typeof operation.from !== 'string') throw new Error('missing "from"');
          const moved = removeAt(doc, operation.from);
          addAt(doc, operation.path, moved);
          break;
        }
        case 'copy': {
          if (typeof operation.from !== 'string') throw new Error('missing "from"');
          const copied = readAt(doc, operation.from);
          addAt(doc, operation.path, JSON.parse(JSON.stringify(copied) ?? 'null'));
          break;
        }
        case 'test':
          if (!deepEqual(readAt(doc, operation.path), operation.value)) {
            throw new Error(`test failed at "${operation.path}"`);
          }
          break;
        default:
          throw new Error(`unknown op "${(operation as { op: string }).op}"`);
      }
    } catch (error) {
      throw new Error(
        `json patch ${label}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return doc;
};

/** RFC 7396 JSON Merge Patch: objects merge recursively, null deletes a key. */
export const jsonMergePatch = (target: unknown, patch: unknown): unknown => {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }
  const base: Record<string, unknown> =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = jsonMergePatch(base[key], value);
    }
  }
  return base;
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyXhr = any;

/** Shadow prototype getters / own data props with an instance value. */
const defineOwn = (xhr: AnyXhr, prop: string, value: unknown): void => {
  Object.defineProperty(xhr, prop, { configurable: true, value, writable: true });
};

const findHeader = (headers: Record<string, string>, name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};

const serializeHeaders = (headers: Record<string, string>): string => {
  return Object.entries(headers)
    .map(([key, value]) => {
      return `${key}: ${value}`;
    })
    .join('\r\n');
};

const mergeHeaderBlob = (blob: string, patch: Record<string, string>): string => {
  const lines = blob.split('\r\n').filter(Boolean);
  const merged: Array<[string, string]> = [];
  for (const line of lines) {
    const [key, ...rest] = line.split(': ');
    if (!key) continue;
    const patched = findHeader(patch, key);
    merged.push([key, patched ?? rest.join(': ')]);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (
      !merged.some(([existing]) => {
        return existing.toLowerCase() === key.toLowerCase();
      })
    ) {
      merged.push([key, value]);
    }
  }
  return merged
    .map(([key, value]) => {
      return `${key}: ${value}`;
    })
    .join('\r\n');
};

/**
 * Dispatch an event through the XHR's own EventTarget so both
 * addEventListener listeners and `onX` attribute handlers fire in their
 * native order.
 *
 * Order matters: RN's EventTarget THROWS on a real
 * `new Event(...)` instance (it can't wrap the readonly `isTrusted`) but
 * happily dispatches a `{ type }` plain object to every listener — so the
 * plain object goes first. Spec-compliant EventTargets (jsdom & friends)
 * are the mirror image: they reject plain objects and need `new Event`.
 * The bare `onX` call is the last resort when both dispatches refuse —
 * it reaches the attribute handler but not addEventListener listeners.
 */
const fireEvent = (xhr: AnyXhr, type: string): void => {
  if (typeof xhr.dispatchEvent === 'function') {
    try {
      xhr.dispatchEvent({ type });
      return;
    } catch {
      // plain object rejected — try a real Event below
    }
    try {
      xhr.dispatchEvent(new Event(type));
      return;
    } catch {
      // fall through to direct handler call
    }
  }
  const handler = xhr[`on${type}`];
  if (typeof handler === 'function') handler.call(xhr, { type });
};

/**
 * Read a value through the prototype chain, bypassing instance shadows —
 * used by `modify` shadows to reach the real underlying value.
 */
const makeProtoReader = (xhr: AnyXhr, prop: string): (() => unknown) => {
  return () => {
    let proto = Object.getPrototypeOf(xhr);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc?.get) return desc.get.call(xhr);
      if (desc && 'value' in desc) return desc.value;
      proto = Object.getPrototypeOf(proto);
    }
    return undefined;
  };
};

/**
 * Shadow one terminal-value property. Two underlying layouts exist:
 * RN keeps `status` as an own data prop the runtime assigns into, while
 * `responseText` / `response` are prototype getters; other runtimes may use
 * either. Own props become accessors with a backing store (runtime writes
 * keep flowing in), prototype getters get an instance-level delegate.
 * Returns a reader for the real (unpatched) value.
 */
const shadowTerminal = (
  xhr: AnyXhr,
  prop: string,
  isDone: () => boolean,
  patchFn: (real: unknown) => unknown
): (() => unknown) => {
  if (Object.prototype.hasOwnProperty.call(xhr, prop)) {
    let backing = xhr[prop];
    Object.defineProperty(xhr, prop, {
      configurable: true,
      get: () => {
        return isDone() ? patchFn(backing) : backing;
      },
      set: (value: unknown) => {
        backing = value;
      },
    });
    return () => {
      return backing;
    };
  }
  const readReal = makeProtoReader(xhr, prop);
  Object.defineProperty(xhr, prop, {
    configurable: true,
    get: () => {
      return isDone() ? patchFn(readReal()) : readReal();
    },
  });
  return readReal;
};

/**
 * `modify` mode: let the real request run, patch what the app reads.
 * Shadows are installed before send and apply lazily once readyState hits
 * DONE — no dependence on event-listener registration order.
 */
const installModifyShadows = (xhr: AnyXhr, mock: NetworkMock): void => {
  const patch = mock.patch ?? {};
  const isDone = (): boolean => {
    return xhr.readyState === 4;
  };

  let readRealStatus: (() => unknown) | undefined;
  if (patch.status !== undefined) {
    readRealStatus = shadowTerminal(xhr, 'status', isDone, () => {
      return patch.status;
    });
  }

  const hasBodyPatch =
    patch.body !== undefined ||
    patch.bodyMergePatch !== undefined ||
    patch.bodyJsonPatch !== undefined;
  if (hasBodyPatch) {
    let memo: { value: unknown } | null = null;
    const patchedBody = (real: unknown): unknown => {
      if (!memo) {
        if (patch.body !== undefined) {
          memo = { value: patch.body };
        } else {
          let value = typeof real === 'string' ? tryParseJson(real) : real;
          if (patch.bodyMergePatch !== undefined) {
            value = jsonMergePatch(value, patch.bodyMergePatch);
          }
          if (patch.bodyJsonPatch !== undefined) {
            try {
              value = applyJsonPatch(value, patch.bodyJsonPatch);
            } catch (error) {
              // A failed op means the body shape didn't match the agent's
              // expectation — deliver the unpatched value and surface the
              // failure instead of guessing.
              const message = error instanceof Error ? error.message : String(error);
              (xhr.__mcp_mock as XhrMockMark).patchError = message;
              console.warn(`[mcp-kit] network mock #${mock.id}: ${message}`);
              value = typeof real === 'string' ? tryParseJson(real) : real;
            }
          }
          memo = { value };
        }
      }
      return memo.value;
    };
    shadowTerminal(xhr, 'responseText', isDone, (real) => {
      if (typeof real !== 'string') return real;
      const patched = patchedBody(real);
      return typeof patched === 'string' ? patched : (JSON.stringify(patched) ?? '');
    });
    shadowTerminal(xhr, 'response', isDone, (real) => {
      const responseType = xhr.responseType ?? '';
      if (responseType === '' || responseType === 'text') {
        if (typeof real !== 'string') return real;
        const patched = patchedBody(real);
        return typeof patched === 'string' ? patched : (JSON.stringify(patched) ?? '');
      }
      if (responseType === 'json') return patchedBody(real);
      return real;
    });
  }

  if (patch.headers !== undefined) {
    const patchHeaders = patch.headers;
    const realGetAll =
      typeof xhr.getAllResponseHeaders === 'function'
        ? xhr.getAllResponseHeaders.bind(xhr)
        : undefined;
    if (realGetAll) {
      xhr.getAllResponseHeaders = (): string => {
        const raw = realGetAll() ?? '';
        return isDone() ? mergeHeaderBlob(raw, patchHeaders) : raw;
      };
    }
    const realGetOne =
      typeof xhr.getResponseHeader === 'function' ? xhr.getResponseHeader.bind(xhr) : undefined;
    xhr.getResponseHeader = (name: string): string | null => {
      if (isDone()) {
        const patched = findHeader(patchHeaders, name);
        if (patched !== undefined) return patched;
      }
      return realGetOne ? realGetOne(name) : null;
    };
  }

  const mark: XhrMockMark = { id: mock.id, mode: mock.mode };
  if (readRealStatus) mark.realStatus = readRealStatus;
  xhr.__mcp_mock = mark;
};

/**
 * `replace` / `error` / `timeout` modes: never touch the network. The
 * response is synthesized on the instance and the standard event sequence
 * is fired after `delayMs`, so the module's own loadend recorder captures
 * the mocked values through the exact same path as real traffic.
 */
const shortCircuit = (xhr: AnyXhr, mock: NetworkMock): void => {
  const spec = mock.response ?? {};
  const status = mock.mode === 'replace' ? (spec.status ?? 200) : 0;
  const bodyRaw =
    mock.mode === 'replace'
      ? spec.body
      : mock.mode === 'error'
        ? (mock.errorMessage ?? 'Mocked network error')
        : undefined;
  const text =
    typeof bodyRaw === 'string'
      ? bodyRaw
      : bodyRaw === undefined || bodyRaw === null
        ? ''
        : (JSON.stringify(bodyRaw) ?? '');
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  if (
    mock.mode === 'replace' &&
    bodyRaw !== undefined &&
    typeof bodyRaw !== 'string' &&
    findHeader(headers, 'content-type') === undefined
  ) {
    headers['content-type'] = 'application/json';
  }

  xhr.__mcp_mock = { id: mock.id, mode: mock.mode } satisfies XhrMockMark;

  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    defineOwn(xhr, 'readyState', 4);
    defineOwn(xhr, 'status', status);
    if (mock.mode === 'replace') {
      defineOwn(xhr, 'statusText', spec.statusText ?? '');
      const responseType = xhr.responseType ?? '';
      const responseValue =
        responseType === 'json'
          ? typeof bodyRaw === 'string'
            ? tryParseJson(bodyRaw)
            : (bodyRaw ?? null)
          : text;
      defineOwn(xhr, 'response', responseValue);
      defineOwn(xhr, 'responseText', text);
      defineOwn(xhr, 'responseURL', xhr.__mcp_url ?? '');
      xhr.getAllResponseHeaders = (): string => {
        return serializeHeaders(headers);
      };
      xhr.getResponseHeader = (name: string): string | null => {
        return findHeader(headers, name) ?? null;
      };
    }
    fireEvent(xhr, 'readystatechange');
    if (mock.mode === 'replace') fireEvent(xhr, 'load');
    if (mock.mode === 'error') fireEvent(xhr, 'error');
    if (mock.mode === 'timeout') fireEvent(xhr, 'timeout');
    fireEvent(xhr, 'loadend');
    // Event delivery to addEventListener listeners is best-effort on RN (see
    // fireEvent) — invoke the capture layer's recorder directly so the
    // buffer entry always settles. The recorder is idempotent.
    if (typeof xhr.__mcp_record === 'function') xhr.__mcp_record();
  };

  const timer = setTimeout(settle, mock.delayMs ?? 0);
  xhr.abort = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    defineOwn(xhr, 'readyState', 4);
    defineOwn(xhr, 'status', 0);
    fireEvent(xhr, 'readystatechange');
    fireEvent(xhr, 'abort');
    fireEvent(xhr, 'loadend');
    if (typeof xhr.__mcp_record === 'function') xhr.__mcp_record();
  };
};

/**
 * Apply a matched mock to an XHR about to be sent. Returns true when the
 * real send should still run (`modify`), false when the request was
 * short-circuited (`replace` / `error` / `timeout`).
 */
export const applyMockToXhr = (xhr: AnyXhr, mock: NetworkMock): boolean => {
  if (mock.mode === 'modify') {
    installModifyShadows(xhr, mock);
    return true;
  }
  shortCircuit(xhr, mock);
  return false;
};
