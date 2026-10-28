import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushAudit, hashRecord, readAuditRecords, recordAudit, verifyAudit } from '../src/audit/log.js';
import { auditDir, identitiesDir } from '../src/config/paths.js';
import { WINDOWS_NOTIFY_SCRIPT, windowsToastXml } from '../src/notify.js';
import { splitPointerSiblings, type PointerNode } from '../src/perception/clickable-split.js';
import { fallbackControlName } from '../src/perception/names.js';
import { looksLikePassword } from '../src/perception/password-like.js';
import { cookieInDomains, deleteCookieParams, persistentCookieParams, type StoredCookie } from '../src/session/cookies.js';
import { registrableDomain } from '../src/session/domain.js';
import { IdentityStore } from '../src/session/identity.js';
import { chromeLaunchArgs } from '../src/session/launch.js';
import { handoffStartUrl, pageNeedsLogin } from '../src/session/login.js';
import { restoredWindowState } from '../src/session/window.js';

const GENESIS = '0'.repeat(64);

describe('registrable domains', () => {
  it('keeps the public suffix with the registered label', () => {
    expect(registrableDomain('jwxt.wzu.edu.cn')).toBe('wzu.edu.cn');
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
    expect(registrableDomain('www.cam.ac.uk')).toBe('cam.ac.uk');
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(registrableDomain('[::1]')).toBe('::1');
  });
});

