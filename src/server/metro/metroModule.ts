import { type HostModule } from '@/server/host/types';

import { openUrlTool } from './tools/openUrl';
import { reloadTool } from './tools/reload';
import { symbolicateTool } from './tools/symbolicate';

export const metroModule = (): HostModule => {
  return {
    description: `Metro dev-server control plane. Tools here talk HTTP to the Metro instance the React Native app was bundled from — the URL is auto-detected from each client's handshake (scriptURL), so non-default ports and LAN-connected physical devices work without extra config. Falls back to http://localhost:8081 when the app didn't report a dev-server (production builds, detection failure).

All tools no-op gracefully with { skipped: true, error } when Metro is unreachable.`,
    name: 'metro',
    tools: {
      open_url: openUrlTool(),
      reload: reloadTool(),
      symbolicate: symbolicateTool(),
    },
  };
};
