/**
 * `select` parser — converts the agent's raw select array into a strict
 * `Projection` object the query handler can read against. Recognises three
 * shapes per entry:
 *   - bare string         → include the named field with defaults
 *   - { field: true }     → same
 *   - { field: options }  → include with per-field options
 *
 * Heavy fields (`props`, `hooks`, `children`) take per-field option
 * objects; light fields (mcpId / name / testID / bounds / refMethods) just
 * toggle on. Validation of children's nested select happens inside
 * `parseChildrenOptions` so the error surfaces with the offending field
 * name.
 */

import { type ChildrenOptions, parseChildrenOptions } from './children';
import { buildHooksOptions, type HooksOptions, type HooksRawOptions } from './hooks';

export interface PropsOptions {
  depth?: number;
  maxBytes?: number;
  path?: string;
}

export interface Projection {
  children: ChildrenOptions | null;
  fields: Set<string>;
  hooks: HooksOptions;
  props: PropsOptions;
}

export const QUERY_DEFAULT_FIELDS = ['mcpId', 'name', 'testID'] as const;

/**
 * Parse the `select` arg into a flat Projection. Each element of `select`
 * may be either a string (include the named field with default options)
 * or an object whose keys are field names and whose values are
 * `true` / `false` / per-field projection options.
 *
 * Per-field options:
 *   props: { path?, depth?, maxBytes? }   — projection of the props object
 *   hooks: HooksRawOptions                — kinds/names filters + withValues
 *                                           + path/depth/maxBytes for hook
 *                                           values
 *   children: number | { treeDepth?, select?, itemsCap? }
 *                                         — recursive light-only walker; see
 *                                           parseChildrenSelect for limits.
 *
 * Heavy fields (props, hooks) are projected handler-side with these
 * per-field options so the rest of the response (mcpId, name, total, ...)
 * stays raw and always visible.
 */
export const parseProjection = (selectArg: unknown): Projection => {
  const fields = new Set<string>();
  let propsRaw: PropsOptions = {};
  let hooksRaw: HooksRawOptions | undefined;
  let childrenOpts: ChildrenOptions | null = null;

  if (Array.isArray(selectArg)) {
    for (const entry of selectArg) {
      if (typeof entry === 'string') {
        fields.add(entry);
        continue;
      }
      if (entry && typeof entry === 'object') {
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (value === false) continue;
          if (key === 'children') {
            childrenOpts = parseChildrenOptions(value);
            continue;
          }
          fields.add(key);
          if (key === 'props' && value && typeof value === 'object') {
            propsRaw = value as PropsOptions;
          } else if (key === 'hooks' && value && typeof value === 'object') {
            hooksRaw = value as HooksRawOptions;
          }
        }
      }
    }
  }

  if (fields.size === 0) {
    for (const f of QUERY_DEFAULT_FIELDS) fields.add(f);
  }

  return {
    children: childrenOpts,
    fields,
    hooks: buildHooksOptions(hooksRaw),
    props: propsRaw,
  };
};
