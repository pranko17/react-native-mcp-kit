import { compileRedact, matchesRedact, type RedactPatterns } from './redact';
import { resolvePath } from './resolvePath';

/**
 * Single canonical "render this value into a compact, agent-friendly JSON"
 * primitive. Replaces the per-module serializers (`fiberTree:serializeValue`,
 * `console:serializeArg`, `network:captureBody`).
 *
 * Behaviour:
 * - Walks the value to depth `depth` (default 1, max 8).
 * - Containers expanded inside the depth budget → raw JSON.
 * - Containers beyond depth, or specials (Date/Error/etc.) → string-keyed
 *   sentinel marker `{ "${kind}": meta }` (see plan §2 for full table).
 * - Wide containers are width-capped: 30 keys for objects, 50 items for
 *   arrays; the cut adds a `${truncated}` sentinel as the FIRST entry of
 *   the container.
 * - Long strings (> previewCap) become `{ "${str}": { "len": N, "preview": "..." } }`.
 * - Cycles → `{ "${cyc}": true }`.
 * - Pluggable `collapse` rules let modules detect domain-specific shapes
 *   (fiberTree component refs) and replace them with their own marker.
 * - Optional `path` — resolves the path inside `input` first; then projects
 *   the resolved subtree under the same rules. Path slice (`[N:M]`) overrides
 *   the default container width-cap for that specific level.
 */

export const DEFAULT_DEPTH = 1;
export const MAX_DEPTH = 8;
export const DEFAULT_OBJECT_CAP = 30;
export const DEFAULT_ARRAY_CAP = 50;
export const DEFAULT_PREVIEW_CAP = 50;
export const DEFAULT_MAX_BYTES = 50_000;

export type CollapseRule = (value: unknown) => Record<string, unknown> | undefined;

export interface ProjectOptions {
  collapse?: ReadonlyArray<CollapseRule>;
  depth?: number;
  maxBytes?: number;
  path?: string;
  previewCap?: number;
  redact?: RedactPatterns;
  skipKeys?: ReadonlyArray<string>;
}

export interface ProjectResult {
  bytes: number;
  truncated: boolean;
  value: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isMarker = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  return keys.length === 1 && keys[0]!.startsWith('${') && keys[0]!.endsWith('}');
};

