export interface HookMeta {
  kind: string;
  name: string;
  /**
   * For Custom-kind entries: reference to the custom-hook function. If that
   * function was also processed by the test-id-plugin (which runs on all
   * files including node_modules by default), it will have its own
   * `__mcp_hooks` array. At read time we recursively expand these so the
   * flattened metadata mirrors the real hook-slot sequence React allocated.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn?: any;
  /**
   * Source-level hook function name (`useState`, `useAnimatedStyle`, etc.).
   * Surfaced to the agent alongside `name` so it can disambiguate variables
   * holding the same kind from different hooks (e.g. `count (useState)` vs
   * `count (useReducer)`). Optional for forward-compatibility — entries
   * from older library bundles compiled before this field was added still
   * parse cleanly.
   */
  hook?: string;
  /**
   * Call-site identity in the same shape as JSX `data-mcp-id`:
   * `<name>:<shortFile>:<line>`. Lets an agent jump straight to the source
   * (e.g. `Read("hooks/useCart.ts", 42)`) without grepping. Absent on
   * entries from bundles compiled before this field was added.
   */
  mcpId?: string;
}

// Flattened entry adds the resolved `via` chain plus an `expanded` flag.
// `expanded: true` marks a parent custom-hook entry that we synthesised so
// the agent can see the call (`wrapperAnimStyle = useAnimatedStyle(...)`)
// alongside its sub-hooks; the slot-walker treats those as 0-slot, emitting
// without advancing the fiber chain.
export interface FlattenedHook extends HookMeta {
  via: string[];
  expanded?: boolean;
}

/**
 * Parsed select.hooks options used by `extractHooks`. Built from the
 * raw user-supplied object via `buildHooksOptions` in projection.ts.
 */
export interface HooksOptions {
  expansionDepth: number;
  format: 'flat' | 'tree';
  kindsSet: Set<string> | null;
  mcpIdMatchers: Array<(id: string) => boolean> | null;
  nameMatchers: Array<(n: string) => boolean> | null;
  withValues: boolean;
  // Projection of each hook value when withValues:true. depth/path/maxBytes
  // apply to the resolved hook value (e.g. useState's stored value, useRef's
  // .current). Without overrides — depth=1, no path, default maxBytes.
  valueDepth?: number;
  valueMaxBytes?: number;
  valuePath?: string;
}

/**
 * Raw shape of `select.hooks` from the agent's call. Normalised into
 * `HooksOptions` by `buildHooksOptions` in projection.ts before extraction
 * runs.
 */
export interface HooksRawOptions {
  depth?: number;
  expansionDepth?: number;
  format?: 'flat' | 'tree';
  kinds?: string[];
  maxBytes?: number;
  /**
   * Filter by hook call-site `mcpId`. Same exact / `/regex/flags` syntax as
   * `names`. Use the value emitted by the babel plugin
   * (`<name>:<shortFile>:<line>`) to target one specific call without
   * having to deal with name collisions or anonymous slots.
   */
  mcpIds?: string[];
  names?: string[];
  path?: string;
  withValues?: boolean;
}

export interface HookTreeNode {
  kind: string;
  name: string;
  children?: HookTreeNode[];
  hook?: string;
  mcpId?: string;
  value?: unknown;
}

export type FlatHookEntry = {
  kind: string;
  name: string;
  expanded?: boolean;
  hook?: string;
  mcpId?: string;
  value?: unknown;
  via?: string[];
};
