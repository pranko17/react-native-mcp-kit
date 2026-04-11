import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: Buffer;
  stdout: Buffer;
  timedOut: boolean;
}

export interface RunProcessOptions {
  env?: Record<string, string>;
  killSignal?: NodeJS.Signals;
  timeoutMs?: number;
}

export class ProcessNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(`Command not found: ${command}`);
    this.name = 'ProcessNotFoundError';
  }
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (command, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killSignal = options.killSignal ?? 'SIGKILL';

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(killSignal);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new ProcessNotFoundError(command));
      } else {
        reject(err);
      }
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stderr: Buffer.concat(stderrChunks),
        stdout: Buffer.concat(stdoutChunks),
        timedOut,
      });
    });
  });
};
