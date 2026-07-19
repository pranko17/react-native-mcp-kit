import { describe, expect, it } from 'vitest';

import { formatDoctorReport } from '@/server/doctorCli';

const baseReport = {
  babelPlugin: { applied: true, checked: true, detail: '3 fibers carry an mcpId.' },
  clients: {
    connected: 1,
    disconnected: 0,
    list: [{ appName: '21vek', id: 'ios-1', platform: 'ios', status: 'active' }],
  },
  metro: { detail: 'packager-status: running', reachable: true, url: 'http://localhost:8081' },
  ok: true,
  problems: [] as string[],
  server: { packageVersion: '5.1.0', pid: 42, port: 8347, sessions: 2, uptimeSec: 13 },
};

describe('formatDoctorReport', () => {
  it('renders an all-green report with checkmarks and no Problems section', () => {
    const out = formatDoctorReport(baseReport);
    expect(out).toContain('all checks passed');
    expect(out).toContain('[✓] daemon');
    expect(out).toContain('2 session(s)');
    expect(out).toContain('[✓] clients');
    expect(out).toContain('ios-1 (21vek, ios, active)');
    expect(out).toContain('[✓] metro');
    expect(out).toContain('[✓] babel plugin');
    expect(out).not.toContain('Problems:');
  });

  it('marks failing checks and lists problems with fixes', () => {
    const out = formatDoctorReport({
      ...baseReport,
      babelPlugin: { applied: false, checked: true, detail: 'No fiber carries an mcpId.' },
      clients: { connected: 0, disconnected: 0, list: [] },
      metro: { detail: 'connect ECONNREFUSED', reachable: false, url: 'http://localhost:8081' },
      ok: false,
      problems: ['No RN client connected. Start the dev app.', 'Metro is not reachable.'],
    });
    expect(out).toContain('2 problem(s) found');
    expect(out).toContain('[✗] clients       none connected');
    expect(out).toContain('[✗] metro');
    expect(out).toContain('[✗] babel plugin');
    expect(out).toContain('Problems:');
    expect(out).toContain('• No RN client connected. Start the dev app.');
    expect(out).toContain('• Metro is not reachable.');
  });

  it('shows the unknown marker and an honest headline when a check is inconclusive', () => {
    const out = formatDoctorReport({
      ...baseReport,
      babelPlugin: { applied: null, checked: false, detail: 'No RN client connected.' },
    });
    expect(out).toContain('[?] babel plugin');
    // ok is true (no problems) but a check is inconclusive — don't claim "all passed".
    expect(out).toContain('no problems found (some checks inconclusive)');
    expect(out).not.toContain('all checks passed');
  });
});
