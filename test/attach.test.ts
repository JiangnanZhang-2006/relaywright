import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayMcpServer } from '../src/mcp/server.js';
import { daemonLogPath } from '../src/config/paths.js';
import {
  accessDialogBody,
  adoptDialogBody,
  askAccess,
  askAdopt,
  linuxAdoptArgs,
  linuxDialogArgs,
  MAC_ADOPT_SCRIPT,
  parseAdoptDecision,
  parseDecision,
  presetAccessDecision,
  presetAdoptDecision,
  sanitizeAccessReason,
  WINDOWS_ACCESS_SCRIPT,
  WINDOWS_ADOPT_SCRIPT,
} from '../src/session/access-dialog.js';
import { TabsCommandSchema } from '../src/protocol.js';
import { navigationDecision, normalizeAllowDomain } from '../src/session/allowlist.js';
import {
  devToolsClosedPortMessage,
  resolveAttachRequest,
  resolveCdpUrl,
  resolveDevToolsFile,
  shouldWarmOnStartup,
} from '../src/session/connect.js';
import { readDevToolsEndpoint } from '../src/session/launch.js';
import { reuseLiveAttach } from '../src/session/browser.js';
import { PageController } from '../src/session/page.js';
import { formatTabList, formatUserTabText, TabSet } from '../src/session/tabs.js';

