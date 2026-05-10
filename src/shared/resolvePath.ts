/**
 * JS-style path parser/resolver. Path examples:
 *   foo.bar          — object key access
 *   foo[3]           — array index
 *   foo[1:5]         — array/object slice (Python-style)
 *   foo[3:]          — slice from 3 to end
 *   foo[:5]          — slice from start to 5
 *   foo["key.with.dots"]   — bracket-quoted object key
 *   foo['k']         — single-quoted also accepted
 *
 * Used by `projectValue` to navigate inside a response before applying
 * shape rendering. After a slice, chained access has special semantics:
 *   - array slice + `.key` → map (apply to every element)
 *   - array slice + `[N]`  → pick Nth element of the window
 *   - object slice + `.key` → take key from sub-object (no map)
 *   - object slice + `[N]` → Nth key in window (insertion order)
 */

export type PathSegment =
  | { kind: 'key'; name: string }
  | { index: number; kind: 'index' }
  | { kind: 'slice'; end?: number; start?: number };

export type PathResult =
  | { ok: true; value: unknown }
  | { actual: unknown; error: string; ok: false; validUpTo: string };

export const parsePath = (path: string): PathSegment[] => {
  const out: PathSegment[] = [];
  let i = 0;
  const n = path.length;
  while (i < n) {
    const ch = path[i];
    if (ch === '.') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      // bracket form — could be index, slice, or quoted key
      const closeIdx = findMatchingBracket(path, i);
      if (closeIdx === -1) throw new Error(`Unbalanced bracket at position ${i}`);
      const inner = path.slice(i + 1, closeIdx);
      out.push(parseBracketContents(inner));
      i = closeIdx + 1;
      continue;
    }
    // bare identifier — read until next `.` or `[`
    let j = i;
    while (j < n && path[j] !== '.' && path[j] !== '[') j += 1;
    const name = path.slice(i, j);
    if (name === '') throw new Error(`Empty key at position ${i}`);
    out.push({ kind: 'key', name });
    i = j;
  }
  return out;
};

const findMatchingBracket = (path: string, openIdx: number): number => {
  let inSingle = false;
  let inDouble = false;
  for (let i = openIdx + 1; i < path.length; i++) {
    const c = path[i];
    if (c === '\\' && i + 1 < path.length) {
      i += 1;
      continue;
    }
    if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inSingle && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === ']') return i;
  }
  return -1;
};

const parseBracketContents = (inner: string): PathSegment => {
  const trimmed = inner.trim();
  // quoted key
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const raw = trimmed.slice(1, -1);
    return { kind: 'key', name: unescape(raw) };
  }
  // slice — contains ':'
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    const startStr = parts[0] ?? '';
    const endStr = parts[1] ?? '';
    const start = startStr.trim() === '' ? undefined : Number(startStr);
    const end = endStr.trim() === '' ? undefined : Number(endStr);
    if ((start !== undefined && Number.isNaN(start)) || (end !== undefined && Number.isNaN(end))) {
      throw new Error(`Invalid slice "${inner}"`);
    }
    return { end, kind: 'slice', start };
  }
  // numeric index
  const idx = Number(trimmed);
  if (Number.isInteger(idx)) {
    return { index: idx, kind: 'index' };
  }
  // bare identifier inside brackets — treat as key
  return { kind: 'key', name: trimmed };
};

const unescape = (s: string): string => {
  return s.replace(/\\(.)/g, '$1');
};

/**
 * Walk a path through a value tree. Slice + chained access has the semantics
 * documented in this file's header. Returns either the resolved value or a
 * detailed failure pointing at where the path broke.
 */
export const resolvePath = (root: unknown, path: string): PathResult => {
  let segments: PathSegment[];
  try {
    segments = parsePath(path);
  } catch (e) {
    return {
      actual: root,
      error: `Invalid path: ${(e as Error).message}`,
      ok: false,
      validUpTo: '',
    };
  }
  let current: unknown = root;
  let validPath = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const stepResult = step(current, seg);
    if (!stepResult.ok) {
      return {
        actual: current,
        error: stepResult.error,
        ok: false,
        validUpTo: validPath,
      };
    }
    current = stepResult.value;
    validPath =
      validPath === ''
        ? segmentToString(seg)
        : `${validPath}${segmentSeparator(seg)}${segmentToString(seg)}`;
  }
  return { ok: true, value: current };
};

const segmentSeparator = (seg: PathSegment): string => {
  return seg.kind === 'key' ? '.' : '';
};

const segmentToString = (seg: PathSegment): string => {
  switch (seg.kind) {
    case 'key':
      return /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(seg.name) ? seg.name : `["${seg.name}"]`;
    case 'index':
      return `[${seg.index}]`;
    case 'slice':
      return `[${seg.start ?? ''}:${seg.end ?? ''}]`;
  }
};

interface StepOk {
  ok: true;
  value: unknown;
}
interface StepFail {
  error: string;
  ok: false;
}

const step = (current: unknown, seg: PathSegment): StepOk | StepFail => {
  if (seg.kind === 'key') return stepKey(current, seg.name);
  if (seg.kind === 'index') return stepIndex(current, seg.index);
  return stepSlice(current, seg);
};

const stepKey = (current: unknown, name: string): StepOk | StepFail => {
  if (Array.isArray(current)) {
    // map: apply .key to each element. Each element must be an object.
    const mapped = current.map((el) => {
      return el && typeof el === 'object' ? (el as Record<string, unknown>)[name] : undefined;
    });
    return { ok: true, value: mapped };
  }
  if (current && typeof current === 'object') {
    const rec = current as Record<string, unknown>;
    if (!(name in rec)) {
      return { error: `Key "${name}" not found`, ok: false };
    }
    return { ok: true, value: rec[name] };
  }
  return { error: `Cannot access key "${name}" on non-container`, ok: false };
};

const stepIndex = (current: unknown, index: number): StepOk | StepFail => {
  if (Array.isArray(current)) {
    const real = index < 0 ? current.length + index : index;
    if (real < 0 || real >= current.length) {
      return { error: `Array index ${index} out of bounds (length ${current.length})`, ok: false };
    }
    return { ok: true, value: current[real] };
  }
  if (current && typeof current === 'object') {
    // object indexing — Nth key in insertion order
    const keys = Object.keys(current as object);
    const real = index < 0 ? keys.length + index : index;
    if (real < 0 || real >= keys.length) {
      return { error: `Object index ${index} out of bounds (${keys.length} keys)`, ok: false };
    }
    return { ok: true, value: (current as Record<string, unknown>)[keys[real]!] };
  }
  return { error: `Cannot index non-container with [${index}]`, ok: false };
};

const stepSlice = (current: unknown, seg: PathSegment & { kind: 'slice' }): StepOk | StepFail => {
  const { end, start } = seg;
  if (Array.isArray(current)) {
    return { ok: true, value: current.slice(start, end) };
  }
  if (current && typeof current === 'object') {
    const entries = Object.entries(current as Record<string, unknown>);
    const sliced = entries.slice(start, end);
    return { ok: true, value: Object.fromEntries(sliced) };
  }
  return { error: 'Cannot slice non-container', ok: false };
};
