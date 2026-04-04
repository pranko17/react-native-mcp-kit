export interface DeviceInfo {
  appearance: string | null;
  dimensions: {
    screen: { fontScale: number; height: number; scale: number; width: number };
    window: { fontScale: number; height: number; scale: number; width: number };
  };
  pixelRatio: number;
  platform: {
    constants: Record<string, unknown>;
    os: string;
    version: number | string;
  };
}