describe('session cookies', () => {
  const now = 1_700_000_000;

  it('converts a host-only session cookie with a url and leaves persistent cookies alone', () => {
    const hostOnly = cookie({ domain: '127.0.0.1', session: true });
    const params = persistentCookieParams(hostOnly, now, 7);
    expect(params?.url).toBe('http://127.0.0.1/');
    expect(params?.domain).toBeUndefined();
    expect(params?.expires).toBe(now + 7 * 24 * 60 * 60);
    expect(params?.name).toBe('mocksession');

    const shared = persistentCookieParams(cookie({ domain: '.wzu.edu.cn', session: true, secure: true }), now, 7);
    expect(shared?.domain).toBe('.wzu.edu.cn');
    expect(shared?.url).toBeUndefined();
    expect(shared?.secure).toBe(true);

    expect(persistentCookieParams(cookie({ domain: '127.0.0.1', session: false }), now, 7)).toBeNull();
  });

  it('keeps the https source of a non-Secure host-only cookie', () => {
    const params = persistentCookieParams(
      cookie({ domain: 'jwxt.wzu.edu.cn', session: true, secure: false, sourceScheme: 'Secure', sourcePort: 443 }),
      now,
      7,
    );
    expect(params?.url).toBe('https://jwxt.wzu.edu.cn/');
    expect(params?.sourceScheme).toBe('Secure');
    expect(params?.sourcePort).toBe(443);
    expect(deleteCookieParams(cookie({ domain: 'jwxt.wzu.edu.cn', session: true, secure: false, sourceScheme: 'Secure' })).url).toBe(
      'https://jwxt.wzu.edu.cn/',
    );

    expect(
      persistentCookieParams(
        cookie({ domain: 'jwxt.wzu.edu.cn', session: true, sourceScheme: 'Secure', partitionKey: { topLevelSite: 'https://jwxt.wzu.edu.cn' } }),
        now,
        7,
      ),
    ).toBeNull();

    const port = persistentCookieParams(
      cookie({ domain: 'jwxt.wzu.edu.cn', session: true, secure: false, sourceScheme: 'Secure', sourcePort: 8443 }),
      now,
      7,
    );
    expect(port?.url).toBe('https://jwxt.wzu.edu.cn:8443/');
  });

  it('matches a cookie domain to an identity domain', () => {
    expect(cookieInDomains('.jwxt.wzu.edu.cn', ['wzu.edu.cn'])).toBe(true);
    expect(cookieInDomains('127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(cookieInDomains('evilwzu.edu.cn', ['wzu.edu.cn'])).toBe(false);
  });
});

describe('audit chain', () => {
  it('strips query strings, links monthly files, and reports the first tampered line', async () => {
    const dir = auditDir();
    mkdirSync(dir, { recursive: true });
    recordAudit('password_blocked', { action: 'type', url: 'https://example.com/cas?token=secret-value' });
    await flushAudit();
    const hit = readAuditRecords()
      .map((item) => item.record)
      .find((record) => record.event === 'password_blocked');
    expect(JSON.stringify(hit)).toContain('https://example.com/cas');
    expect(JSON.stringify(hit)).not.toContain('secret-value');
    for (const item of readAuditRecords()) rmSync(item.file, { force: true });

    const older = join(dir, '1999-01.jsonl');
    const newer = join(dir, '1999-02.jsonl');
    const first = auditLine(GENESIS, { event: 'handoff_start', reason: '登录' });
    const second = auditLine(JSON.parse(first).hash as string, { event: 'handoff_end', outcome: 'done', elapsed_ms: 12 });
    writeFileSync(older, `${first}\n`, 'utf8');
    writeFileSync(newer, `${second}\n`, 'utf8');
    try {
      expect(verifyAudit()).toEqual({ ok: true });
      const tampered = JSON.parse(second) as { outcome: string; hash: string };
      tampered.outcome = 'cancelled';
      writeFileSync(newer, `${JSON.stringify(tampered)}\n`, 'utf8');
      const broken = verifyAudit();
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.where).toContain('1999-02.jsonl:1 hash mismatch');
    } finally {
      rmSync(older, { force: true });
      rmSync(newer, { force: true });
    }
  });
});

describe('nameless controls and pointer siblings', () => {
  it('names an icon from its class, then from the image file', () => {
    expect(fallbackControlName({ className: 'eyes-icon', imgSrc: '/public/cas-login/assets/login/password-tran.png' })).toBe('icon: eyes-icon');
    expect(fallbackControlName({ ariaLabel: '显示密码', className: 'eyes-icon' })).toBe('显示密码');
    expect(fallbackControlName({ className: 'ng-star-inserted ant-btn icon', imgSrc: '/a/password-tran.png?x=1' })).toBe('icon: password-tran');
  });

  it('splits sibling pointer rows and keeps a single icon-and-text wrapper', () => {
    const split = splitPointerSiblings(
      [
        node('box', null, ''),
        node('sms', 'box', '短信验证码'),
        node('wechat', 'box', '微信扫码'),
      ],
      'box',
    );
    expect(split).toEqual(['sms', 'wechat']);
    expect(splitPointerSiblings([node('box', null, ''), node('row', 'box', '短信验证码')], 'box')).toBeNull();
    expect(
      splitPointerSiblings(
        [node('box', null, '登录', '登录'), node('a', 'box', '短信验证码'), node('b', 'box', '微信扫码')],
        'box',
      ),
    ).toBeNull();
  });
});

describe('password-like fields', () => {
  it('matches password words and exact mm or pass on name and id', () => {
    expect(looksLikePassword({ placeholder: '密码' })).toBe(true);
    expect(looksLikePassword({ ariaLabel: '口令' })).toBe(true);
    expect(looksLikePassword({ label: 'Password' })).toBe(true);
    expect(looksLikePassword({ name: 'user_password' })).toBe(true);
    expect(looksLikePassword({ id: 'passcode' })).toBe(true);
    expect(looksLikePassword({ name: 'mm' })).toBe(true);
    expect(looksLikePassword({ id: 'MM' })).toBe(true);
    expect(looksLikePassword({ name: 'pass' })).toBe(true);
    expect(looksLikePassword({ id: 'summary' })).toBe(false);
    expect(looksLikePassword({ name: 'passenger' })).toBe(false);
    expect(looksLikePassword({ id: 'compass' })).toBe(false);
    expect(looksLikePassword({ placeholder: 'mm' })).toBe(false);
    expect(looksLikePassword({ placeholder: '用户名', name: 'yhm', id: 'yhm' })).toBe(false);
  });
});

describe('handoff start url', () => {
  const local = 'http://jwxt.example.edu/xtgl/login_slogin.html';
  const cas = 'https://source.example.edu/login?service=https%3A%2F%2Fjwxt.example.edu%2F';

  it('opens a remembered login page only when the current page is a different login document', () => {
    expect(handoffStartUrl({ currentUrl: local, loginPage: true, rememberedLoginUrl: cas })).toBe(cas);
    expect(handoffStartUrl({ currentUrl: cas, loginPage: true, rememberedLoginUrl: cas })).toBe(null);
    expect(
      handoffStartUrl({
        currentUrl: 'https://source.example.edu/login?service=other',
        loginPage: true,
        rememberedLoginUrl: cas,
      }),
    ).toBe(null);
    expect(handoffStartUrl({ currentUrl: local, loginPage: false, rememberedLoginUrl: cas })).toBe(null);
    expect(handoffStartUrl({ currentUrl: local, loginPage: true })).toBe(null);
    expect(handoffStartUrl({ currentUrl: 'https://app.example.edu/home', explicitUrl: cas, loginPage: false })).toBe(cas);
    expect(handoffStartUrl({ currentUrl: cas, explicitUrl: `${cas}#form`, loginPage: false })).toBe(null);
  });
});

describe('saved identities', () => {
  it('loads an identity file that has no login_url', () => {
    const dir = identitiesDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'legacy.example.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        name: 'legacy.example',
        domains: ['legacy.example'],
        login_hosts: ['legacy.example'],
        created_at: '2020-01-01T00:00:00.000Z',
        saved_at: '2020-01-01T00:00:00.000Z',
        last_used_at: '2020-01-01T00:00:00.000Z',
        persist_days: 7,
        cookie_count: 0,
      })}\n`,
    );
    try {
      const found = new IdentityStore(() => null).findByUrl('https://legacy.example/xtgl/login_slogin.html');
      expect(found?.name).toBe('legacy.example');
      expect(found?.login_url).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('headful window', () => {
  it('starts a fresh headful Chrome maximized and restores a maximized window after raise', () => {
    const headful = chromeLaunchArgs({ userDataDir: 'C:\\temp\\profile', headless: false });
    expect(headful).toContain('--start-maximized');
    expect(headful.some((arg) => arg.startsWith('--headless'))).toBe(false);
    const headless = chromeLaunchArgs({ userDataDir: 'C:\\temp\\profile', headless: true });
    expect(headless).not.toContain('--start-maximized');
    expect(headless).toContain('--headless=new');
    expect(headful.at(-1)).toBe('about:blank');
    expect(headless.at(-1)).toBe('about:blank');
    expect(restoredWindowState('maximized')).toBe('maximized');
    expect(restoredWindowState('fullscreen')).toBe('fullscreen');
    expect(restoredWindowState('minimized')).toBe('normal');
    expect(restoredWindowState('normal')).toBe('normal');
    expect(restoredWindowState(undefined)).toBe('normal');
  });
});

describe('windows toast', () => {
  it('builds a long toast from escaped text and keeps the script free of that text', () => {
    const xml = windowsToastXml({ title: 'relaywright 需要你登录', body: '请登录 <教务>&', detail: 'jwxt.wzu.edu.cn' });
    expect(xml.startsWith('<toast duration="long">')).toBe(true);
    expect(xml).toContain('<text>relaywright 需要你登录</text>');
    expect(xml).toContain('<text>请登录 &lt;教务&gt;&amp;</text>');
    expect(xml).toContain('<text>jwxt.wzu.edu.cn</text>');
    expect(windowsToastXml({ title: 't', body: '第一行\n第二行' })).toContain('<text>第一行&#10;第二行</text>');
    const plain = windowsToastXml({ title: '已登录', body: 'wzu.edu.cn' });
    expect(plain.match(/<text>/g)).toHaveLength(2);
    expect(WINDOWS_NOTIFY_SCRIPT).toContain('RW_NOTIFY_XML');
    expect(WINDOWS_NOTIFY_SCRIPT).toContain('SystemSounds');
    expect(WINDOWS_NOTIFY_SCRIPT).not.toContain('relaywright');
    expect(WINDOWS_NOTIFY_SCRIPT).not.toContain('${');
  });
});

describe('login gate', () => {
  const start = 'http://127.0.0.1:9/protected/zf/';

  it('treats a password on the skill document as content and a cas redirect as a gate', () => {
    expect(pageNeedsLogin('http://127.0.0.1:9/zf-mock/v1/', 'http://127.0.0.1:9/zf-mock/v1/', true)).toBe(false);
    expect(pageNeedsLogin('http://127.0.0.1:9/cas-mock/', start, true)).toBe(true);
    expect(pageNeedsLogin('http://127.0.0.1:9/protected/zf/', start, false)).toBe(false);
    expect(pageNeedsLogin('https://idp.example.edu/login', 'https://app.example.edu/home', false)).toBe(true);
  });
});

function cookie(extra: Partial<StoredCookie> & Pick<StoredCookie, 'domain' | 'session'>): StoredCookie {
  return {
    name: 'mocksession',
    value: '1',
    path: '/',
    secure: false,
    httpOnly: false,
    ...extra,
  };
}

function auditLine(prev: string, fields: Record<string, unknown>): string {
  const record = { ts: '2026-01-01T00:00:00.000Z', ...fields, prev };
  return JSON.stringify({ ...record, hash: hashRecord(prev, record) });
}

function node(id: string, parentId: string | null, innerText: string, directText = ''): PointerNode {
  return { id, parentId, visible: true, pointer: true, directText, innerText };
}
