import { type RefObject } from 'react';

import { type McpModule } from '@/client/models/types';
import {
  applyProjection as applyProjectionCore,
  makeProjectionSchema,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';

import { walkChildren } from './children';
import {
  FIBER_DEFAULT_DEPTH,
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
  WAIT_INTERVAL_DEFAULT,
  WAIT_INTERVAL_MIN,
  WAIT_TIMEOUT_DEFAULT,
  WAIT_TIMEOUT_MAX,
} from './constants';
import { FIND_SCHEMA, findComponent, requireRoot } from './finder';
import { extractHooks } from './hooks';
import { type Projection, parseProjection, QUERY_DEFAULT_FIELDS } from './projection';
import {
  type FiberTreeNavigationRef,
  type QueryRuntime,
  type QueryStep,
  dedupAncestors,
  runQueryChain,
  validateSteps,
} from './query';
import { compileRedactPatterns, DEFAULT_REDACT_HOOK_NAMES } from './redact';
import { type Bounds, type Fiber } from './types';
import {
  getAvailableMethods,
  getComponentName,
  getFiberRoot,
  getNativeInstance,
  measureFiber,
  projectFiberValue,
  setRootRef,
} from './utils';
import { getVisibleRect, intersectsRect } from './viewport';
import { runWaitForLoop, type WaitForArgs } from './waitFor';

const PROJECTION_SCHEMA = makeProjectionSchema(FIBER_DEFAULT_DEPTH);

// Module-local 2-arg wrapper around the shared `applyProjection` so handlers
// don't have to repeat `projectFiberValue` + default-depth on every call.
const applyProjection = (result: unknown, args: ProjectionArgs): unknown => {
  return applyProjectionCore(result, args, projectFiberValue, FIBER_DEFAULT_DEPTH);
};

export interface FiberTreeModuleOptions {
  /**
   * Extend the default redact list with additional patterns. Strings are
   * matched as case-insensitive substrings (so `"password"` catches
   * `password`, `oldPassword`, `passwordHash`); RegExp values are matched
   * verbatim. Use this when you want defaults plus your own.
   */
  additionalRedactHookNames?: Array<string | RegExp>;
  navigationRef?: FiberTreeNavigationRef | null;
  /**
   * Replace the default redact list entirely. Names matching any pattern
   * have their `value` masked as `"[redacted]"` in `withValues: true`
   * responses. Strings = case-insensitive substring; RegExp = literal.
   * Default list (when this option is omitted) catches the common
   * security-sensitive names: `password`, `token`, `jwt`, `secret`,
   * `credential`, `apiKey`, `authorization`, plus `/Pin$/`. Pass `[]` to
   * disable redaction entirely.
   */
  redactHookNames?: Array<string | RegExp>;
  rootRef?: RefObject<unknown>;
}

export const fiberTreeModule = (options?: FiberTreeModuleOptions): McpModule => {
  if (options?.rootRef) {
    setRootRef(options.rootRef);
  }
  const navigationRef = options?.navigationRef;

  // Compile the redact pattern list once at module init. Precedence:
  //   - `redactHookNames` provided → use it verbatim (replace mode).
  //   - `additionalRedactHookNames` provided → defaults + user's.
  //   - Neither → defaults.
  // Pass `redactHookNames: []` to disable redaction entirely.
  const redactPatterns: RegExp[] = compileRedactPatterns(
    options?.redactHookNames !== undefined
      ? options.redactHookNames
      : [...DEFAULT_REDACT_HOOK_NAMES, ...(options?.additionalRedactHookNames ?? [])]
  );

  // Root-version keyed cache for `runQueryChain`. When React commits, the
  // HostRoot fiber swaps — so a mismatched pointer is proof the tree changed
  // and the cached match set for the same steps is no longer valid.
  // Enabled by default (cache: true); `cache: false` bypasses lookup + write.
  let cacheRoot: Fiber | null = null;
  const cacheEntries = new Map<string, Fiber[]>();

  const runCachedQuery = (runtime: QueryRuntime, steps: QueryStep[], useCache: boolean) => {
    if (!useCache) return runQueryChain(runtime, steps);
    if (cacheRoot !== runtime.root) {
      cacheRoot = runtime.root;
      cacheEntries.clear();
    }
    const key = JSON.stringify(steps);
    const hit = cacheEntries.get(key);
    if (hit) return hit;
    const result = runQueryChain(runtime, steps);
    cacheEntries.set(key, result);
    return result;
  };

  return {
    description: `React fiber tree inspection and interaction.

SCOPES (query steps)
  descendants (default) / children / parent / ancestors / siblings / self
  / root / screen / nearest_host.
    · root — the React fiber root, regardless of the previous step's
      match. Use as the first step to start from the top of the tree
      (e.g. dump the whole tree via select: [{ children: 5 }]).
    · screen — descendants of the currently focused React Navigation
      screen fiber. Available when the library was initialized with a
      navigationRef. Lets a first step skip "find current screen first".
    · nearest_host — walks down to the first mounted HOST_COMPONENT
      fiber. Useful before \`call({ method })\` (focus/blur/measure)
      which requires a host instance.

STEP CRITERIA
  name / mcpId / testID — strict equality.
  text — substring match in RENDERED text only (not prop values).
  hasProps — array of prop names that must exist.
  props — map of prop → matcher:
    · primitive → strict equality.
    · { contains: "X" } / { regex: "Y" } → match via String(value); primitives only by default.
    · add deep: true → also JSON-serialize objects/arrays and match inside.
  any — array of sub-criteria; OR semantics.
    Example: { any: [{ name: "Pressable" }, { name: "TouchableOpacity" }] }.
  not — nested criteria; excludes fibers that match the inner query.
    Composes with the others: { hasProps: ["onPress"], not: { testID: "loading" } }.
    Accepts an array for multi-pattern exclusion:
    { not: [{ name: "Pressable" }, { testID: "loading" }] }.
  index — pick N-th match from this step; otherwise all matches fan out into the next step.

SELECT (output fields)
  Default ["mcpId", "name", "testID"] — props, bounds, hooks,
  refMethods, children are opt-in.
  bounds: { x, y, width, height, centerX, centerY } in PHYSICAL pixels,
  top-left origin. null when the fiber has no mounted host view. centerX/
  centerY feed straight into host__tap.
  refMethods: list of native-ref method names (focus, blur, measure,
  scrollTo, ...) available on the fiber's host instance. null when
  there is no native instance (composite wrapper, unmounted,
  virtualized). Feeds directly into fiber_tree__call({ method }).
  props: per-field projection — \`{ props: { path?, depth?, maxBytes? } }\`.
  hooks: filtered + projected — \`{ hooks: { kinds?, names?, withValues?,
  expansionDepth?, format?, path?, depth?, maxBytes? } }\`. Each entry
  { kind, name, hook?, via?, expanded?, value? }.
  children: recursive light-only walker for tree-of-tree navigation —
  short form { children: 5 } (treeDepth=5) or object form
  { children: { treeDepth, select?, itemsCap? } }. select inside
  children may include only mcpId / name / testID / bounds / nested
  children — props/hooks throw at parse time. Use a second query against
  a child mcpId to inspect its props/hooks. treeDepth max 16, itemsCap
  default 50; overflow inserts a \`\${truncated}\` sentinel as the first
  array item.

RESPONSE
  { matches: [...], total, truncated? } — total is the unrestricted match
  count; when the result exceeds limit (default 50, max 500) truncated:
  true is added and matches contains the first limit items in DFS order.
  Narrow the query rather than cranking limit.

  By default wrapper cascades are deduped: a fiber is hidden when any of
  its ancestors is also a match, so PressableView → Pressable → View →
  RCTView collapses to the topmost PressableView. Independent siblings
  are kept. Pass dedup: false to see every layer.

TIPS
  mcpId format "ComponentName:file:line" — stable across renders.
  Use query to locate, then call({ prop } or { method }) (bypasses gesture
  pipeline) or host__tap with bounds (real OS touch) to act. For one-shot
  real taps, tap_fiber collapses both steps into a single call.
  When stepping up via scope: "ancestors", prefer filtering by name (or
  testID/mcpId) over guessing an index — ancestors count is brittle and
  varies across RN versions.
  \`text\` matches RENDERED text only — Text children content, not prop
  values. To match "placeholder: Search" use \`props: { placeholder:
  { contains: "Search" } }\`.`,
    name: 'fiber_tree',
    tools: {
      call: {
        description:
          "Imperative action on a fiber — invoke a prop callback OR a native-ref method. Pass `prop: 'onPress'` to call a callback prop, or `method: 'focus'` to call a method on the host instance's native ref. For simulating user taps, prefer `host__tap_fiber` — it goes through the real OS gesture pipeline so Pressable feedback / gesture responders / hit-test all behave as under a real finger. `call` is for non-gesture callbacks, off-screen / virtualised components, or imperative ref methods (focus / blur / measure / scrollTo / ...). Use `query` with `select: ['refMethods']` first to see what methods are available on a fiber.",
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          const propName = typeof args.prop === 'string' ? args.prop : undefined;
          const methodName = typeof args.method === 'string' ? args.method : undefined;

          if ((propName && methodName) || (!propName && !methodName)) {
            return {
              error:
                'call requires exactly one of `prop` (callback name) or `method` (ref method name).',
            };
          }

          const callArgs = (args.args as unknown[] | undefined) ?? [];

          // Prop-callback path: read prop from memoizedProps, call directly.
          if (propName) {
            const callback = fiber.memoizedProps?.[propName];
            if (typeof callback !== 'function') {
              const availableProps = Object.keys(fiber.memoizedProps ?? {}).filter((key) => {
                return typeof fiber.memoizedProps[key] === 'function';
              });
              return {
                availableProps,
                error: `Component "${getComponentName(fiber)}" has no "${propName}" callback prop`,
              };
            }
            const result = callback(...callArgs);
            return applyProjection(
              { component: getComponentName(fiber), prop: propName, result, success: true },
              args as ProjectionArgs
            );
          }

          // Ref-method path: resolve native instance, call method on it.
          const instance = getNativeInstance(fiber);
          if (!instance) {
            return { error: `Component "${getComponentName(fiber)}" has no native instance` };
          }
          const method = (instance as Record<string, unknown>)[methodName!];
          if (typeof method !== 'function') {
            return {
              availableMethods: getAvailableMethods(instance),
              error: `No method "${methodName}" on native instance of "${getComponentName(fiber)}"`,
            };
          }
          try {
            const bound = (method as (...a: unknown[]) => unknown).bind(instance);
            const result = bound(...callArgs);
            return applyProjection(
              { component: getComponentName(fiber), method: methodName, result, success: true },
              args as ProjectionArgs
            );
          } catch (e) {
            return {
              error: `Method "${methodName}" threw: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        },
        inputSchema: {
          ...FIND_SCHEMA,
          ...PROJECTION_SCHEMA,
          args: {
            description: 'Arguments passed to the callback / method.',
            examples: [[true], ['text']],
            type: 'array',
          },
          method: {
            description: 'Native-ref method name. Mutually exclusive with `prop`.',
            examples: ['focus', 'blur', 'measure', 'scrollTo'],
            type: 'string',
          },
          prop: {
            description: 'Callback prop name. Mutually exclusive with `method`.',
            examples: ['onPress', 'onSkip', 'onChangeText'],
            type: 'string',
          },
        },
      },
      query: {
        description:
          'Chain-based fiber search. Each step narrows the result set via `scope` + criteria; multiple matches fan out into the next step. Returns { matches, total, truncated? }. Pass `waitFor` to poll until an element appears or disappears (optionally requiring stability for N ms) instead of a single-shot read. See the module description for scope, criteria, select and response reference.',
        handler: async (args) => {
          const inner = async (): Promise<unknown> => {
            const rootError = requireRoot();
            if (rootError) return rootError;
            const root = getFiberRoot()!;

            const steps = args.steps as QueryStep[] | undefined;
            if (!Array.isArray(steps) || steps.length === 0) {
              return { error: 'query requires a non-empty `steps` array' };
            }
            const stepError = validateSteps(steps);
            if (stepError) return { error: stepError };

            const limit =
              typeof args.limit === 'number' && args.limit > 0
                ? Math.min(Math.floor(args.limit), QUERY_LIMIT_MAX)
                : QUERY_LIMIT_DEFAULT;
            const dedup = args.dedup !== false;
            const useCacheDefault = args.cache !== false;
            const onlyVisible = args.onlyVisible === true;
            let projection: Projection;
            try {
              projection = parseProjection(args.select);
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) };
            }
            const {
              children: childrenOpts,
              fields,
              hooks: hookOpts,
              props: propsOpts,
            } = projection;

            const runtime: QueryRuntime = { navigationRef, root };

            const runOnce = async (
              useCache: boolean
            ): Promise<{ matches: Record<string, unknown>[]; total: number; truncated?: true }> => {
              const rawMatches = runCachedQuery(runtime, steps, useCache);
              let all = dedup ? dedupAncestors(rawMatches) : rawMatches;

              const boundsCache = new Map<Fiber, Bounds | null>();
              const measure = async (fiber: Fiber): Promise<Bounds | null> => {
                if (boundsCache.has(fiber)) return boundsCache.get(fiber) ?? null;
                const b = await measureFiber(fiber);
                boundsCache.set(fiber, b);
                return b;
              };

              if (onlyVisible) {
                const visibleRect = getVisibleRect();
                if (visibleRect) {
                  const rect = visibleRect;
                  const measured = await Promise.all(
                    all.map(async (fiber) => {
                      return { bounds: await measure(fiber), fiber };
                    })
                  );
                  all = measured
                    .filter(({ bounds }) => {
                      return bounds && intersectsRect(bounds, rect);
                    })
                    .map(({ fiber }) => {
                      return fiber;
                    });
                }
              }

              const total = all.length;
              const truncated = total > limit;
              const picked = truncated ? all.slice(0, limit) : all;

              const matches = await Promise.all(
                picked.map(async (fiber) => {
                  const result: Record<string, unknown> = {};
                  if (fields.has('bounds')) {
                    result.bounds = await measure(fiber);
                  }
                  if (fields.has('mcpId')) {
                    result.mcpId = fiber.memoizedProps?.['data-mcp-id'];
                  }
                  if (fields.has('name')) {
                    result.name = getComponentName(fiber);
                  }
                  if (fields.has('props')) {
                    // Heavy field — projected here via select.props options
                    // (path/depth/maxBytes). Top-level response stays raw
                    // so mcpId/name/etc are always visible without
                    // projection.
                    result.props = projectFiberValue(fiber.memoizedProps ?? {}, {
                      depth: propsOpts.depth ?? 1,
                      maxBytes: propsOpts.maxBytes,
                      path: propsOpts.path,
                    });
                  }
                  if (fields.has('refMethods')) {
                    // List of native-ref methods available on the fiber's
                    // host instance (focus, blur, measure, scrollTo, ...).
                    // null when the fiber has no native instance (composite
                    // wrappers, unmounted, virtualized). Feeds directly into
                    // `fiber_tree__call({ method })`.
                    const instance = getNativeInstance(fiber);
                    result.refMethods = instance ? getAvailableMethods(instance) : null;
                  }
                  if (fields.has('testID')) {
                    result.testID = fiber.memoizedProps?.testID;
                  }
                  if (fields.has('hooks')) {
                    result.hooks = extractHooks(fiber, {
                      ...hookOpts,
                      redactPatterns,
                    });
                  }
                  if (childrenOpts) {
                    result.children = await walkChildren(
                      fiber,
                      childrenOpts,
                      childrenOpts.treeDepth,
                      measure
                    );
                  }
                  return result;
                })
              );

              return truncated ? { matches, total, truncated: true } : { matches, total };
            };

            const waitForRaw = args.waitFor as WaitForArgs | undefined;
            if (!waitForRaw || typeof waitForRaw !== 'object') {
              return runOnce(useCacheDefault);
            }
            // Cache is always bypassed inside the polling loop — `runOnce`
            // with cache:true would just keep returning the stale match
            // set the cache captured pre-mount.
            return runWaitForLoop(waitForRaw, () => {
              return runOnce(false);
            });
          };
          // No top-level projection on the query response — the response
          // shell ({ matches, total, ... }) is light by construction;
          // heavy values inside `props` / `hooks` are already collapsed to
          // markers by per-field projection in `inner`, and the
          // `select.children` walker self-bounds via treeDepth/itemsCap.
          // Top-level path/depth/maxBytes are not exposed on `query` —
          // drill happens via `select.props.path` / `select.hooks.path`,
          // and tree-shape navigation via `select.children`.
          return inner();
        },
        inputSchema: {
          cache: {
            default: true,
            description:
              'Reuse the match set when the React tree has not committed since the previous identical steps — detected via fiber root pointer equality. Pass false to force a fresh traversal.',
            type: 'boolean',
          },
          dedup: {
            default: true,
            description:
              'Drop wrapper cascades — a fiber is removed when any of its ancestors is also in the match set (PressableView → Pressable → View → RCTView collapses to the topmost). Independent siblings with overlapping bounds are kept. Pass false to keep every match.',
            type: 'boolean',
          },
          limit: {
            default: QUERY_LIMIT_DEFAULT,
            description:
              'Max matches to return. truncated: true is added when total exceeds limit.',
            maximum: QUERY_LIMIT_MAX,
            minimum: 1,
            type: 'number',
          },
          onlyVisible: {
            default: false,
            description:
              'Drop matches whose measured bounds do not intersect the current window rectangle (physical pixels). Also drops fibers with no measurable host view — usually virtualized or unmounted. Halves results on long lists.',
            type: 'boolean',
          },
          select: {
            description: `Output fields: mcpId, name, testID, props, bounds, hooks, refMethods, children. Default ${JSON.stringify(QUERY_DEFAULT_FIELDS)}. Each entry is either a string ("mcpId" — include with defaults) or an object whose keys are field names. Object values are \`true\` / \`false\` / per-field options.\n\nLight fields (mcpId, name, testID, bounds, refMethods) — no options, just toggle. refMethods is the list of native-ref methods (focus, blur, measure, scrollTo, ...) available on the fiber's host instance; null when the fiber has no native instance. Feeds directly into \`fiber_tree__call({ method })\`.\n\nHeavy fields (props, hooks) — per-field projection via shared \`projectValue\` so nested heavy values become \`\${...}\`-keyed markers. Each takes its own \`path\` / \`depth\` / \`maxBytes\`.\n\nprops options: \`{ path?, depth?, maxBytes? }\`.\n\nhooks options: \`{ kinds?, names?, withValues?, expansionDepth?, format?, path?, depth?, maxBytes? }\`. \`kinds\`: State | Reducer | Memo | Callback | Ref | Effect | LayoutEffect | InsertionEffect | Context | Transition | DeferredValue | Id | SyncExternalStore | ImperativeHandle | Custom. \`names\`: exact or \`/regex/flags\`. \`withValues:true\` adds resolved values. \`expansionDepth\` caps custom-hook recursion (default Infinity). \`format:"tree"\` returns nested children instead of flat \`via\`.\n\nchildren — recursive light-only walker for tree-of-tree dumps.\n  Short form: \`{ children: 5 }\` → treeDepth=5, default fields ['mcpId','name'].\n  Object form: \`{ children: { treeDepth?, select?, itemsCap? } }\`.\n  treeDepth max 16; itemsCap default 50; overflow inserts \`\${truncated}\` as the first item.\n  select inside children may include only mcpId / name / testID / bounds / nested children. props/hooks throw at parse time — run a second query against a child's mcpId to inspect them.\n\nEach hook entry carries \`{ kind, name, hook?, via?, expanded? }\`.`,
            examples: [
              ['mcpId', 'name', 'bounds'],
              ['mcpId', 'refMethods'],
              ['mcpId', { props: { path: 'style' } }],
              ['mcpId', { props: { depth: 3 } }],
              [{ hooks: { kinds: ['State'], withValues: true }, mcpId: true }],
              [{ children: 5 }],
              [
                'mcpId',
                'name',
                { children: { select: ['mcpId', 'name', 'testID'], treeDepth: 3 } },
              ],
            ],
            type: 'array',
          },
          steps: {
            description:
              'Ordered steps: [{ scope?, name?, mcpId?, testID?, text?, hasProps?, props?, index? }]. See module description for full semantics.',
            examples: [
              [{ hasProps: ['onPress'] }],
              [{ name: 'HomeScreen' }, { name: 'ProductCard' }],
              [{ testID: 'favorite-icon' }, { index: 0, name: 'ProductCard', scope: 'ancestors' }],
              [{ props: { placeholder: { contains: 'Search' } } }],
            ],
            minItems: 1,
            type: 'array',
          },
          waitFor: {
            description: `Poll the query until a predicate holds, instead of reading once. \`until\` selects the target state: "appear" waits for \`total >= 1\`, "disappear" waits for \`total === 0\`. \`timeout\` caps the wait. \`interval\` is the gap between polls. \`stable\` requires the predicate to hold continuously for this many ms before returning — useful to ignore transient matches during screen transitions. Cache is always bypassed while polling. On success the response carries the usual query fields plus \`{ waited: true, until, attempts, elapsedMs, timedOut: false, stableFor? }\`; on timeout \`timedOut: true\` with the last observed matches.`,
            examples: [
              { until: 'appear' },
              { timeout: 5000, until: 'disappear' },
              { interval: 200, stable: 500, until: 'appear' },
            ],
            properties: {
              interval: {
                default: WAIT_INTERVAL_DEFAULT,
                description: 'Gap between polls in milliseconds.',
                minimum: WAIT_INTERVAL_MIN,
                type: 'number',
              },
              stable: {
                default: 0,
                description:
                  'Require the predicate to hold continuously for this many ms before returning.',
                minimum: 0,
                type: 'number',
              },
              timeout: {
                default: WAIT_TIMEOUT_DEFAULT,
                description: 'Max wait in milliseconds.',
                maximum: WAIT_TIMEOUT_MAX,
                minimum: 1,
                type: 'number',
              },
              until: {
                description: 'Target state to wait for.',
                enum: ['appear', 'disappear'],
                type: 'string',
              },
            },
            required: ['until'],
            type: 'object',
          },
        },
      },
    },
  };
};
