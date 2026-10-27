import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { flushAudit, tailAudit } from '../../src/audit/log.js';
import { identityPath, tracesDir } from '../../src/config/paths.js';
import { BrowserSession } from '../../src/session/browser.js';
import { startStatic } from './static-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) {
  console.log('Skipping login e2e: no Chrome, Edge, or cached Chrome for Testing.');
}

function refFor(snapshot: string, pattern: RegExp): string {
  const match = snapshot.match(pattern);
  if (!match?.[1]) throw new Error(`ref not found for ${pattern}\n${snapshot}`);
  return match[1];
}

describe.skipIf(!resolved.path)('login handoff on the cas fixture', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let cas = '';
  let localLogin = '';
  let timetable = '';
  let protectedUrl = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-login-e2e-'));
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    server = await startStatic(join(repoRoot, 'fixtures'));
    cas = `http://127.0.0.1:${server.port}/cas-mock/`;
    localLogin = `${cas}login_slogin.html`;
    timetable = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
    protectedUrl = `http://127.0.0.1:${server.port}/protected/zf/`;
    session = new BrowserSession();
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  function live(): BrowserSession {
    if (!session || !server) throw new Error('login e2e did not start');
    return session;
  }

  it('splits the login methods, names the password icon, and blocks typing a password', async () => {
    const browser = live();
    const opened = await browser.navigate(cas);
    const snapshot = opened.snapshot;
    expect(snapshot).toContain('clickable "短信验证码"');
    expect(snapshot).toContain('clickable "微信扫码"');
    expect(snapshot).not.toContain('clickable "短信验证码 微信扫码"');
    expect(snapshot).toContain('link "icon: eyes-icon"');
    expect(snapshot).toContain('(login required: 统一身份认证 — ask the user with request_human; typing passwords is blocked)');
    const password = refFor(snapshot, /\[(e\d+)\] [^\n]*密码/);
    await expect(browser.act({ action: 'type', ref: password, value: 'secret-fixture' })).rejects.toMatchObject({
      code: 'human_required',
    });
    expect(browser.trace().steps.some((step) => step.action === 'type')).toBe(false);
    for (const name of readdirSync(tracesDir()).filter((file) => file.endsWith('.jsonl'))) {
      expect(readFileSync(join(tracesDir(), name), 'utf8')).not.toContain('secret-fixture');
    }
  });

  it('treats a visible text box labelled as a password as a password', async () => {
    const browser = live();
    const opened = await browser.navigate(localLogin);
    expect(opened.snapshot).toContain('(login required: 正方登录 — ask the user with request_human; typing passwords is blocked)');
    expect(opened.snapshot).toContain('[redacted]');
    expect(opened.snapshot).not.toContain('secret-fixture');
    expect(opened.snapshot).toContain('student');
    const password = refFor(opened.snapshot, /\[(e\d+)\] [^\n]*密码/);
    await expect(browser.act({ action: 'type', ref: password, value: 'secret-fixture' })).rejects.toMatchObject({
      code: 'human_required',
    });
    expect(browser.trace().steps.some((step) => step.action === 'type')).toBe(false);
  });

  it('reports needs_human without waiting when the protected page redirects to cas', async () => {
    const browser = live();
    browser.clearTrace();
    await saveTimetable(browser, timetable);
    const report = await browser.runSkill('zf-timetable', {
      params: { year: '2025-2026', term: '2' },
      startUrl: protectedUrl,
      wait_human: false,
    });
    expect(report.exit_code).toBe(20);
    expect(report.results[0]?.outcome).toBe('needs_human');
  });

  it('hands the login to a human, persists the session cookie, and revoke removes it', async () => {
    const browser = live();
    const landed = await browser.navigate(protectedUrl);
    expect(landed.url).toContain('/cas-mock/');
    await browser.requestHandoff('请登录');
    await expect(browser.snapshot()).rejects.toMatchObject({ code: 'human_in_control' });
    const pending = browser.waitHandoff(30_000);
    await playHuman(browser);
    const view = await pending;
    expect(view.state).toBe('done');
    expect(view.identity?.name).toBe('127.0.0.1');
    const raw = readFileSync(identityPath('127.0.0.1'), 'utf8');
    expect(raw).not.toContain('mocksession');
    const cookie = (await storedCookies(browser)).find((item) => item.name === 'mocksession');
    expect(cookie?.session).toBe(false);
    expect(cookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1000);
    await browser.revokeIdentity('127.0.0.1');
    expect(existsSync(identityPath('127.0.0.1'))).toBe(false);
    expect((await storedCookies(browser)).some((item) => item.name === 'mocksession')).toBe(false);
  });

  it('opens the remembered login page on the next handoff', async () => {
    const browser = live();
    await browser.navigate(localLogin);
    await browser.requestHandoff('请到统一认证登录');
    const pending = browser.waitHandoff(40_000);
    await playHumanFromLocal(browser, `${cas}?service=${encodeURIComponent(protectedUrl)}`);
    const view = await pending;
    expect(view.state).toBe('done');
    const saved = JSON.parse(readFileSync(identityPath('127.0.0.1'), 'utf8')) as { login_url?: string };
    expect(saved.login_url).toContain('/cas-mock/');
    expect(saved.login_url).toContain('service=');
    expect(saved.login_url).not.toContain('login_slogin');
    await browser.navigate(localLogin);
    await browser.requestHandoff('再次登录');
    const urls = (await browser.openPages()).map((page) => page.url());
    const current = urls.find((url) => url.includes('/cas-mock/') && !url.includes('login_slogin'));
    expect(current).toBeTruthy();
    const got = new URL(current ?? 'http://127.0.0.1/missing');
    const want = new URL(saved.login_url ?? 'http://127.0.0.1/missing');
    expect(`${got.origin}${got.pathname}`).toBe(`${want.origin}${want.pathname}`);
    expect(got.searchParams.get('service')).toBe(want.searchParams.get('service'));
    await flushAudit();
    const start = [...tailAudit(80)].reverse().find((row) => row.event === 'handoff_start');
    expect(String(start?.url)).toContain('/cas-mock/');
    expect(String(start?.url)).not.toContain('login_slogin');
    await browser.cancelHandoff();
    await browser.revokeIdentity('127.0.0.1');
  });

  it('waits for the human during skill replay and reruns the combo', async () => {
    const browser = live();
    const run = browser.runSkill('zf-timetable', {
      params: { year: '2025-2026', term: '2' },
      startUrl: protectedUrl,
      wait_human: true,
    });
    const deadline = Date.now() + 30_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const status = await browser.status();
      if (status.handoff?.state === 'waiting') {
        waiting = true;
        break;
      }
      await delay(200);
    }
    expect(waiting).toBe(true);
    await playHuman(browser);
    const report = await run;
    expect(report.exit_code).toBe(0);
    expect(report.results[0]?.outcome).toBe('ok');
  });
});

