import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';

// The module reads global.ErrorUtils once at import time, so the fake must be
// installed before a *dynamic* import — a static import would run first. The
// console.error patch is also import-time global state, which is why this
// suite lives in its own vitest fork.

type GlobalHandler = (error: Error, isFatal: boolean) => void;

interface ProjectedError {
  id: number;
  isFatal: boolean;
  message: string;
  source: string;
  timestamp: string;
  stack?: unknown;
  stackFrames?: Array<Record<string, unknown>>;
}

const forwardedCalls: Array<{ isFatal: boolean; message: string }> = [];
let capturedHandler: GlobalHandler | undefined;
let mod: McpModule;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).ErrorUtils = {
    getGlobalHandler: (): GlobalHandler => {
      return (error, isFatal) => {
        forwardedCalls.push({ isFatal, message: error.message });
      };
    },
    setGlobalHandler: (handler: GlobalHandler) => {
      capturedHandler = handler;
    },
  };
  // Variable specifier: tsc (module node18) applies ESM resolution to literal
  // dynamic imports and rejects the extension-less path; vitest resolves the
  // alias at runtime either way.
  const modulePath = '@/modules/errors';
  const { errorsModule } = (await import(modulePath)) as {
    errorsModule: (options?: { maxEntries?: number }) => McpModule;
  };
  mod = errorsModule();
});

const call = (tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

const getErrors = (args: Record<string, unknown> = {}): ProjectedError[] => {
  return call('get_errors', args) as ProjectedError[];
};

const fireGlobalError = (
  message: string,
  { isFatal = false, stack }: { isFatal?: boolean; stack?: string } = {}
): void => {
  const error = new Error(message);
  if (stack !== undefined) error.stack = stack;
  capturedHandler!(error, isFatal);
};

const seed = (): void => {
  fireGlobalError('g-fatal', { isFatal: true });
  fireGlobalError('g-soft');
  fireGlobalError('p rejected in promise');
};

beforeEach(() => {
  call('clear_errors');
});

describe('errorsModule capture via ErrorUtils', () => {
  it('wraps the global handler and records fatal errors', () => {
    expect(capturedHandler).toBeDefined();
    fireGlobalError('fatal boom', { isFatal: true });
    const entries = getErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ isFatal: true, message: 'fatal boom', source: 'global' });
    expect(new Date(entries[0]!.timestamp).toISOString()).toBe(entries[0]!.timestamp);
  });

  it('forwards to the pre-existing global handler', () => {
    fireGlobalError('forwarded', { isFatal: true });
    expect(forwardedCalls).toContainEqual({ isFatal: true, message: 'forwarded' });
  });

  it('classifies errors mentioning "in promise" as promise-sourced', () => {
    fireGlobalError('Possible Unhandled (in promise) x');
    expect(getErrors()[0]).toMatchObject({ source: 'promise' });
  });

  it('deduplicates identical messages inside the 100ms window', () => {
    fireGlobalError('dup');
    fireGlobalError('dup');
    fireGlobalError('other');
    expect(getErrors().map((e) => e.message)).toEqual(['dup', 'other']);
  });
});

describe('errorsModule capture via console.error', () => {
  it('records error-shaped promise rejections and ignores other console.error calls', () => {
    console.error('plain string is ignored');
    console.error({ message: 'no promise marker' });
    console.error({ message: 'Unhandled (in promise) rejected', stack: 'reject@app.bundle:5:9' });
    const entries = getErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      isFatal: false,
      message: 'Unhandled (in promise) rejected',
      source: 'promise',
    });
  });
});

describe('errorsModule stack parsing', () => {
  it('parses V8-format stacks into frames', () => {
    fireGlobalError('v8', {
      stack: 'Error: v8\n    at doThing (app.js:10:5)\n    at bundle.js:22:7',
    });
    expect(getErrors()[0]!.stackFrames).toEqual([
      { column: 5, file: 'app.js', lineNumber: 10, methodName: 'doThing' },
      { column: 7, file: 'bundle.js', lineNumber: 22 },
    ]);
  });

  it('parses Hermes-format stacks into frames', () => {
    fireGlobalError('hermes', {
      stack: 'doThing@app.bundle:100:20\nmain@app.bundle:200:1',
    });
    expect(getErrors()[0]!.stackFrames).toEqual([
      { column: 20, file: 'app.bundle', lineNumber: 100, methodName: 'doThing' },
      { column: 1, file: 'app.bundle', lineNumber: 200, methodName: 'main' },
    ]);
  });
});

describe('errorsModule get_errors filters', () => {
  it('filters by source', () => {
    seed();
    expect(getErrors({ source: 'global' }).map((e) => e.message)).toEqual(['g-fatal', 'g-soft']);
    expect(getErrors({ source: 'promise' }).map((e) => e.message)).toEqual([
      'p rejected in promise',
    ]);
  });

  it('filters by fatal flag', () => {
    seed();
    expect(getErrors({ fatal: true }).map((e) => e.message)).toEqual(['g-fatal']);
    expect(getErrors({ fatal: false })).toHaveLength(2);
  });

  it('filters by since / until and ignores unparseable bounds', () => {
    seed();
    expect(getErrors({ since: '2000-01-01T00:00:00.000Z' })).toHaveLength(3);
    expect(getErrors({ since: '2100-01-01T00:00:00.000Z' })).toHaveLength(0);
    expect(getErrors({ until: '2000-01-01T00:00:00.000Z' })).toHaveLength(0);
    expect(getErrors({ until: '2100-01-01T00:00:00.000Z' })).toHaveLength(3);
    expect(getErrors({ since: 'not-a-date' })).toHaveLength(3);
  });
});

describe('errorsModule get_stats', () => {
  it('counts totals by source and fatal flag', () => {
    seed();
    expect(call('get_stats')).toEqual({
      bySource: { global: 2, promise: 1 },
      fatal: 1,
      total: 3,
    });
  });
});

describe('errorsModule clear_errors', () => {
  it('empties the buffer but ids keep growing', () => {
    fireGlobalError('first');
    const firstId = getErrors()[0]!.id;
    expect(call('clear_errors')).toEqual({ success: true });
    expect(getErrors()).toEqual([]);
    fireGlobalError('second');
    expect(getErrors()[0]!.id).toBeGreaterThan(firstId);
  });
});
