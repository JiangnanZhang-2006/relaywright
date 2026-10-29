import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelayMcpServer } from '../src/mcp/server.js';
import { daemonLogPath } from '../src/config/paths.js';
import {
  accessDialogBody,
  askAccess,
  linuxDialogArgs,
  parseDecision,
  presetAccessDecision,
  sanitizeAccessReason,
  WINDOWS_ACCESS_SCRIPT,
} from '../src/session/access-dialog.js';
import { navigationDecision, normalizeAllowDomain } from '../src/session/allowlist.js';
import { resolveAttachRequest, resolveCdpUrl, shouldWarmOnStartup } from '../src/session/connect.js';

const ORIGINAL_FETCH = globalThis.fetch;
const envKeys = ['RELAYWRIGHT_TEST_ACCESS_DECISION', 'RELAYWRIGHT_NOTIFY'] as const;
const saved = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of envKeys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('attach policy', () => {
  it('allows every site in separate mode until a list exists, and blocks daily until granted', () => {
    expect(navigationDecision('https://example.com/a', 'separate', [], []).ok).toBe(true);
    expect(navigationDecision('about:blank', 'daily', [], []).ok).toBe(true);
    expect(navigationDecision('https://www.example.com/a', 'daily', [], [])).toEqual({ ok: false, domain: 'example.com' });
    expect(navigationDecision('https://www.example.com/a', 'daily', ['example.com'], []).ok).toBe(true);
    expect(navigationDecision('https://mail.tsinghua.edu.cn/', 'daily', ['tsinghua.edu.cn'], []).ok).toBe(true);
    expect(navigationDecision('http://127.0.0.1/item', 'daily', [], ['127.0.0.1']).ok).toBe(true);
    expect(navigationDecision('https://www.example.com/a', 'separate', ['example.com'], []).ok).toBe(true);
    expect(normalizeAllowDomain('HTTPS://WWW.Example.com/path')).toBe('example.com');
  });

  it('reads the DevTools file without calling /json/version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-devtools-'));
    writeFileSync(join(dir, 'DevToolsActivePort'), '18999\n/devtools/browser/abc\n', 'utf8');
    globalThis.fetch = async () => {
      throw new Error('fetch called');
    };
    const resolved = await resolveAttachRequest({ userDataDir: dir });
    expect(resolved).toMatchObject({
      mode: 'daily',
      endpointKind: 'devtools-file',
      endpoint: 'ws://127.0.0.1:18999/devtools/browser/abc',
    });
  });

  it('uses /json/version for an http cdp url and falls back to a devtools path', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:18991/devtools/browser/from-json' }), { status: 200 });
    };
    const http = await resolveCdpUrl('http://127.0.0.1:18991');
    expect(http.endpointKind).toBe('cdp-http');
    expect(http.endpoint).toContain('/devtools/browser/from-json');
    expect(calls[0]).toContain('/json/version');

    globalThis.fetch = async () => new Response('nope', { status: 404 });
    const fallback = await resolveCdpUrl('http://127.0.0.1:18991/devtools/browser/direct');
    expect(fallback).toMatchObject({ endpointKind: 'cdp-ws', endpoint: 'ws://127.0.0.1:18991/devtools/browser/direct' });
    await expect(resolveCdpUrl('http://127.0.0.1:18991')).rejects.toMatchObject({ code: 'attach_failed' });
    expect(await resolveCdpUrl('ws://127.0.0.1:18991/devtools/browser/raw')).toMatchObject({ endpointKind: 'cdp-ws' });
  });

  it('keeps startup lazy unless reconnect is eager', () => {
    expect(shouldWarmOnStartup({})).toBe(true);
    expect(shouldWarmOnStartup({ browser: { mode: 'daily' } })).toBe(false);
    expect(shouldWarmOnStartup({ browser: { mode: 'cdp' }, attach: { reconnect: 'eager' } })).toBe(true);
  });

  it('takes the test decision and never interpolates the domain into the dialog script', async () => {
    expect(WINDOWS_ACCESS_SCRIPT).toContain('TopMost');
    expect(WINDOWS_ACCESS_SCRIPT).toContain('本次允许');
    expect(WINDOWS_ACCESS_SCRIPT).toContain('始终允许');
    expect(WINDOWS_ACCESS_SCRIPT).toContain('拒绝');
    expect(WINDOWS_ACCESS_SCRIPT).toContain('RW_ACCESS_DOMAIN');
    expect(WINDOWS_ACCESS_SCRIPT).not.toContain('${');
    process.env.RELAYWRIGHT_NOTIFY = '0';
    delete process.env.RELAYWRIGHT_TEST_ACCESS_DECISION;
    expect(presetAccessDecision()).toBe('deny');
    process.env.RELAYWRIGHT_TEST_ACCESS_DECISION = 'always';
    expect(await askAccess('example.com', 'reason')).toBe('always');
    expect(parseDecision('noise\nonce\n')).toBe('once');
  });

  it('keeps the domain first and shortens the reason', () => {
    const noisy = `please <b>allow</b>\u0007\n${'x'.repeat(80)}\n${'y'.repeat(80)}\n${'z'.repeat(80)}\nextra line\n`;
    const reason = sanitizeAccessReason(noisy);
    expect(reason).not.toContain('\u0007');
    expect(reason.split('\n')).toHaveLength(4);
    expect([...reason].length).toBeLessThanOrEqual(200);
    expect(reason.startsWith('please <b>allow</b>')).toBe(true);
    expect(reason).not.toContain('extra line');
    const body = accessDialogBody('example.com\nspoof.test', `ignore\n${'a'.repeat(300)}`);
    expect(body.split('\n')[0]).toBe('example.comspoof.test');
    expect(body.startsWith('example.comspoof.test\nignore')).toBe(true);
    expect([...body.split('\n')[1] ?? ''].length).toBeLessThanOrEqual(200);
    const args = linuxDialogArgs('example.com', '<span foreground="red">allow</span>');
    expect(args).toContain('--no-markup');
    const text = args[args.indexOf('--text') + 1];
    expect(text?.startsWith('example.com\n')).toBe(true);
    expect(WINDOWS_ACCESS_SCRIPT).toMatch(/\$label\.Text = "\$domain/);
  });

  it('ignores the access override unless the process is a test', () => {
    const previous = {
      vitest: process.env.VITEST,
      nodeEnv: process.env.NODE_ENV,
      notify: process.env.RELAYWRIGHT_NOTIFY,
      decision: process.env.RELAYWRIGHT_TEST_ACCESS_DECISION,
    };
    const before = existsSync(daemonLogPath()) ? readFileSync(daemonLogPath(), 'utf8') : '';
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    delete process.env.RELAYWRIGHT_NOTIFY;
    process.env.RELAYWRIGHT_TEST_ACCESS_DECISION = 'always';
    try {
      expect(presetAccessDecision()).toBeNull();
      expect(presetAccessDecision()).toBeNull();
      const added = readFileSync(daemonLogPath(), 'utf8').slice(before.length);
      expect(added.split('ignoring RELAYWRIGHT_TEST_ACCESS_DECISION').length - 1).toBe(1);
    } finally {
      if (previous.vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous.vitest;
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.notify === undefined) delete process.env.RELAYWRIGHT_NOTIFY;
      else process.env.RELAYWRIGHT_NOTIFY = previous.notify;
      if (previous.decision === undefined) delete process.env.RELAYWRIGHT_TEST_ACCESS_DECISION;
      else process.env.RELAYWRIGHT_TEST_ACCESS_DECISION = previous.decision;
    }
  });

  it('does not register a tool that can adopt a user tab', () => {
    const { toolNames } = createRelayMcpServer();
    expect(toolNames).toContain('browser_attach');
    expect(toolNames).toContain('browser_detach');
    expect(toolNames).toContain('browser_request_access');
    expect(toolNames.some((name) => name.includes('adopt'))).toBe(false);
  });
});