const ORIGINAL_FETCH = globalThis.fetch;
const envKeys = ['RELAYWRIGHT_TEST_ACCESS_DECISION', 'RELAYWRIGHT_TEST_ADOPT_DECISION', 'RELAYWRIGHT_NOTIFY'] as const;
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
    expect(fallback).toMatchObject({
      endpointKind: 'cdp-ws',
      endpoint: 'ws://127.0.0.1:18991/devtools/browser/direct',
      cdpUrl: 'ws://127.0.0.1:18991/devtools/browser/direct',
    });
    const bare = await resolveCdpUrl('http://127.0.0.1:18991');
    expect(bare).toMatchObject({
      mode: 'cdp',
      endpointKind: 'cdp-ws',
      endpoint: 'ws://127.0.0.1:18991/devtools/browser',
      cdpUrl: 'ws://127.0.0.1:18991/devtools/browser',
    });
    expect(bare.endpoint).not.toContain('--user-data-dir');
    expect(await resolveCdpUrl('ws://127.0.0.1:18991/devtools/browser/raw')).toMatchObject({ endpointKind: 'cdp-ws' });
    const secure = await resolveCdpUrl('https://127.0.0.1:18991');
    expect(secure.endpoint).toBe('wss://127.0.0.1:18991/devtools/browser');
  });

  it('falls back to port 9222 when auto cannot read DevToolsActivePort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-devtools-missing-'));
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response('', { status: 404 });
    };
    const resolved = await resolveDevToolsFile(dir, { portOpen: async (port) => port === 9222 });
    expect(calls.some((call) => call.includes('127.0.0.1:9222/json/version'))).toBe(true);
    expect(resolved).toMatchObject({
      mode: 'cdp',
      endpointKind: 'cdp-ws',
      endpoint: 'ws://127.0.0.1:9222/devtools/browser',
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser',
      inspectFallback: { read: 'missing', profileDir: dir, port: 9222 },
    });
  });

  it('names a permission failure and still uses the inspect port when it is open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rw-devtools-denied-'));
    const dir = join(root, 'profile');
    mkdirSync(dir);
    writeFileSync(join(dir, 'DevToolsActivePort'), '18999\n/devtools/browser/secret\n', 'utf8');
    chmodSync(dir, 0);
    try {
      expect(readDevToolsEndpoint(dir)).toMatchObject({ kind: 'denied' });
      globalThis.fetch = async () => new Response('', { status: 404 });
      const open = await resolveDevToolsFile(dir, { portOpen: async () => true });
      expect(open.endpoint).toBe('ws://127.0.0.1:9222/devtools/browser');
      expect(open.cdpUrl).toBe(open.endpoint);
      expect(open.inspectFallback?.read).toBe('denied');
      await expect(resolveDevToolsFile(dir, { portOpen: async () => false })).rejects.toMatchObject({ code: 'attach_failed' });
      try {
        await resolveDevToolsFile(dir, { portOpen: async () => false });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        expect(message).toMatch(/EPERM|EACCES/);
        expect(message).toContain('no permission to read Chrome\'s configuration folder');
        expect(message).toContain('cdp_url ws://127.0.0.1:9222/devtools/browser');
        expect(message).not.toContain('chrome://inspect');
        expect(message).not.toContain('--user-data-dir');
      }
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('tells a missing profile to allow remote debugging when port 9222 is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-devtools-closed-'));
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };
    await expect(resolveDevToolsFile(dir, { port: 9, portOpen: async () => false })).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging/);
    const message = devToolsClosedPortMessage({ read: 'denied', code: 'EPERM', profileDir: dir, port: 9222 });
    expect(message).toContain('EPERM');
    expect(message).not.toContain('chrome://inspect');
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

  it('adopts a user tab through browser_tabs, which asks the person to confirm', async () => {
    const { toolNames } = createRelayMcpServer();
    expect(toolNames).toContain('browser_attach');
    expect(toolNames).toContain('browser_tabs');
    expect(toolNames).toContain('browser_detach');
    expect(toolNames).toContain('browser_request_access');
    expect(toolNames.some((name) => name === 'browser_adopt' || name.endsWith('_adopt'))).toBe(false);
    expect(TabsCommandSchema.safeParse({ action: 'user' }).success).toBe(true);
    expect(TabsCommandSchema.safeParse({ action: 'adopt' }).success).toBe(false);
    expect(TabsCommandSchema.safeParse({ action: 'adopt', index: 2 }).success).toBe(true);
    expect(WINDOWS_ADOPT_SCRIPT).toContain('RW_ADOPT_TITLE');
    expect(WINDOWS_ADOPT_SCRIPT).toContain('允许');
    expect(WINDOWS_ADOPT_SCRIPT).toContain('拒绝');
    expect(WINDOWS_ADOPT_SCRIPT).not.toContain('${');
    expect(MAC_ADOPT_SCRIPT).not.toContain('${');
    expect(linuxAdoptArgs('title', 'https://example.test')).toContain('--no-markup');
    const body = adoptDialogBody(`hello\u0007\n${'x'.repeat(200)}`, 'https://example.test/a');
    expect(body.split('\n')).toHaveLength(2);
    expect(body).not.toContain('\u0007');
    expect([...((body.split('\n')[0] ?? ''))].length).toBeLessThanOrEqual(120);
    process.env.RELAYWRIGHT_TEST_ADOPT_DECISION = 'allow';
    expect(await askAdopt('华为 ICT', 'https://example.test')).toBe('allow');
    expect(parseAdoptDecision('noise\ndeny\nallow\n')).toBe('allow');
    process.env.RELAYWRIGHT_NOTIFY = '0';
    delete process.env.RELAYWRIGHT_TEST_ADOPT_DECISION;
    expect(presetAdoptDecision()).toBe('deny');
  });

  it('reuses a live attach only when the endpoint is unchanged', () => {
    const live = { connection: 'attached' as const, connected: true, endpoint: 'ws://127.0.0.1:9222/devtools/browser/abc' };
    expect(reuseLiveAttach(live, live.endpoint)).toBe(true);
    expect(reuseLiveAttach(live, 'ws://127.0.0.1:9222/devtools/browser/other')).toBe(false);
    expect(reuseLiveAttach({ ...live, connected: false }, live.endpoint)).toBe(false);
    expect(reuseLiveAttach({ ...live, connection: 'own' }, live.endpoint)).toBe(false);
    expect(reuseLiveAttach({ ...live, endpoint: '' }, '')).toBe(false);
  });
});

