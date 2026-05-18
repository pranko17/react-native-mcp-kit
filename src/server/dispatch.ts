import { DYNAMIC_PREFIX, MODULE_SEPARATOR, type ModuleDescriptor } from '@/shared/protocol';

import { type Bridge } from './bridge';
import { type DispatchResult, type HostToolEntry } from './helpers';
import { type HostModule } from './host/types';

/**
 * Pre-indexes host tools by full name so dispatch is O(1).
 */
export const buildHostToolMap = (hostModules: HostModule[]): Map<string, HostToolEntry> => {
  const map = new Map<string, HostToolEntry>();
  for (const mod of hostModules) {
    for (const [toolName, tool] of Object.entries(mod.tools)) {
      const fullName = `${mod.name}${MODULE_SEPARATOR}${toolName}`;
      map.set(fullName, {
        handler: tool.handler,
        moduleName: mod.name,
        timeout: tool.timeout,
        toolName,
      });
    }
  }
  return map;
};

/**
 * Creates the tool dispatcher used by `call`, `wait_until`, `assert`, and host
 * tools that chain (`host__tap_fiber` → `fiber_tree__query` + `host__tap`). The
 * returned function closes over `bridge` + `hostToolMap` so the host context's
 * own `dispatch` callback can re-enter without losing the original clientId.
 */
export const createDispatcher = (
  bridge: Bridge,
  hostToolMap: Map<string, HostToolEntry>
): ((
  tool: string,
  args: Record<string, unknown>,
  clientId?: string
) => Promise<DispatchResult>) => {
  const dispatch = async (
    tool: string,
    args: Record<string, unknown>,
    clientId?: string
  ): Promise<DispatchResult> => {
    const hostEntry = hostToolMap.get(tool);
    if (hostEntry) {
      try {
        const result = await hostEntry.handler(args, {
          bridge,
          dispatch: (nextTool, nextArgs, nextClientId) => {
            return dispatch(nextTool, nextArgs, nextClientId ?? clientId);
          },
          requestedClientId: clientId,
        });
        return { ok: true, result };
      } catch (err) {
        return { error: `Host tool "${tool}" threw: ${(err as Error).message}`, ok: false };
      }
    }

    const resolution = bridge.resolveClient(clientId);
    if (!resolution.ok) return { error: resolution.error, ok: false };
    const client = resolution.client;

    let mod: ModuleDescriptor | undefined;
    let moduleName = '';
    let methodName = '';
    for (const m of client.modules) {
      const prefix = `${m.name}${MODULE_SEPARATOR}`;
      if (tool.startsWith(prefix)) {
        mod = m;
        moduleName = m.name;
        methodName = tool.slice(prefix.length);
        break;
      }
    }

    if (!mod) {
      if (tool.startsWith(DYNAMIC_PREFIX)) {
        moduleName = `${MODULE_SEPARATOR}dynamic`;
        methodName = tool.slice(DYNAMIC_PREFIX.length);
      } else {
        const idx = tool.indexOf(MODULE_SEPARATOR);
        if (idx <= 0) {
          return {
            error: `Invalid tool name "${tool}". Use "module${MODULE_SEPARATOR}method" format.`,
            ok: false,
          };
        }
        moduleName = tool.slice(0, idx);
        methodName = tool.slice(idx + MODULE_SEPARATOR.length);
      }
      try {
        const result = await bridge.call(client.id, moduleName, methodName, args);
        return { ok: true, result };
      } catch {
        const allModules = client.modules
          .map((m) => {
            return m.name;
          })
          .join(', ');
        const dynNames = [...client.dynamicTools.keys()].join(', ');
        return {
          error: `Tool "${tool}" not found on client '${client.id}'. Modules: ${allModules || '(none)'}. Dynamic: ${dynNames || '(none)'}`,
          ok: false,
        };
      }
    }

    const toolDef = mod.tools.find((t) => {
      return t.name === methodName;
    });
    if (!toolDef) {
      return {
        error: `Tool "${methodName}" not found in module "${moduleName}" on client '${client.id}'. Available: ${mod.tools
          .map((t) => {
            return t.name;
          })
          .join(', ')}`,
        ok: false,
      };
    }

    try {
      const result = await bridge.call(client.id, moduleName, methodName, args, toolDef.timeout);
      return { ok: true, result };
    } catch (err) {
      return { error: (err as Error).message, ok: false };
    }
  };

  return dispatch;
};
