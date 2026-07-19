import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consoleModule, type LogLevel } from '@/modules/console';

// The module patches the global console at import time — every test in this
// file shares that process-wide buffer, so it lives in its own vitest fork.

const ALL_LEVELS: LogLevel[] = [
  'debug',
  'error',
  'group',
  'groupCollapsed',
  'groupEnd',
  'info',
  'log',
  'trace',
  'warn',
];

const mod = consoleModule();

const call = (tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

interface ProjectedEntry {
  args: unknown[];
  id: number;
  level: string;
  timestamp: string;
  stack?: unknown;
}

const getLogs = (args: Record<string, unknown> = {}): ProjectedEntry[] => {
  return call('get_logs', args) as ProjectedEntry[];
};

beforeEach(() => {
  call('clear_logs');
});

afterEach(() => {
  consoleModule({ levels: ALL_LEVELS, maxEntries: 100, stackTrace: ['error', 'trace', 'warn'] });
  call('clear_logs');
});

describe('consoleModule capture', () => {
  it('records console calls with level, raw args, timestamp and monotonic ids', () => {
    console.log('mcp-log', 1);
    console.info('mcp-info');
    const entries = getLogs();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ args: ['mcp-log', 1], level: 'log' });
    expect(entries[1]).toMatchObject({ args: ['mcp-info'], level: 'info' });
    expect(entries[1]!.id).toBe(entries[0]!.id + 1);
    expect(new Date(entries[0]!.timestamp).toISOString()).toBe(entries[0]!.timestamp);
  });

  it('attaches stacks to warn/error/trace but not to log by default', () => {
    console.log('no-stack');
    console.warn('warn-stack');
    console.error('error-stack');
    console.trace('trace-stack');
    const entries = getLogs();
    expect(entries[0]!.stack).toBeUndefined();
    expect(entries[1]!.stack).toBeDefined();
    expect(entries[2]!.stack).toBeDefined();
    expect(entries[3]!.stack).toBeDefined();
  });

  it('records group markers structurally', () => {
    console.group('outer');
    console.log('inside');
    console.groupEnd();
    // node's console.group re-enters console.log for the label, so the exact
    // sequence differs from RN — assert the structural markers only.
    const levels = getLogs().map((e) => e.level);
    expect(levels[0]).toBe('group');
    expect(levels[levels.length - 1]).toBe('groupEnd');
    expect(getLogs({ level: 'group' })[0]).toMatchObject({ args: ['outer'] });
  });
});

describe('consoleModule get_logs', () => {
  it('filters by level', () => {
    console.log('a');
    console.warn('b');
    console.log('c');
    const entries = getLogs({ level: 'warn' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ args: ['b'], level: 'warn' });
  });

  it('collapses nested object args at the default depth and expands them on demand', () => {
    console.log({ nested: { a: 1 } });
    expect(getLogs()[0]!.args[0]).toEqual({ '${obj}': 1 });
    expect(getLogs({ depth: 5 })[0]!.args[0]).toEqual({ nested: { a: 1 } });
  });

  it('drills into an entry via path', () => {
    console.log({ nested: { a: 1 } });
    expect(call('get_logs', { path: '[0].args[0].nested.a' })).toBe(1);
  });
});

describe('consoleModule clear_logs', () => {
  it('empties the buffer but keeps the id cursor advancing', () => {
    console.log('before');
    const beforeId = getLogs()[0]!.id;
    expect(call('clear_logs')).toEqual({ success: true });
    expect(getLogs()).toEqual([]);
    console.log('after');
    const entries = getLogs();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBeGreaterThan(beforeId);
  });
});

describe('consoleModule options', () => {
  it('maxEntries trims the already-captured buffer retroactively', () => {
    console.log('one');
    console.log('two');
    console.log('three');
    consoleModule({ maxEntries: 2 });
    expect(getLogs().map((e) => e.args[0])).toEqual(['two', 'three']);
  });

  it('levels restricts which calls are captured', () => {
    consoleModule({ levels: ['error'] });
    console.log('skipped');
    console.error('kept');
    const entries = getLogs();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ args: ['kept'], level: 'error' });
  });

  it('stackTrace:false suppresses stacks; stackTrace:true captures them for every level', () => {
    consoleModule({ stackTrace: false });
    console.warn('bare');
    expect(getLogs()[0]!.stack).toBeUndefined();
    call('clear_logs');
    consoleModule({ stackTrace: true });
    console.log('traced');
    expect(getLogs()[0]!.stack).toBeDefined();
  });
});
