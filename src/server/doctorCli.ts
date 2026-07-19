import { connectOrSpawnDaemon, DAEMON_LOG_PATH } from './daemonSpawn';
import { PACKAGE_VERSION } from './mcpServer';
import { type RemoteBackend, VersionMismatchError } from './remoteBackend';

const CLIENT_WAIT_MS = 6_000;
const CLIENT_POLL_MS = 500;

interface DoctorReport {
  babelPlugin: { applied: boolean | null; checked: boolean; detail: string };
  clients: {
    connected: number;
    disconnected: number;
    list: Array<{ id: string; status: string; appName?: string; platform?: string }>;
  };
  metro: { detail: string; reachable: boolean; url: string };
  ok: boolean;
  problems: string[];
  server: {
    packageVersion: string;
    pid: number;
    port: number | null;
    sessions: number;
    uptimeSec: number;
  };
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    return setTimeout(r, ms);
  });
};

const parseReport = (result: { content: Array<Record<string, unknown>> }): DoctorReport => {
  const text = (result.content[0]?.text as string | undefined) ?? '{}';
  return JSON.parse(text) as DoctorReport;
};

const mark = (state: boolean | null): string => {
  if (state === null) return '[?]';
  return state ? '[✓]' : '[✗]';
};

/** Human-readable render of a doctor report for the terminal. Pure — no I/O. */
export const formatDoctorReport = (r: DoctorReport): string => {
  // An inconclusive babel probe (null) isn't a "problem", but claiming "all
  // checks passed" while a check shows [?] would be misleading.
  const headline = r.ok
    ? r.babelPlugin.applied === null
      ? 'no problems found (some checks inconclusive)'
      : 'all checks passed'
    : `${r.problems.length} problem(s) found`;

  const lines: string[] = [];
  lines.push('');
  lines.push(`react-native-mcp-kit doctor — ${headline}`);
  lines.push('');

  const s = r.server;
  lines.push(
    `  ${mark(true)} daemon        v${s.packageVersion} · pid ${s.pid} · port ${s.port ?? '?'} · up ${s.uptimeSec}s · ${s.sessions} session(s)`
  );

  const clientLine =
    r.clients.connected > 0
      ? r.clients.list
          .map((c) => {
            return `${c.id} (${c.appName ?? '?'}, ${c.platform ?? '?'}, ${c.status})`;
          })
          .join(', ')
      : 'none connected';
  lines.push(`  ${mark(r.clients.connected > 0)} clients       ${clientLine}`);

  lines.push(`  ${mark(r.metro.reachable)} metro         ${r.metro.url} — ${r.metro.detail}`);

  lines.push(`  ${mark(r.babelPlugin.applied)} babel plugin  ${r.babelPlugin.detail}`);

  if (r.problems.length > 0) {
    lines.push('');
    lines.push('  Problems:');
    for (const p of r.problems) {
      lines.push(`    • ${p}`);
    }
  }
  lines.push('');
  return lines.join('\n');
};

export interface DoctorCliConfig {
  daemonArgs: string[];
  port: number;
}

/**
 * `--doctor` CLI: connect to the daemon (spawning one if the port is silent,
 * exactly as a session would), give a freshly-spawned daemon a short window
 * for the app to (re)connect, then run `host__doctor` and print a
 * human-readable verdict. Exit 0 when all checks pass, 1 otherwise.
 */
export async function runDoctorCli(config: DoctorCliConfig): Promise<void> {
  let backend: RemoteBackend;
  try {
    backend = await connectOrSpawnDaemon(config.port, PACKAGE_VERSION, config.daemonArgs);
  } catch (err) {
    if (err instanceof VersionMismatchError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(
        `Could not reach or start the daemon on port ${config.port} (${(err as Error).message}).\n` +
          `Daemon log: ${DAEMON_LOG_PATH}\n`
      );
    }
    process.exit(1);
  }

  // A just-spawned daemon has no app yet — the app reconnects on its own 3s
  // retry. Give it a bounded window so the report reflects a settled setup
  // instead of a transient "no client".
  const deadline = Date.now() + CLIENT_WAIT_MS;
  let report = parseReport(await backend.callTool('host__doctor', {}));
  while (report.clients.connected === 0 && Date.now() < deadline) {
    await sleep(CLIENT_POLL_MS);
    report = parseReport(await backend.callTool('host__doctor', {}));
  }

  process.stdout.write(formatDoctorReport(report));
  backend.close();
  process.exit(report.ok ? 0 : 1);
}
