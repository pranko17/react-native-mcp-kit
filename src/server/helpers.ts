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

export type ClientIdsParse =
  | { ids: string[]; mode: 'broadcast'; ok: true }
  | { clientId: string | undefined; mode: 'single'; ok: true }
  | { error: string; ok: false };

// Same `/body/flags` literal recogniser used by logBox.parsePattern — keep the
// vocabulary in sync so an agent that knows the form from fiber_tree hook
// filters can use it here too.
const REGEX_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

const tryParseRegex = (raw: string): RegExp | { error: string } | null => {
  const m = raw.match(REGEX_LITERAL);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]);
  } catch (err) {
    return { error: `Invalid regex in clientId "${raw}": ${(err as Error).message}` };
  }
};

/**
 * Normalises the `clientId` arg accepted by every public tool.
 *
 * Forms:
 *   undefined / null   — auto-resolve to the single connected client.
 *   "ios-1"            — literal single-client target (image content passes
 *                        through, single-shape response).
 *   "/^ios/"           — regex against connected client IDs; always returns
 *                        the broadcast envelope (even if matched count is 1).
 *   ["ios-1","..."]    — array form: literals and regex strings can be mixed.
 *                        Regex entries are expanded against `bridge.listClients()`
 *                        and unioned with literals before dedup.
 *
 * Errors when an array entry is non-string / array is empty / a regex matches
 * zero connected clients. Literals that aren't connected are NOT pre-validated
 * here — they fall through to dispatchTool which reports a per-client error,
 * matching the broadcast "not fail-fast" semantics.
 */
export const parseClientIds = (raw: unknown, bridge: Bridge): ClientIdsParse => {
  if (raw === undefined || raw === null) return { clientId: undefined, mode: 'single', ok: true };

  if (typeof raw === 'string') {
    const re = tryParseRegex(raw);
    if (re === null) return { clientId: raw, mode: 'single', ok: true };
    if ('error' in re) return { error: re.error, ok: false };
    const ids = expandRegex(re, bridge);
    if (ids.length === 0) {
      return { error: `Pattern "${raw}" matched no connected clients.`, ok: false };
    }
    return { ids, mode: 'broadcast', ok: true };
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { error: 'clientId array must contain at least one entry.', ok: false };
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        return { error: 'clientId array must contain strings only.', ok: false };
      }
      const re = tryParseRegex(entry);
      if (re && 'error' in re) return { error: re.error, ok: false };
      if (re instanceof RegExp) {
        const matched = expandRegex(re, bridge);
        if (matched.length === 0) {
          return { error: `Pattern "${entry}" matched no connected clients.`, ok: false };
        }
        for (const id of matched) {
          if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }
      } else if (!seen.has(entry)) {
        seen.add(entry);
        ids.push(entry);
      }
    }
    return { ids, mode: 'broadcast', ok: true };
  }

  return { error: 'clientId must be a string or an array of strings.', ok: false };
};

const expandRegex = (re: RegExp, bridge: Bridge): string[] => {
  return bridge
    .listClients()
    .filter((c) => {
      return re.test(c.id);
    })
    .map((c) => {
      return c.id;
    });
};

/**
 * Detects an MCP image-content payload (the shape host__screenshot returns)
 * without re-running formatResult. Used to pick the broadcast aggregation
 * strategy — text-only results collapse into a single JSON envelope, image
 * results keep per-client blocks so each image is anchored to its source.
 */
const isImageResult = (result: unknown): boolean => {
  if (!Array.isArray(result) || result.length === 0) return false;
  const first = result[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    'type' in first &&
    (first as { type: unknown }).type === 'image'
  );
};

export interface BroadcastDispatch {
  clientId: string;
  result: DispatchResult;
}

/**
 * Build MCP content blocks from per-client dispatch results. When every result
 * is text-only, the function returns a single JSON envelope so the agent can
 * parse one blob; when any result carries image content (e.g. screenshots),
 * results are emitted as per-client blocks prefixed with `## <clientId>`
 * headers so each image stays paired with its source.
 */
export const buildBroadcastContent = (
  results: BroadcastDispatch[],
  formatResult: (result: unknown) => Array<TextContent | ImageContent>
): Array<TextContent | ImageContent> => {
  const hasImage = results.some(({ result }) => {
    return result.ok && isImageResult(result.result);
  });

  const okCount = results.reduce((n, { result }) => {
    return n + (result.ok ? 1 : 0);
  }, 0);
  const failedCount = results.length - okCount;

  if (!hasImage) {
    return [
      {
        text: JSON.stringify(
          {
            failedCount,
            okCount,
            results: results.map(({ clientId, result }) => {
              if (result.ok) return { clientId, ok: true, result: result.result };
              return { clientId, error: result.error, ok: false };
            }),
          },
          null,
          2
        ),
        type: 'text' as const,
      },
    ];
  }

  const blocks: Array<TextContent | ImageContent> = [
    {
      text: `Broadcast: ${okCount} ok, ${failedCount} failed (${results.length} clients).`,
      type: 'text' as const,
    },
  ];
  for (const { clientId, result } of results) {
    blocks.push({ text: `## ${clientId}`, type: 'text' as const });
    if (result.ok) {
      blocks.push(...formatResult(result.result));
    } else {
      blocks.push({
        text: JSON.stringify({ error: result.error }, null, 2),
        type: 'text' as const,
      });
    }
  }
  return blocks;
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
