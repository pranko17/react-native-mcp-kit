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
 * - `{ contains: str, deep?: boolean }` → substring match against String(value).
 *   With `deep: true` the value is JSON-serialized first (circular-safe,
 *   functions/symbols replaced, length capped), so nested values become
 *   searchable — e.g. `{ contains: "\"title\":\"Hello\"", deep: true }` hits
 *   a prop like `{ item: { title: "Hello" } }`. Without `deep`, non-primitive
 *   values don't match.
 * - `{ regex: pattern, deep?: boolean }` → full regex test against the same
 *   string form. Invalid patterns don't throw, they just never match.
 */
export type PropMatcher =
  | boolean
  | number
  | string
  | { contains: string; deep?: boolean }
  | { regex: string; deep?: boolean };

export interface ComponentQuery {
  /**
   * OR of sub-criteria. Matches if any of the listed criteria matches.
   * Nests arbitrarily: each sub-criteria can itself carry `any` / `not`.
   * Example: { any: [{ name: "Pressable" }, { name: "TouchableOpacity" }] }.
   */
  any?: ComponentQuery[];
  hasProps?: string[];
  mcpId?: string;
  name?: string;
  /**
   * Negation — matches iff the inner criteria does NOT match.
   * Composes with the other fields (all AND-ed), so you can write
   * { hasProps: ["onPress"], not: { testID: "loading" } } to mean
   * "has onPress and is not the loading indicator".
   */
  not?: ComponentQuery;
  /**
   * Match by prop values. Each entry is AND-ed.
   * Example: { placeholder: { contains: "Search" }, variant: "primary" }.
   */
  props?: Record<string, PropMatcher>;
  testID?: string;
  text?: string;
}
