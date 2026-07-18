import AsyncStorage from '@react-native-async-storage/async-storage';
import { createMMKV, type MMKV } from 'react-native-mmkv';

// Three named stores wired into one `storage` module. The agent picks one via
// the `storage` argument; the first registered store ("mmkv") is the default.
//
// They intentionally have different shapes:
//   • mmkv   — full read/write (synchronous native store)
//   • async  — full read/write (asynchronous JS store)
//   • config — READ-ONLY custom adapter (only `get` + `getAllKeys`). Calling
//              `storage__set_item({ storage: 'config' })` returns the library's
//              "this storage does not support set" envelope — a deliberate demo
//              of the optional-capability contract.

// MMKV is created lazily and defensively: a storage backend failing to
// initialize must never crash the whole app at import time. If MMKV is
// unavailable on this toolchain, the `mmkv` store simply behaves as empty and
// the `async` / `config` stores carry the storage demo.
let mmkvInstance: MMKV | null | undefined;
const getMmkv = (): MMKV | null => {
  if (mmkvInstance === undefined) {
    try {
      // MMKV v4 creates instances via the `createMMKV` factory (the `MMKV`
      // export is a type only). `new MMKV()` is the removed v2 API.
      mmkvInstance = createMMKV({ id: 'demo-mmkv' });
    } catch (error) {
      console.warn('[demo] MMKV unavailable, falling back:', error);
      mmkvInstance = null;
    }
  }
  return mmkvInstance ?? null;
};

const mmkvAdapter = {
  get: (key: string) => getMmkv()?.getString(key) ?? null,
  set: (key: string, value: string) => getMmkv()?.set(key, value),
  delete: (key: string) => {
    getMmkv()?.remove(key);
  },
  getAllKeys: () => getMmkv()?.getAllKeys() ?? [],
};

const asyncAdapter = {
  get: (key: string) => AsyncStorage.getItem(key),
  set: (key: string, value: string) => AsyncStorage.setItem(key, value),
  delete: (key: string) => AsyncStorage.removeItem(key),
  getAllKeys: () => AsyncStorage.getAllKeys().then((keys) => [...keys]),
};

// A custom in-memory adapter, pre-seeded and read-only. Shows that any object
// fulfilling the `{ get }` contract is a valid store.
const configData: Record<string, string> = {
  'feature.newCheckout': 'true',
  'feature.darkLaunch': 'false',
  'config.apiBaseUrl': JSON.stringify('https://dummyjson.com'),
  'config.experiment': JSON.stringify({ bucket: 'B', weight: 0.3, since: '2026-01-01' }),
};

const configAdapter = {
  get: (key: string) => configData[key] ?? null,
  getAllKeys: () => Object.keys(configData),
  // No `set` / `delete` on purpose.
};

export const storages = [
  { name: 'mmkv', adapter: mmkvAdapter },
  { name: 'async', adapter: asyncAdapter },
  { name: 'config', adapter: configAdapter },
];

// Sample keys the Settings screen seeds/clears, so there's always something for
// `storage__get_all` / `storage__list_keys` to return.
const SAMPLE: Record<string, string> = {
  'user.profile': JSON.stringify({ id: 7, name: 'Ada Lovelace', email: 'ada@example.com' }),
  'user.preferences': JSON.stringify({ newsletter: true, theme: 'system' }),
  'session.token': 'demo-token-do-not-redact-me',
  'lastVisitedScreen': 'Home',
};

export const SAMPLE_KEYS = Object.keys(SAMPLE);

export const seedSampleData = (): void => {
  Object.entries(SAMPLE).forEach(([key, value]) => {
    mmkvAdapter.set(key, value);
    void asyncAdapter.set(key, value);
  });
};

export const clearSampleData = (): void => {
  SAMPLE_KEYS.forEach((key) => {
    mmkvAdapter.delete(key);
    void asyncAdapter.delete(key);
  });
};

export const countMmkvKeys = (): number => mmkvAdapter.getAllKeys().length;
