import { type NodePath, type PluginPass, type types as BabelTypes } from '@babel/core';

/**
 * Per-file plugin state with deferred-injection queue. Babel instantiates
 * `PluginPass` per file, so this naturally scopes the queue to a single
 * transformation. We collect all the metadata assignments during the main
 * traversal, then flush them at `Program:exit` — that runs AFTER other
 * plugins' replaceWith calls (e.g. react-refresh wrapping HOC chains in
 * `_s(...)` signature calls), so our injected statements aren't dropped by
 * babel's re-traversal of the rebuilt subtrees.
 */
export type DeferredInsert =
  | {
      hooks: CollectedHook[];
      kind: 'assignment';
      outer: string;
      statementPath: NodePath<BabelTypes.Node>;
    }
  | { inner: string; kind: 'getter'; outer: string; statementPath: NodePath<BabelTypes.Node> };

export interface PluginPassWithQueue extends PluginPass {
  pendingInjects?: DeferredInsert[];
}

export interface PluginOptions {
  /** Attribute name to use. Default: "data-mcp-id" */
  attr?: string;
  /** Components to skip. Default: common wrappers */
  exclude?: string[];
  /** Components to add id to. Default: all capitalized JSX elements */
  include?: string[];
  /** Separator between parts. Default: ":" */
  separator?: string;
}

export interface CollectedHook {
  /** Source-level hook function name (`useState`, `useAnimatedStyle`, etc.).
   * Surfaced to the agent alongside `name` (the consuming binding) so it
   * can tell e.g. `count (useState)` from `count (useReducer)` without
   * inferring from `kind`. For React.useXxx member-call form we still
   * record just the property name (`useState`). */
  hook: string;
  kind: string;
  name: string;
  /**
   * For Custom-kind entries: the source identifier of the hook function being
   * called. Runtime reads `identifierRef.__mcp_hooks` to recursively expand
   * sub-hooks, keeping slot alignment exact even when custom hooks span
   * multiple built-in slots. Built-in hooks (State/Memo/...) don't need this.
   */
  fnIdent?: string;
  /**
   * Call-site identity in the same shape as JSX `data-mcp-id`:
   * `<name>:<shortFile>:<line>`. Lets an agent `Read(<file>, <line>)`
   * straight from a hook entry without grepping for the variable name.
   * Empty when source location isn't available (synthetic AST nodes).
   */
  mcpId?: string;
}