async function saveTimetable(browser: BrowserSession, timetable: string): Promise<void> {
  const opened = await browser.navigate(timetable);
  const year = refFor(opened.snapshot, /\[(e\d+)\] combobox "学年"/);
  const term = refFor(opened.snapshot, /\[(e\d+)\] combobox "学期"/);
  const search = refFor(opened.snapshot, /\[(e\d+)\] button "查询"/);
  await browser.act({ action: 'select', ref: year, value: '2025-2026' });
  await browser.act({ action: 'select', ref: term, value: '2' });
  const clicked = await browser.act({ action: 'click', ref: search });
  if (!clicked.step) throw new Error('click was not recorded');
  const saved = browser.saveSkill({
    name: 'zf-timetable',
    description: '查询指定学年学期的个人课表',
    params: { year: '2025-2026', term: '2' },
    checks: [
      {
        after_step: clicked.step,
        any: [{ outcome: 'ok', when: { text_present: '2025-2026' } }],
      },
    ],
  });
  const unexpected = saved.warnings.filter((warning) => !warning.includes('occurs in start_url'));
  if (unexpected.length > 0) throw new Error(unexpected.join('\n'));
}

async function playHuman(browser: BrowserSession): Promise<void> {
  const page = await findPage(browser, (url) => url.includes('/cas-mock/') && !url.includes('login_slogin'));
  await submitCas(page);
}

async function playHumanFromLocal(browser: BrowserSession, casLogin: string): Promise<void> {
  const page = await findPage(browser, (url) => url.includes('login_slogin'));
  await page.goto(casLogin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  // The completion poll records this page as login_url before the form is submitted.
  await delay(3_500);
  await submitCas(page);
}

async function findPage(browser: BrowserSession, match: (url: string) => boolean): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = await browser.openPages();
    const page = pages.find((item) => match(item.url()));
    if (page) return page;
    await delay(100);
  }
  throw new Error('login page did not open');
}

async function submitCas(page: Page): Promise<void> {
  // One evaluate, so a concurrent handoff poll cannot drop the keystrokes.
  await page.evaluate(() => {
    const doc = (globalThis as {
      document?: { getElementById(id: string): { value?: string; click?: () => void } | null };
    }).document;
    const user = doc?.getElementById('username');
    const pass = doc?.getElementById('password');
    const button = doc?.getElementById('login');
    if (!user || !pass || !button?.click) throw new Error('login form missing');
    user.value = 'student';
    pass.value = 'secret';
    button.click();
  });
  await page.waitForFunction(
    () => {
      const pathname = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? '';
      return !pathname.includes('/cas-mock/');
    },
    { timeout: 10_000 },
  );
}

async function storedCookies(browser: BrowserSession): Promise<{ name: string; session: boolean; expires: number }[]> {
  const pages = await browser.openPages();
  const page = pages[0];
  if (!page) throw new Error('no page');
  const cdp = await page.createCDPSession();
  try {
    const listed = await cdp.send('Storage.getCookies');
    return listed.cookies.map((cookie) => ({ name: cookie.name, session: cookie.session, expires: cookie.expires }));
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
