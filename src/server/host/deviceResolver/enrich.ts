import { type Bridge } from '@/server/bridge';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';

import { listAndroidDevices, listIosSimulators } from './list';
import { type EnrichedAndroidDevice, type EnrichedDeviceList, type EnrichedIosSim } from './types';

export const enrichDevicesWithClientStatus = async (
  bridge: Bridge,
  runner: ProcessRunner
): Promise<EnrichedDeviceList> => {
  const iosPromise = listIosSimulators(runner)
    .then((sims) => {
      return { ok: true as const, sims };
    })
    .catch((err: unknown) => {
      if (err instanceof ProcessNotFoundError) {
        return { error: 'xcrun not found', ok: false as const };
      }
      return { error: (err as Error).message, ok: false as const };
    });

  const androidPromise = listAndroidDevices(runner)
    .then((devices) => {
      return { devices, ok: true as const };
    })
    .catch((err: unknown) => {
      if (err instanceof ProcessNotFoundError) {
        return { error: 'adb not found', ok: false as const };
      }
      return { error: (err as Error).message, ok: false as const };
    });

  const [iosRaw, androidRaw] = await Promise.all([iosPromise, androidPromise]);

  const clients = bridge.listClients();
  const iosClients = clients.filter((c) => {
    return c.platform === 'ios';
  });
  const androidClients = clients.filter((c) => {
    return c.platform === 'android';
  });

  let iosOut: EnrichedIosSim[] | { error: string };
  if (iosRaw.ok) {
    const enriched: EnrichedIosSim[] = iosRaw.sims.map((sim) => {
      return { ...sim, connected: false };
    });
    for (const client of iosClients) {
      if (!client.label) {
        continue;
      }
      const label = client.label;
      const exact = enriched.filter((s) => {
        return s.state === 'Booted' && !s.connected && s.name === label;
      });
      if (exact.length === 1) {
        exact[0]!.connected = true;
        exact[0]!.clientId = client.id;
        continue;
      }
      const substring = enriched.filter((s) => {
        return s.state === 'Booted' && !s.connected && s.name.includes(label);
      });
      if (substring.length === 1) {
        substring[0]!.connected = true;
        substring[0]!.clientId = client.id;
      }
    }
    enriched.sort((a, b) => {
      const rank = (item: EnrichedIosSim): number => {
        if (item.connected) {
          return 0;
        }
        return item.state === 'Booted' ? 1 : 2;
      };
      const aRank = rank(a);
      const bRank = rank(b);
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      if (a.connected && b.connected) {
        return (a.clientId ?? '').localeCompare(b.clientId ?? '');
      }
      return a.name.localeCompare(b.name);
    });
    iosOut = enriched;
  } else {
    iosOut = { error: iosRaw.error };
  }

  let androidOut: EnrichedAndroidDevice[] | { error: string };
  if (androidRaw.ok) {
    const enriched: EnrichedAndroidDevice[] = androidRaw.devices.map((d) => {
      return { ...d, connected: false };
    });
    const onlineIdx = enriched.findIndex((d) => {
      return d.state === 'device';
    });
    const onlineCount = enriched.filter((d) => {
      return d.state === 'device';
    }).length;
    if (onlineCount === 1 && androidClients.length === 1 && onlineIdx >= 0) {
      enriched[onlineIdx]!.connected = true;
      enriched[onlineIdx]!.clientId = androidClients[0]!.id;
    }
    enriched.sort((a, b) => {
      const rank = (item: EnrichedAndroidDevice): number => {
        if (item.connected) {
          return 0;
        }
        return item.state === 'device' ? 1 : 2;
      };
      const aRank = rank(a);
      const bRank = rank(b);
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      if (a.connected && b.connected) {
        return (a.clientId ?? '').localeCompare(b.clientId ?? '');
      }
      return a.serial.localeCompare(b.serial);
    });
    androidOut = enriched;
  } else {
    androidOut = { error: androidRaw.error };
  }

  return { android: androidOut, ios: iosOut };
};