const constructorName = (v: object): string | null => {
  const proto = Object.getPrototypeOf(v);
  if (!proto || proto === Object.prototype) return null;
  const ctor = (proto as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? null;
};

const projectString = (s: string, previewCap: number): unknown => {
  if (s.length <= previewCap) return s;
  return { ['${str}']: { len: s.length, preview: s.slice(0, previewCap) } };
};

const projectSpecial = (v: unknown, collapse: ReadonlyArray<CollapseRule>): unknown | undefined => {
  // built-ins first
  if (v instanceof Date) return { ['${Date}']: v.toISOString() };
  if (v instanceof RegExp) return { ['${RegExp}']: v.toString() };
  if (v instanceof Error) {
    return { ['${Err}']: { msg: v.message, name: v.name } };
  }
  if (v instanceof Map) return { ['${map}']: v.size };
  if (v instanceof Set) return { ['${set}']: v.size };
  if (typeof v === 'function') {
    const name = (v as { name?: string }).name;
    return { ['${fun}']: name && name.length > 0 ? name : '<anon>' };
  }
  if (typeof v === 'symbol') {
    return { ['${sym}']: v.toString() };
  }
  // pluggable collapse rules (fiberTree component refs etc.)
  for (const rule of collapse) {
    const out = rule(v);
    if (out !== undefined) return out;
  }
  return undefined;
};

const collapsedContainer = (v: unknown): Record<string, unknown> | undefined => {
  if (Array.isArray(v)) return { ['${arr}']: v.length };
  if (isPlainObject(v)) return { ['${obj}']: Object.keys(v).length };
  if (v && typeof v === 'object') {
    const cls = constructorName(v as object);
    if (cls) return { ['${cls}']: { len: Object.keys(v as object).length, name: cls } };
    return { ['${obj}']: Object.keys(v as object).length };
  }
  return undefined;
};

const walkContainer = (v: unknown, depth: number, ctx: WalkCtx, seen: WeakSet<object>): unknown => {
  // strings, primitives — handled before this fn is called
  // specials (Date, Error, ...) — handled before via projectSpecial
  if (Array.isArray(v)) {
    return walkArray(v, depth, ctx, seen);
  }
  return walkObject(v as Record<string, unknown>, depth, ctx, seen);
};

const walkArray = (arr: unknown[], depth: number, ctx: WalkCtx, seen: WeakSet<object>): unknown => {
  const total = arr.length;
  const cap = ctx.arrayCap;
  const sliced = arr.slice(0, cap);
  const out: unknown[] = [];
  if (total > cap) {
    out.push({ ['${truncated}']: { slice: [0, cap], total } });
  }
  for (const item of sliced) {
    out.push(walk(item, depth - 1, ctx, seen));
  }
  return out;
};

const walkObject = (
  obj: Record<string, unknown>,
  depth: number,
  ctx: WalkCtx,
  seen: WeakSet<object>
): unknown => {
  const allKeys = Object.keys(obj).filter((k) => {
    return !ctx.skipKeys.has(k);
  });
  const total = allKeys.length;
  const cap = ctx.objectCap;
  const keys = allKeys.slice(0, cap);
  const out: Record<string, unknown> = {};
  if (total > cap) {
    out['${truncated}'] = { slice: [0, cap], total };
  }
  for (const k of keys) {
    if (matchesRedact(k, ctx.compiledRedact)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = walk(obj[k], depth - 1, ctx, seen);
  }
  return out;
};

interface WalkCtx {
  arrayCap: number;
  collapse: ReadonlyArray<CollapseRule>;
  compiledRedact: ReturnType<typeof compileRedact>;
  objectCap: number;
  previewCap: number;
  skipKeys: Set<string>;
}

const walk = (v: unknown, remainingDepth: number, ctx: WalkCtx, seen: WeakSet<object>): unknown => {
  // primitives
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'bigint') return { ['${bigint}']: (v as bigint).toString() };
  if (t === 'string') return projectString(v as string, ctx.previewCap);

  // specials before container check (Map/Set/Date/etc. typeof === 'object')
  const special = projectSpecial(v, ctx.collapse);
  if (special !== undefined) return special;

  // cycle
  if (typeof v === 'object' && v !== null) {
    if (seen.has(v as object)) return { ['${cyc}']: true };
    seen.add(v as object);
  }

  // depth exhausted — collapse to marker
  if (remainingDepth <= 0) {
    const collapsed = collapsedContainer(v);
    return collapsed ?? v;
  }

  // expand container
  return walkContainer(v, remainingDepth, ctx, seen);
};

export const projectValue = (input: unknown, options?: ProjectOptions): ProjectResult => {
  const opts = options ?? {};
  const depth = clampDepth(opts.depth ?? DEFAULT_DEPTH);
  const objectCap = DEFAULT_OBJECT_CAP;
  const arrayCap = DEFAULT_ARRAY_CAP;
  const previewCap = opts.previewCap ?? DEFAULT_PREVIEW_CAP;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const collapse = opts.collapse ?? [];
  const skipKeys = new Set(opts.skipKeys ?? []);
  const compiledRedact = compileRedact(opts.redact);

  // resolve path first (if any) — applies to the input tree, not the projection
  let target: unknown = input;
  if (opts.path) {
    const res = resolvePath(input, opts.path);
    if (!res.ok) {
      return {
        bytes: 0,
        truncated: false,
        value: { error: res.error, validUpTo: res.validUpTo },
      };
    }
    target = res.value;
  }

  const ctx: WalkCtx = {
    arrayCap,
    collapse,
    compiledRedact,
    objectCap,
    previewCap,
    skipKeys,
  };

  const seen = new WeakSet<object>();
  // walk with depth + 1 because the caller's "depth: N" means N levels of
  // container expansion; our walk decrements before recursing into children.
  const projected = walk(target, depth, ctx, seen);

  // soft byte cap — if exceeded, replace with a string-marker that carries
  // the original size + a short preview
  const serialized = safeStringify(projected);
  if (serialized.length > maxBytes) {
    const preview = serialized.slice(0, Math.min(maxBytes, 200));
    return {
      bytes: serialized.length,
      truncated: true,
      value: {
        ['${str}']: {
          len: serialized.length,
          preview,
        },
      },
    };
  }
  return { bytes: serialized.length, truncated: false, value: projected };
};

const clampDepth = (d: number): number => {
  if (!Number.isFinite(d) || d < 0) return DEFAULT_DEPTH;
  return Math.min(Math.floor(d), MAX_DEPTH);
};

const safeStringify = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};

// Re-export marker detection for modules that may want to differentiate
// markers from raw user data (e.g. logging).
export { isMarker };
