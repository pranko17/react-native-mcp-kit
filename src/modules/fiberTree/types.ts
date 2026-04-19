export type ComponentType = 'composite' | 'host' | 'other' | 'text';

export interface Bounds {
  // physical pixels, top-left origin
  centerX: number;
  centerY: number;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface SerializedComponent {
  children: SerializedComponent[];
  name: string;
  props: Record<string, unknown>;
  type: ComponentType;
  bounds?: Bounds;
  mcpId?: string;
  testID?: string;
  text?: string;
}

/**
 * Per-prop match specification used in `ComponentQuery.props`.
 * - primitive → strict equality (good for typed props like `disabled: false`)
 * - `{ contains: str }` → substring match. Value is coerced via String(value),
 *   so it works on strings, numbers, or anything whose toString() is useful.
 * - `{ regex: pattern }` → full regex test against String(value). Invalid
 *   patterns don't throw, they just never match.
 */
export type PropMatcher = boolean | number | string | { contains: string } | { regex: string };

export interface ComponentQuery {
  hasProps?: string[];
  mcpId?: string;
  name?: string;
  /**
   * Match by prop values. Each entry is AND-ed.
   * Example: { placeholder: { contains: "Search" }, variant: "primary" }.
   */
  props?: Record<string, PropMatcher>;
  testID?: string;
  text?: string;
}
