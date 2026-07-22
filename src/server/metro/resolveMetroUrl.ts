import { type HostContext } from '@/server/host/types';

export const DEFAULT_METRO_URL = 'http://localhost:8081';

/**
 * A client's devServer.url is the origin the APP loaded from — as seen from
 * inside the device. Android emulators report the host loopback as 10.0.2.2
 * (10.0.3.2 on Genymotion); this server runs ON the host, where those
 * aliases don't resolve. Map them back to localhost before dialing out.
 */
const normalizeForHost = (url: string): string => {
  return url.replace(/^(https?:\/\/)10\.0\.[23]\.2(?=[:/]|$)/, '$1localhost');
};

/**
 * Resolve the Metro dev-server URL for a Metro tool call. Priority:
 *   1. `args.metroUrl` (explicit override — escape hatch).
 *   2. `client.devServer.url` (origin the app was actually loaded from,
 *      detected via RN's getDevServer()), emulator host aliases mapped
 *      back to localhost.
 *   3. Hardcoded `http://localhost:8081` (last resort).
 * Trailing slash is stripped so callers can safely do `${url}/reload`.
 */
export const resolveMetroUrl = (
  args: Record<string, unknown>,
  ctx: Pick<HostContext, 'bridge' | 'requestedClientId'>
): string => {
  const explicit = typeof args.metroUrl === 'string' ? args.metroUrl : undefined;
  if (explicit) return explicit.replace(/\/$/, '');

  const clientId = (args.clientId as string | undefined) ?? ctx.requestedClientId;
  const resolution = ctx.bridge.resolveClient(clientId);
  const clientUrl = resolution.ok ? resolution.client.devServer?.url : undefined;
  return normalizeForHost((clientUrl ?? DEFAULT_METRO_URL).replace(/\/$/, ''));
};
