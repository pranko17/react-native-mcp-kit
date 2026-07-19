// Unit coverage for the CLI arg parser and the EADDRINUSE verdict helpers —
// the ProcessRunner is stubbed, no real lsof is ever spawned.
import { describe, expect, it } from 'vitest';

import { describePortOwner, formatEaddrinuseVerdict, parseCliArgs } from '@/server/cliHelpers';
import { type ProcessResult, type ProcessRunner } from '@/server/host/processRunner';

interface RecordedCall {
  args: string[];
  command: string;
  timeoutMs?: number;
}

const processResult = (stdout: string): ProcessResult => {
  return {
    exitCode: 0,
    signal: null,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(stdout, 'utf8'),
    timedOut: false,
  };
};

// ProcessRunner stub: records every invocation and either serves canned
// stdout or rejects, per test scenario.
const createRunnerStub = (
  outcome: { reject: true } | { stdout: string }
): { calls: RecordedCall[]; runner: ProcessRunner } => {
  const calls: RecordedCall[] = [];
  const runner: ProcessRunner = (command, args, options) => {
    calls.push({ args: [...args], command, timeoutMs: options?.timeoutMs });
    if ('reject' in outcome) {
      return Promise.reject(new Error('spawn failed'));
    }
    return Promise.resolve(processResult(outcome.stdout));
  };
  return { calls, runner };
};

const LSOF_ARGS = ['-nP', '-iTCP:4310', '-sTCP:LISTEN'];

describe('parseCliArgs', () => {
  it('defaults to host enabled with no port', () => {
    expect(parseCliArgs([])).toEqual({ daemon: false, disableHost: false });
  });

  it('parses --port with a numeric value', () => {
    expect(parseCliArgs(['--port', '9000'])).toEqual({
      daemon: false,
      disableHost: false,
      port: 9000,
    });
  });

  it('parses --no-host', () => {
    expect(parseCliArgs(['--no-host'])).toEqual({ daemon: false, disableHost: true });
  });

  it('parses --port and --no-host together', () => {
    expect(parseCliArgs(['--no-host', '--port', '4310'])).toEqual({
      daemon: false,
      disableHost: true,
      port: 4310,
    });
  });

  it('leaves port undefined when --port has no value', () => {
    expect(parseCliArgs(['--port'])).toEqual({ daemon: false, disableHost: false });
  });

  it('ignores unrecognized arguments', () => {
    // --port=9000 is the unsupported equals form — falls through as garbage.
    expect(parseCliArgs(['--verbose', 'serve', '--port=9000'])).toEqual({
      daemon: false,
      disableHost: false,
    });
  });
});

describe('describePortOwner', () => {
  const LSOF_STDOUT =
    'COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME\n' +
    'node    12345   dev   23u  IPv4  0x0        0t0  TCP *:4310 (LISTEN)\n';

  it('wraps lsof output in a Held by: block', async () => {
    const { calls, runner } = createRunnerStub({ stdout: LSOF_STDOUT });
    const owner = await describePortOwner(4310, runner);
    expect(owner).toBe(`Held by:\n${LSOF_STDOUT.trim()}\n`);
    expect(calls).toEqual([{ args: LSOF_ARGS, command: 'lsof', timeoutMs: 3_000 }]);
  });

  it('returns an empty string when lsof prints nothing', async () => {
    const { runner } = createRunnerStub({ stdout: '  \n' });
    expect(await describePortOwner(4310, runner)).toBe('');
  });

  it('returns an empty string when the runner throws', async () => {
    const { calls, runner } = createRunnerStub({ reject: true });
    expect(await describePortOwner(4310, runner)).toBe('');
    expect(calls).toEqual([{ args: LSOF_ARGS, command: 'lsof', timeoutMs: 3_000 }]);
  });
});

describe('formatEaddrinuseVerdict', () => {
  it('names the port, includes the owner block, and suggests --port', () => {
    const owner = 'Held by:\nnode 12345\n';
    const verdict = formatEaddrinuseVerdict(4310, owner);
    expect(verdict).toContain('Port 4310 is already in use');
    expect(verdict).toContain(owner);
    expect(verdict).toContain('--port <number>');
  });

  it('reads cleanly with an empty owner block (lsof unavailable or silent)', () => {
    const verdict = formatEaddrinuseVerdict(4310, '');
    expect(verdict).toContain('Port 4310 is already in use');
    expect(verdict).not.toContain('Held by');
    // The advice line follows the diagnosis directly — no blank filler line
    // where the owner block would have been.
    expect(verdict).toContain('a stale process that survived a reinstall).\nKill it');
    expect(verdict).toContain('--port <number>');
  });
});
