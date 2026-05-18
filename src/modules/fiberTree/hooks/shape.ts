// Recognise React's effect-record shape: `{ tag: number, create: function,
// deps: null | unknown[] }` with optional `inst` / `destroy` / `next`.
// useState / useReducer / useContext memoizedState values of this exact
// shape in real user code are astronomically unlikely, so we treat this as
// a reliable "definitely not a state slot" signal.
export const looksLikeEffectRecord = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.tag === 'number' &&
    typeof r.create === 'function' &&
    (r.deps === null || r.deps === undefined || Array.isArray(r.deps))
  );
};

// Recognise the useRef shape: `{ current: X }` with NO other keys. A useState
// value that is literally an object whose sole own-key is "current" is so
// improbable in real code that we treat it as a reliable "this slot is a
// ref, not a state" signal — lets State/Custom skip ref slots that leaked in
// through custom-hook internals.
const looksLikeRefShape = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const keys = Object.keys(raw as object);
  return keys.length === 1 && keys[0] === 'current';
};

// Shape-verify a hook slot's memoizedState against its expected kind. When
// a custom hook internally uses multiple built-in hooks, our static metadata
// understates the number of slots — every subsequent pairing drifts. By
// requiring a structural match before consuming a metadata entry we can
// swallow "internal" slots and keep the rest aligned. Permissive kinds
// (State / Reducer / Context / Custom) reject only obvious mis-matches
// (currently: the effect-record shape).
export const shapeMatchesKind = (raw: unknown, kind: string): boolean => {
  switch (kind) {
    case 'Ref':
      return !!raw && typeof raw === 'object' && 'current' in (raw as object);
    case 'Memo':
    case 'Callback':
      return Array.isArray(raw) && raw.length === 2 && (raw[1] === null || Array.isArray(raw[1]));
    case 'Effect':
    case 'LayoutEffect':
    case 'InsertionEffect':
      return looksLikeEffectRecord(raw);
    case 'Transition':
      return Array.isArray(raw) && raw.length === 2;
    case 'State':
    case 'Reducer':
    case 'Context':
    case 'Optimistic': // useOptimistic — state-like slot, internally a useReducer variant.
    case 'ActionState': // useActionState — [state, dispatch, isPending]; slot is state-like.
    case 'Use': // use(promise | context) — thenable-state or context-read slot, both state-like.
    case 'Custom':
      // Permissive but not blind — drop obvious effect-node and ref-shape
      // slots so State/Custom metadata doesn't swallow internals of
      // preceding custom hooks. React 19 hooks fall into this bucket
      // because their slot shape is state-like (not Effect/Memo/Ref).
      return !looksLikeEffectRecord(raw) && !looksLikeRefShape(raw);
    default:
      return true;
  }
};
