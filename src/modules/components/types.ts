export type ComponentType = 'composite' | 'host' | 'other' | 'text';

export interface SerializedComponent {
  children: SerializedComponent[];
  name: string;
  props: Record<string, unknown>;
  type: ComponentType;
  mcpId?: string;
  testID?: string;
  text?: string;
}

export interface ComponentQuery {
  hasProps?: string[];
  mcpId?: string;
  name?: string;
  testID?: string;
  text?: string;
}
