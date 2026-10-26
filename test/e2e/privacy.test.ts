import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { privacyPath, tracesDir } from '../../src/config/paths.js';
import { createApp } from '../../src/daemon/server.js';
import { BrowserSession } from '../../src/session/browser.js';
import { startStatic } from './static-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) console.log('Skipping privacy e2e: no Chrome, Edge, or cached Chrome for Testing.');

const TOKEN = 'privacy-e2e-token';
const NAME = '张三';
const OTHER = '李四';
const TEACHER = '韩易辰';
const NICK = '小张';
const ACCOUNT = '20210001';
const STUDENT = '20219999';
const PHONE = '13800138000';
const PHONE_FULL = '１３８００１３８０００';
const PHONE_SPACED = '138 0013 8000';
const EMAIL = 'li.si@example.com';
const ID18 = '110101199003078515';
const CARD = '4111111111111111';
const CARD_SPACED = '4111 1111 1111 1111';
const NAME_ENCODED = '%E5%BC%A0%E4%B8%89';
const NAME_ENCODED_LOWER = '%e5%bc%a0%e4%b8%89';

const SEEDS = [
  NAME,
  '张 三',
  OTHER,
  TEACHER,
  NICK,
  ACCOUNT,
  STUDENT,
  PHONE,
  PHONE_FULL,
  PHONE_SPACED,
  EMAIL,
  EMAIL.toUpperCase(),
  ID18,
  CARD,
  CARD_SPACED,
  NAME_ENCODED,
  NAME_ENCODED_LOWER,
];

function assertClean(text: string, where: string): void {
  for (const seed of SEEDS) {
    expect(text, `${where} contains ${seed}`).not.toContain(seed);
  }
}

function refFor(snapshot: string, pattern: RegExp): string {
  const match = snapshot.match(pattern);
  if (!match?.[1]) throw new Error(`ref not found for ${pattern}\n${snapshot.slice(0, 500)}`);
  return match[1];
}

