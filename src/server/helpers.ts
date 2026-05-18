import { MODULE_SEPARATOR } from '@/shared/protocol';

import { type Bridge, type ClientEntry } from './bridge';
import { type HostModule, type HostToolHandler } from './host/types';

export type TextContent = { text: string; type: 'text' };
export type ImageContent = { data: string; mimeType: string; type: 'image' };

export interface HostToolEntry {
  handler: HostToolHandler['handler'];
  moduleName: string;
  toolName: string;
  timeout?: number;
}

export interface ToolDescriptorShape {
  description: string;
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolGroup {
  description: string | undefined;
  module: string;
  tools: Array<{
    description: string;
    name: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

export type DispatchResult = { ok: true; result: unknown } | { error: string; ok: false };

/**
 * Shared state passed to every MCP tool registration in `src/server/tools/`.
 * The McpServerWrapper constructs one and hands it to each `register<Tool>`
 * function so the tool files stay decoupled from the class.
 */
export interface ServerContext {
  bridge: Bridge;
  dispatchTool: (
    tool: string,
    args: Record<string, unknown>,
    clientId?: string
  ) => Promise<DispatchResult>;
  formatResult: (result: unknown) => Array<TextContent | ImageContent>;
  hostModules: HostModule[];
  hostToolMap: Map<string, HostToolEntry>;
  listToolGroups: (client: ClientEntry) => ToolGroup[];
}

export const jsonError = (msg: string): { content: TextContent[] } => {
  return {
    content: [{ text: JSON.stringify({ error: msg }), type: 'text' as const }],
  };
};

/**
 * Parse a `call`-style args argument that may arrive as a JSON string (older
 * clients) or a plain object (new form). Returns { ok, args } or { ok: false,
 * error } on malformed JSON.
 */
export const parseCallArgs = (
  raw: unknown
): { args: Record<string, unknown>; ok: true } | { error: string; ok: false } => {
  if (raw === undefined || raw === null) return { args: {}, ok: true };
  if (typeof raw === 'string') {
    if (raw.length === 0) return { args: {}, ok: true };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown>, ok: true };
      }
      return { error: 'Parsed args must be an object.', ok: false };
    } catch {
      return { error: 'Invalid JSON in args.', ok: false };
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, ok: true };
  }
  return { error: 'args must be an object or a JSON string.', ok: false };
};

/**
 * Recursively serializes a value to JSON with sorted object keys, producing a
 * stable canonical form that's safe to use as a dedup Map key. Arrays keep
 * their original order — caller is responsible for normalizing them when
 * order-independence is desired.
 */
export const canonicalize = (value: unknown): string => {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
};

/**
 * Produces a canonical key for a ToolGroup that's independent of tool
 * registration order. Two modules with the same name + tools (regardless of
 * order) + descriptions + schemas produce the same key.
 */
export const canonicalizeGroup = (group: ToolGroup): string => {
  const normalized = {
    description: group.description,
    module: group.module,
    tools: [...group.tools].sort((a, b) => {
      return a.name.localeCompare(b.name);
    }),
  };
  return canonicalize(normalized);
};

/**
 * Looks up a full tool descriptor on a client by its full name
 * (`module__method`). Checks both static modules and dynamic tools registered
 * via useMcpTool. Returns null if the tool is not on this client.
 */
export const findToolInClient = (
  client: ClientEntry,
  toolFullName: string
): ToolDescriptorShape | null => {
  for (const mod of client.modules) {
    const prefix = `${mod.name}${MODULE_SEPARATOR}`;
    if (toolFullName.startsWith(prefix)) {
      const methodName = toolFullName.slice(prefix.length);
      const toolDef = mod.tools.find((t) => {
        return t.name === methodName;
      });
      if (toolDef) {
        return {
          description: toolDef.description,
          inputSchema: toolDef.inputSchema,
          name: toolFullName,
        };
      }
    }
  }

  const dynamicEntry = client.dynamicTools.get(toolFullName);
  if (dynamicEntry) {
    return {
      description: dynamicEntry.description,
      inputSchema: dynamicEntry.inputSchema,
      name: toolFullName,
    };
  }

  return null;
};

/**
 * Builds the per-client list of ToolGroup entries that `list_tools` deduplicates
 * across clients. Static modules are passed through; dynamic tools are grouped
 * under a synthetic `<module> (dynamic)` group per source module.
 */
export const buildToolGroups = (client: ClientEntry): ToolGroup[] => {
  const groups: ToolGroup[] = client.modules.map((mod) => {
    return {
      description: mod.description,
      module: mod.name,
      tools: mod.tools.map((t) => {
        return {
          description: t.description,
          inputSchema: t.inputSchema,
          name: `${mod.name}${MODULE_SEPARATOR}${t.name}`,
        };
      }),
    };
  });

  if (client.dynamicTools.size > 0) {
    const dynamicByModule = new Map<
      string,
      Array<{ description: string; name: string; inputSchema?: Record<string, unknown> }>
    >();
    for (const [fullName, info] of client.dynamicTools) {
      const existing = dynamicByModule.get(info.module) ?? [];
      existing.push({
        description: info.description,
        inputSchema: info.inputSchema,
        name: fullName,
      });
      dynamicByModule.set(info.module, existing);
    }
    for (const [module, dynTools] of dynamicByModule) {
      groups.push({
        description: 'Dynamically registered tools from useMcpTool hooks',
        module: `${module} (dynamic)`,
        tools: dynTools,
      });
    }
  }

  return groups;
};

/**
 * Detects image-content payloads (from host__screenshot) and passes them
 * through as MCP image blocks; everything else is JSON-serialized text.
 */
export const formatResult = (result: unknown): Array<TextContent | ImageContent> => {
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];
    if (typeof first === 'object' && first !== null && 'type' in first && first.type === 'image') {
      return result as Array<TextContent | ImageContent>;
    }
  }
  return [{ text: JSON.stringify(result, null, 2), type: 'text' as const }];
};
