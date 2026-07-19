import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import {
  alertModule,
  consoleModule,
  deviceModule,
  errorsModule,
  fiberTreeModule,
  i18nextModule,
  logBoxModule,
  navigationModule,
  networkModule,
  reactQueryModule,
  reduxModule,
  storageModule,
} from '@/modules';
import { convertInputSchema } from '@/server/inputSchemaToZod';

/**
 * Regression audit for the schema pipeline every tool goes through on its way
 * to an agent's catalog: author Zod schema → `serializeInputSchema` (client
 * wire form) → `convertInputSchema` (server validator) → `z.toJSONSchema`
 * (catalog). A `description` present on the wire but missing from the catalog
 * is documentation silently lost for the agent — this suite asserts zero loss
 * across every tool of every built-in module.
 *
 * Importing `@/modules` patches `console` / global error handlers / `fetch`
 * (side-effectful capture modules install at import time) — acceptable inside
 * this isolated test process.
 */

// Structural stub for factory dependencies (i18n instance, queryClient,
// store, navigation ref, storages): every property access yields a no-op
// function returning undefined. Factories only touch their dependencies
// lazily inside handlers — except navigationModule, whose setup() probes
// isReady()/getRootState()/addListener and tolerates undefined results.
const dependencyStub = new Proxy(
  {},
  {
    get: () => {
      return () => {
        return undefined;
      };
    },
  }
) as never;

const modules = [
  alertModule(),
  consoleModule(),
  deviceModule(),
  errorsModule(),
  fiberTreeModule(),
  i18nextModule(dependencyStub),
  logBoxModule(),
  navigationModule(dependencyStub),
  networkModule(),
  reactQueryModule(dependencyStub),
  reduxModule(dependencyStub),
  storageModule(dependencyStub),
];

/**
 * Recursively collects the path of every string `description` in a JSON
 * Schema tree (walking `properties`, `items`, `anyOf` and any other nested
 * node generically).
 */
const collectDescriptionPaths = (
  node: unknown,
  path = '',
  out = new Set<string>()
): Set<string> => {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      collectDescriptionPaths(item, `${path}[${index}]`, out);
    });
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') {
        out.add(path);
        continue;
      }
      collectDescriptionPaths(value, path === '' ? key : `${path}.${key}`, out);
    }
  }
  return out;
};

interface ToolAudit {
  catalog: Record<string, unknown>;
  catalogPaths: Set<string>;
  toolId: string;
  wirePaths: Set<string>;
}

const audits: ToolAudit[] = modules.flatMap((module) => {
  return Object.entries(module.tools).map(([toolName, tool]) => {
    const wire = serializeInputSchema(tool.inputSchema);
    const catalog = z.toJSONSchema(convertInputSchema(wire), { io: 'input' }) as Record<
      string,
      unknown
    >;
    return {
      catalog,
      catalogPaths: collectDescriptionPaths(catalog),
      toolId: `${module.name}__${toolName}`,
      wirePaths: collectDescriptionPaths(wire),
    };
  });
});

describe('description audit across all built-in modules', () => {
  it('instantiates all 12 built-in modules', () => {
    expect(
      modules
        .map((module) => {
          return module.name;
        })
        .sort()
    ).toEqual([
      'alert',
      'console',
      'device',
      'errors',
      'fiber_tree',
      'i18n',
      'log_box',
      'navigation',
      'network',
      'query',
      'redux',
      'storage',
    ]);
  });

  it('loses zero descriptions between the wire schema and the server catalog', () => {
    const losses: string[] = [];
    let wireTotal = 0;
    for (const { catalogPaths, toolId, wirePaths } of audits) {
      wireTotal += wirePaths.size;
      for (const path of wirePaths) {
        if (!catalogPaths.has(path)) {
          losses.push(`${toolId}: ${path}`);
        }
      }
    }
    expect(losses).toEqual([]);
    // Zero losses must not mean "zero wire descriptions to lose".
    expect(wireTotal).toBeGreaterThan(100);
  });

  it('exposes a described clientId on every tool catalog', () => {
    for (const { catalog, toolId } of audits) {
      const properties = catalog.properties as
        Record<string, Record<string, unknown> | undefined> | undefined;
      expect(properties?.clientId, toolId).toBeDefined();
      expect(properties?.clientId?.description, toolId).toContain('Target client ID');
    }
  });

  it('audits a substantive catalog — the description corpus is not empty', () => {
    const totalCatalogDescriptions = audits.reduce((n, { catalogPaths }) => {
      return n + catalogPaths.size;
    }, 0);
    expect(totalCatalogDescriptions).toBeGreaterThan(150);
  });
});