describe.skipIf(!resolved.path)('privacy de-identification', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let pageUrl = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-privacy-e2e-'));
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    delete process.env.RELAYWRIGHT_PRIVACY;
    server = await startStatic(join(repoRoot, 'fixtures'));
    const url = new URL(`http://127.0.0.1:${server.port}/privacy-home/`);
    url.searchParams.set('su', ACCOUNT);
    url.searchParams.set('phone', PHONE);
    url.searchParams.set('mail', EMAIL);
    url.searchParams.set('id', ID18);
    url.searchParams.set('card', CARD);
    url.searchParams.set('who', NAME);
    url.searchParams.set('teacher', TEACHER);
    url.searchParams.set('other', OTHER);
    url.searchParams.set('sid', STUDENT);
    url.searchParams.set('nick', NICK);
    pageUrl = url.toString();
    session = new BrowserSession();
    app = createApp({ token: TOKEN, session, onShutdown: () => undefined });
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    if (!app) throw new Error('privacy e2e did not start');
    const response = await app.request(`http://127.0.0.1${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  }

  it('keeps snapshots raw in the default mode and still de-identifies saved skills', async () => {
    const opened = await call('POST', '/navigate', { url: pageUrl });
    expect(opened.status).toBe(200);
    expect(opened.text).toContain(NAME);
    expect(opened.text).toContain(PHONE);
    expect(opened.text).toContain(TEACHER);
    expect(opened.text).not.toContain('(privacy:');

    const snapshot = await call('GET', '/snapshot');
    expect(snapshot.status).toBe(200);
    expect(snapshot.text).toContain(NAME);
    expect(snapshot.text).toContain('周八');
    const openedBody = JSON.parse(snapshot.text) as { snapshot: string };
    const downloadRef = refFor(openedBody.snapshot, /\[(e\d+)\][^\n]*下载名单/);
    const downloaded = await call('POST', '/download', { ref: downloadRef, timeout_ms: 15_000 });
    expect(downloaded.status, downloaded.text.slice(0, 400)).toBe(200);

    const trace = JSON.parse((await call('GET', '/trace')).text) as { steps: { n: number }[] };
    const step = trace.steps.at(-1)?.n;
    if (!step) throw new Error('download was not recorded');
    const saved = await call('POST', '/skills/save', {
      name: 'privacy-page',
      description: '打开名单页',
      checks: [
        {
          after_step: step,
          any: [
            {
              outcome: 'ok',
              when: { text_present: `${PHONE_FULL} ${PHONE_SPACED} 张 三 ${CARD_SPACED} ${NAME_ENCODED_LOWER} ${EMAIL.toUpperCase()}` },
            },
          ],
        },
      ],
    });
    expect(saved.status, saved.text.slice(0, 500)).toBe(200);
    const body = JSON.parse(saved.text) as { path: string; yaml: string; deidentified?: { params: { name: string }[] } };
    assertClean(body.yaml, 'save response');
    assertClean(JSON.stringify(body.deidentified ?? {}), 'deidentified report');
    const yaml = readFileSync(body.path, 'utf8');
    const checksPath = join(dirname(body.path), 'checks.json');
    expect(existsSync(checksPath)).toBe(true);
    assertClean(yaml + readFileSync(checksPath, 'utf8'), 'skill files');
    expect(yaml).toContain('{{');
  });

  it('redacts every model-facing response when privacy mode is on', async () => {
    if (!session) throw new Error('privacy e2e did not start');
    session.clearTrace();
    for (const name of readdirSync(tracesDir())) {
      if (name.endsWith('.jsonl')) rmSync(join(tracesDir(), name));
    }
    const enabled = await call('POST', '/privacy/mode', { on: true });
    expect(enabled.status).toBe(200);

    const texts: string[] = [];
    const opened = await call('POST', '/navigate', { url: pageUrl });
    texts.push(opened.text);
    expect(opened.status, opened.text.slice(0, 400)).toBe(200);
    const snapshot = await call('GET', '/snapshot?mode=diff');
    texts.push(snapshot.text);

    const full = await call('GET', '/snapshot');
    texts.push(full.text);
    expect(full.text).toContain('周八');
    expect(full.text).toContain('(privacy:');
    const fullBody = JSON.parse(full.text) as { snapshot: string };
    const refresh = refFor(fullBody.snapshot, /\[(e\d+)\][^\n]*刷新/);
    const acted = await call('POST', '/act', { action: 'click', ref: refresh });
    texts.push(acted.text);
    const waited = await call('POST', '/wait', { text: '刷新', timeoutMs: 5_000 });
    texts.push(waited.text);
    const tabs = await call('GET', '/tabs');
    texts.push(tabs.text);
    const downloadRef = refFor(fullBody.snapshot, /\[(e\d+)\][^\n]*下载名单/);
    const downloaded = await call('POST', '/download', { ref: downloadRef, timeout_ms: 15_000 });
    texts.push(downloaded.text);
    const trace = await call('GET', '/trace');
    texts.push(trace.text);
    const steps = JSON.parse(trace.text) as { steps: { n: number }[] };
    const step = steps.steps.at(-1)?.n ?? steps.steps[0]?.n;
    if (!step) throw new Error(`trace missing steps\n${trace.text.slice(0, 300)}`);
    const saved = await call('POST', '/skills/save', {
      name: 'privacy-page-redacted',
      description: '打开名单页',
      checks: [{ after_step: step, any: [{ outcome: 'ok', when: { text_present: PHONE } }] }],
    });
    texts.push(saved.text);
    expect(saved.status, saved.text.slice(0, 400)).toBe(200);
    const savedBody = JSON.parse(saved.text) as { path: string; deidentified?: { params: { name: string }[] } };
    const params: Record<string, string> = {};
    const fillers = [NAME, PHONE, EMAIL, ID18, CARD, OTHER, TEACHER, ACCOUNT, STUDENT, NICK];
    for (const [index, param] of (savedBody.deidentified?.params ?? []).entries()) params[param.name] = fillers[index % fillers.length] ?? PHONE;
    const ran = await call('POST', `/skills/${encodeURIComponent('privacy-page-redacted')}/run`, { params, wait_human: false });
    texts.push(ran.text);

    const combined = texts.join('\n');
    assertClean(combined, 'model responses');
    const yaml = readFileSync(savedBody.path, 'utf8');
    const checksPath = join(dirname(savedBody.path), 'checks.json');
    assertClean(yaml + (existsSync(checksPath) ? readFileSync(checksPath, 'utf8') : ''), 'redacted skill files');
    let traces = '';
    for (const name of readdirSync(tracesDir())) {
      if (name.endsWith('.jsonl')) traces += readFileSync(join(tracesDir(), name), 'utf8');
    }
    assertClean(traces, 'trace files');
  });

  it('stores the login account without returning it', async () => {
    if (!session) throw new Error('privacy e2e did not start');
    await call('POST', '/privacy/mode', { on: false });
    const cas = `http://127.0.0.1:${server?.port}/cas-mock/?service=${encodeURIComponent(`http://127.0.0.1:${server?.port}/privacy-home/`)}`;
    const opened = await call('POST', '/navigate', { url: cas });
    expect(opened.status).toBe(200);
    const started = await call('POST', '/handoff', { reason: '请登录' });
    expect(started.status).toBe(200);
    const page = (await session.openPages()).find((item) => item.url().includes('/cas-mock/'));
    if (!page) throw new Error('login page did not open');
    await page.evaluate(() => {
      const doc = (globalThis as { document?: { getElementById(id: string): { value?: string } | null } }).document;
      const user = doc?.getElementById('username');
      if (!user) throw new Error('username missing');
      user.value = 'student';
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await page.evaluate(() => {
      const doc = (globalThis as { document?: { getElementById(id: string): { value?: string; click?: () => void } | null } }).document;
      const user = doc?.getElementById('username');
      const pass = doc?.getElementById('password');
      const button = doc?.getElementById('login');
      if (!user || !pass || !button?.click) throw new Error('login form missing');
      user.value = 'student';
      pass.value = 'secret';
      button.click();
    });
    const done = await call('POST', '/handoff/wait', { timeout_ms: 20_000 });
    expect(done.status).toBe(200);
    expect(done.text).not.toContain('student');
    expect(done.text).not.toContain('secret');
    const stored = readFileSync(privacyPath('127.0.0.1'), 'utf8');
    expect(stored).toContain('student');
    expect(stored).not.toContain('secret');
  });
});
