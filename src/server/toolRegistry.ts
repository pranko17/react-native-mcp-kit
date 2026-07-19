import { EventEmitter } from 'node:events';

import { z, type ZodType } from 'zod';

import { type WireCallResult, type WireToolDescriptor } from '@/shared/proxyProtocol';

import { type ImageContent, type TextContent } from './helpers';

export type ToolCallContent = { content: Array<TextContent | ImageContent> };

export interface RegistryEntry {
  description: string;
  handler: (args: Record<string, unknown>) => Promise<ToolCallContent>;
  /** Zod validator applied to raw args before the handler runs. */
  schema: ZodType;
  annotations?: Record<string, unknown>;
}

interface StoredEntry extends RegistryEntry {
  wireSchema: Record<string, unknown>;
}

export interface RegistryEvents {
  /** Coalesced across same-tick set/delete batches. */
  changed: [];
}

const toWireSchema = (schema: ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
};

/**
 * The single source of truth for every tool the server exposes — host tools,
 * client-module tools, dynamic `useMcpTool` tools, and the wait_until/assert
 * wrappers. MCP fronts (stdio in-process, or remote session proxies via the
 * daemon's proxy service) serve `tools/list` and `tools/call` from here, so
 * any number of MCP sessions observe one identical catalog.
 *
 * Argument validation lives here (the SDK used to do it at registerTool
 * level): raw args are parsed through the entry's Zod schema, and a failure
 * surfaces as `invalidParams` so fronts can re-raise the MCP InvalidParams
 * protocol error the SDK would have produced.
 */
export class ToolRegistry extends EventEmitter<RegistryEvents> {
  private tools = new Map<string, StoredEntry>();
  private changeTimer: ReturnType<typeof setImmediate> | null = null;

  set(name: string, entry: RegistryEntry): void {
    this.tools.set(name, { ...entry, wireSchema: toWireSchema(entry.schema) });
    this.scheduleChanged();
  }

  delete(name: string): void {
    if (this.tools.delete(name)) {
      this.scheduleChanged();
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): WireToolDescriptor[] {
    return [...this.tools.entries()].map(([name, entry]) => {
      const descriptor: WireToolDescriptor = {
        description: entry.description,
        inputSchema: entry.wireSchema,
        name,
      };
      if (entry.annotations) descriptor.annotations = entry.annotations;
      return descriptor;
    });
  }

  async call(name: string, rawArgs: Record<string, unknown> | undefined): Promise<WireCallResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return {
        content: [],
        unknownTool: `Tool ${name} not found. It may belong to an app that disconnected — check host__connection_status, relaunch with host__launch_app.`,
      };
    }
    const parsed = entry.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      // Same in-band shape (and issues payload) the high-level SDK produced —
      // agents and tests key on the quoted path names inside the issues JSON.
      return {
        content: [],
        invalidParams: `Invalid arguments for tool ${name}: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      };
    }
    const result = await entry.handler(parsed.data as Record<string, unknown>);
    return { content: result.content as WireCallResult['content'] };
  }

  private scheduleChanged(): void {
    if (this.changeTimer) return;
    this.changeTimer = setImmediate(() => {
      this.changeTimer = null;
      this.emit('changed');
    });
  }
}
