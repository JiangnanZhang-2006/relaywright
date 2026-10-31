import { describe, expect, it } from 'vitest';
import { explainDaemonError, formatBuildMismatch, type BuildFingerprint } from '../src/daemon/build.js';
import { staleTabRefMessage } from '../src/errors.js';
import { appendDaemonWarning, resetDaemonWarningForTests } from '../src/mcp/server.js';
import { pageHeader } from '../src/perception/snapshot.js';
import { runPaint } from '../src/session/timeout.js';

const here: BuildFingerprint = { entry: 'C:\\relaywright\\dist\\daemon\\main.js', builtAt: '2026-10-22T02:00:00.000Z' };
const other: BuildFingerprint = { entry: 'C:\\relaywright-verify\\dist\\daemon\\main.js', builtAt: '2026-10-21T02:00:00.000Z' };

describe('build fingerprint', () => {
  it('warns when the running daemon was built from somewhere else', () => {
    expect(formatBuildMismatch(here, here, here)).toBeNull();
    expect(formatBuildMismatch(here, other, other)).toBe(
      `relaywright: warning: running daemon is from ${other.entry} (built ${other.builtAt}); this CLI is ${here.entry} (built ${here.builtAt}). Run: relaywright daemon restart`,
    );
    const rebuilt: BuildFingerprint = { entry: here.entry, builtAt: '2026-10-30T09:14:02.000Z' };
    expect(formatBuildMismatch(rebuilt, here, here)).toBe(
      `relaywright: warning: running daemon is from ${here.entry} (built ${here.builtAt}); this CLI is ${rebuilt.entry} (built ${rebuilt.builtAt}). Run: relaywright daemon restart`,
    );
    expect(formatBuildMismatch(here, here, other)).toContain(`this CLI is ${here.entry} (built ${here.builtAt})`);
    expect(formatBuildMismatch(here)).toBe(
      `relaywright: warning: running daemon did not report a build fingerprint; this CLI is ${here.entry}. Run: relaywright daemon restart`,
    );
  });

  it('attaches a mismatch line to the first tool result only', () => {
    resetDaemonWarningForTests();
    const warning =
      'relaywright: warning: running daemon is from a (built 1); this CLI is a (built 2). Run: relaywright daemon restart';
    expect(appendDaemonWarning(`seen\n${warning}`, warning)).toBe(`seen\n${warning}`);
    expect(appendDaemonWarning('page', warning)).toBe(`page\n${warning}`);
    expect(appendDaemonWarning('page', warning)).toBe('page');
    expect(appendDaemonWarning('page', null)).toBe('page');
    const next = warning.replace('built 2', 'built 3');
    expect(appendDaemonWarning('page', next)).toBe(`page\n${next}`);
    expect(appendDaemonWarning('page', next)).toBe('page');
    resetDaemonWarningForTests();
  });

  it('mentions a fingerprint mismatch only for a missing route', () => {
    const warning = 'relaywright: warning: running daemon is from elsewhere';
    expect(explainDaemonError('not_found: No route for GET /tabs', 404, 'not_found', warning)).toBe(
      `not_found: No route for GET /tabs\n${warning}`,
    );
    expect(explainDaemonError('skill_not_found: missing', 404, 'skill_not_found', warning)).toBe('skill_not_found: missing');
    expect(explainDaemonError('not_found: No route for GET /tabs', 404, 'not_found', null)).toBe('not_found: No route for GET /tabs');
  });
});

describe('paint timeout', () => {
  it('gives up when animation frames never run', async () => {
    const started = Date.now();
    await runPaint(() => new Promise(() => undefined), 300);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('tab snapshot text', () => {
  it('adds the tab count only when more than one tab is open', () => {
    expect(pageHeader('个人课表查询', 'http://127.0.0.1/a')).toBe('page: 个人课表查询  url: http://127.0.0.1/a');
    expect(pageHeader('个人课表查询', 'http://127.0.0.1/a', { count: 1, active: 1 })).toBe(
      'page: 个人课表查询  url: http://127.0.0.1/a',
    );
    expect(pageHeader('个人课表查询', 'http://127.0.0.1/a', { count: 2, active: 2 })).toBe(
      'page: 个人课表查询  url: http://127.0.0.1/a  tabs: 2 (active 2)',
    );
  });

  it('tells the caller to snapshot again after the active tab changes', () => {
    expect(staleTabRefMessage('e12')).toBe('The active tab changed. Ref e12 is from a previous tab. Take a new snapshot.');
  });
});
