import { type HostContext } from '@/server/host/types';

export const DEFAULT_METRO_URL = 'http://localhost:8081';

/**
 * Resolve the Metro dev-server URL for a Metro tool call. Priority:
 *   1. `args.metroUrl` (explicit override — escape hatch).
 *   2. `client.devServer.url` (origin the app was actually loaded from,
 *      detected via RN's getDevServer()).
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
  return (clientUrl ?? DEFAULT_METRO_URL).replace(/\/$/, '');
};