describe('adopted tabs', () => {
  it('names adopted tabs and keeps the empty user-tab sentence', () => {
    expect(formatTabList([{ index: 1, title: 'ICT大赛', url: 'https://example.test/c', active: true, adopted: true }])).toBe(
      '*[1] ICT大赛 (adopted)  https://example.test/c',
    );
    expect(formatUserTabText('(no tabs)', 0, 0)).toBe('No user tabs. Tabs relaywright opened are listed with action=list.');
    expect(formatUserTabText('[1] other  https://example.test/o', 1, 2)).toBe(
      '[1] other  https://example.test/o\nAlready adopted: 2 tab(s), shown by action=list.',
    );
    expect(formatUserTabText('(no tabs)', 0, 1)).toBe(
      'No user tabs. Tabs relaywright opened are listed with action=list.\nAlready adopted: 1 tab(s), shown by action=list.',
    );
  });

  it('closes a popup from an adopted tab and leaves the profile tab open', async () => {
    const attach = vi.spyOn(PageController, 'attach').mockImplementation(async () => {
      return { forgetBaseline() {}, async dispose() {}, hasRef: () => false } as unknown as PageController;
    });
    const browser = new FakeBrowser();
    const tabs = new TabSet(browser as unknown as Browser, { scope: 'owned' });
    try {
      await tabs.start();
      const userTarget = new FakeTarget();
      const user = new FakePage(userTarget, 'https://example.test/competition', 'ICT大赛');
      browser.pagesList.push(user);
      await tabs.adopt(1);
      expect(tabs.adoptedCount()).toBe(1);
      const adopted = await tabs.describe();
      expect(adopted.find((tab) => tab.title === 'ICT大赛')).toMatchObject({ adopted: true });
      const userIndex = adopted.find((tab) => tab.title === 'ICT大赛')?.index;
      await expect(tabs.closeIndex(userIndex)).rejects.toMatchObject({
        code: 'bad_request',
        message: 'That tab belongs to the browser profile. relaywright only closes tabs it opened.',
      });

      const popupTarget = new FakeTarget(userTarget);
      browser.pagesList.push(new FakePage(popupTarget, 'https://example.test/problems', 'problems'));
      browser.emit('targetcreated', popupTarget);
      const popup = await waitForTab(tabs, 'problems');
      expect(popup.adopted).toBeUndefined();
      expect(tabs.adoptedCount()).toBe(1);
      await tabs.closeIndex(popup.index);
      expect((await tabs.describe()).some((tab) => tab.title === 'problems')).toBe(false);
      expect((await tabs.describe()).some((tab) => tab.title === 'ICT大赛' && tab.adopted)).toBe(true);
    } finally {
      await tabs.dispose();
      attach.mockRestore();
    }
  });
});

class FakeTarget {
  pageObj: FakePage | null = null;

  constructor(private readonly openerTarget?: FakeTarget) {}

  type(): string {
    return 'page';
  }

  async page(): Promise<FakePage | null> {
    return this.pageObj;
  }

  opener(): FakeTarget | undefined {
    return this.openerTarget;
  }
}

class FakePage {
  closed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(
    readonly targetRef: FakeTarget,
    private readonly pageUrl: string,
    private readonly pageTitle: string,
  ) {
    targetRef.pageObj = this;
  }

  isClosed(): boolean {
    return this.closed;
  }

  url(): string {
    return this.pageUrl;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  target(): FakeTarget {
    return this.targetRef;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  off(): void {}

  async bringToFront(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }

  async evaluate(): Promise<string> {
    return 'complete';
  }
}

class FakeBrowser {
  pagesList: FakePage[] = [];
  private readonly listeners = new Map<string, Array<(target: FakeTarget) => void>>();

  on(event: string, cb: (target: FakeTarget) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }

  off(event: string, cb: (target: FakeTarget) => void): this {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter((item) => item !== cb));
    return this;
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage(new FakeTarget(), 'about:blank', '');
    this.pagesList.push(page);
    return page;
  }

  async pages(): Promise<FakePage[]> {
    return this.pagesList.filter((page) => !page.closed);
  }

  emit(event: string, target: FakeTarget): void {
    for (const cb of this.listeners.get(event) ?? []) cb(target);
  }
}

async function waitForTab(tabs: TabSet, title: string): Promise<{ index: number; adopted?: boolean }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = (await tabs.describe()).find((tab) => tab.title === title);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`tab ${title} did not appear`);
}
