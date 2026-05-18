export interface IosSimulator {
  name: string;
  state: string;
  udid: string;
}

export interface IosRealDevice {
  coreDeviceIdentifier: string;
  name: string;
  pairingState: string;
}

export interface AndroidDevice {
  serial: string;
  state: string;
}

export type DeviceKind = 'real-device' | 'simulator';

export interface ResolvedDevice {
  displayName: string;
  kind: DeviceKind;
  nativeId: string;
  platform: 'android' | 'ios';
  bundleId?: string;
}

export interface EnrichedIosSim extends IosSimulator {
  connected: boolean;
  clientId?: string;
}

export interface EnrichedAndroidDevice extends AndroidDevice {
  connected: boolean;
  clientId?: string;
}

export interface EnrichedDeviceList {
  android: EnrichedAndroidDevice[] | { error: string };
  ios: EnrichedIosSim[] | { error: string };
}

export type DeviceResolution = { device: ResolvedDevice; ok: true } | { error: string; ok: false };
