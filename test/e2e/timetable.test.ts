import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { BrowserSession } from '../../src/session/browser.js';
import { startStatic } from './static-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) {
  console.log(
    'Skipping browser e2e: no Chrome, Edge, or cached Chrome for Testing. Set RELAYWRIGHT_CHROME or run: relaywright browser install',
  );
}

function refFor(snapshot: string, pattern: RegExp): string {
  const match = snapshot.match(pattern);
  if (!match?.[1]) throw new Error(`ref not found for ${pattern}\n${snapshot}`);
  return match[1];
}

describe.skipIf(!resolved.path)('正方课表夹具', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let pageUrl = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-e2e-'));
    process.env.RELAYWRIGHT_HEADLESS = '1';
    server = await startStatic(join(repoRoot, 'fixtures'));
    pageUrl = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
    session = new BrowserSession();
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  function live(): BrowserSession {
    if (!session || !server) throw new Error('browser e2e did not start');
    return session;
  }

  beforeEach(async () => {
    await live().navigate(pageUrl);
  });

  it('snapshots comboboxes, nav clickables, the frame, and a redacted password', async () => {
    const page = await live().snapshot({ mode: 'full' });
    const snapshot = page.snapshot;
    expect(snapshot).toContain('combobox "学年" = "2026-2027"');
    expect(snapshot).toContain('combobox "学期" = "1"');
    for (const name of ['首页', '报名申请', '信息查询', '教学评价']) {
      expect(snapshot).toContain(`clickable "${name}"`);
    }
    expect(snapshot).toContain('button "查询"');
    expect(snapshot).toContain('--- frame "notice"');
    expect(snapshot).toContain('选课通知');
    expect(snapshot).toContain('[redacted]');
    expect(snapshot).not.toContain('secret-fixture');
    expect(snapshot).not.toContain('clickable "通知"');
    expect(snapshot).not.toContain('2010-2011');
    const linkLines = snapshot.split('\n').filter((line) => /^\[e\d+\] link /.test(line));
    expect(linkLines.some((line) => line.includes('2026-2027'))).toBe(false);
  });

  it('keeps refs stable across two full snapshots', async () => {
    const first = await live().snapshot({ mode: 'full' });
    const second = await live().snapshot({ mode: 'full' });
    expect(second.snapshot).toBe(first.snapshot);
  });

  it('selects a term and shows a course table', async () => {
    const page = await live().snapshot({ mode: 'full' });
    const year = refFor(page.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(page.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(page.snapshot, /\[(e\d+)\] button "查询"/);
    await live().act({ action: 'select', ref: year, value: '2025-2026' });
    await live().act({ action: 'select', ref: term, value: '2' });
    const queried = await live().act({ action: 'click', ref: search });
    expect(queried.snapshot).toContain('table');
    expect(queried.snapshot).toMatch(/rows=[1-9]/);
    expect(queried.snapshot).toContain('高等数学A');
  });

  it('shows the empty timetable message for a term without data', async () => {
    const page = await live().snapshot({ mode: 'full' });
    const year = refFor(page.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(page.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(page.snapshot, /\[(e\d+)\] button "查询"/);
    await live().act({ action: 'select', ref: year, value: '2026-2027' });
    await live().act({ action: 'select', ref: term, value: '2' });
    const queried = await live().act({ action: 'click', ref: search });
    expect(queried.snapshot).toContain('该学年学期尚无您的课表');
  });

  it('clicks a non-semantic nav item', async () => {
    const page = await live().snapshot({ mode: 'full' });
    const ref = refFor(page.snapshot, /\[(e\d+)\] clickable "信息查询"/);
    const clicked = await live().act({ action: 'click', ref });
    expect(clicked.snapshot).toContain('信息查询');
    expect(clicked.snapshot).toMatch(/^[+-~] /m);
  });

  it('waits for text that appears after the network settle window', async () => {
    const page = await live().snapshot({ mode: 'full' });
    const ref = refFor(page.snapshot, /\[(e\d+)\] button "异步提示"/);
    await live().act({ action: 'click', ref });
    const waited = await live().waitFor({ text: '查询已完成', timeoutMs: 5_000 });
    expect(waited.matched).toBe(true);
    const full = await live().snapshot({ mode: 'full' });
    expect(full.snapshot).toContain('查询已完成');
  });

  it('reports no_such_option and stale_ref', async () => {
    const page = await live().snapshot({ mode: 'full' });
    const year = refFor(page.snapshot, /\[(e\d+)\] combobox "学年"/);
    const refs = [...page.snapshot.matchAll(/^\[(e\d+)\]/gm)].map((match) => match[1] ?? '');
    const stale = refs[refs.length - 1];
    await expect(live().act({ action: 'select', ref: year, value: '1999-2000' })).rejects.toMatchObject({
      code: 'no_such_option',
    });
    if (!stale) throw new Error('snapshot had no refs');
    await live().navigate(`${new URL(pageUrl).origin}/zf-mock/v1/notice.html`);
    await expect(live().act({ action: 'click', ref: stale })).rejects.toMatchObject({ code: 'stale_ref' });
  });
});
