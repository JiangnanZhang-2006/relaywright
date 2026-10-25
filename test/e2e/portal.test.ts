import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { BrowserSession } from '../../src/session/browser.js';
import { PageController } from '../../src/session/page.js';
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

function refsIn(snapshot: string): string[] {
  return [...snapshot.matchAll(/\[(e\d+)\]/g)].map((match) => match[1] ?? '');
}

describe.skipIf(!resolved.path)('portal tabs', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let portal = '';
  let timetable = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-portal-e2e-'));
    server = await startStatic(join(repoRoot, 'fixtures'));
    portal = `http://127.0.0.1:${server.port}/zf-mock/v1/portal.html`;
    timetable = `http://127.0.0.1:${server.port}/zf-mock/v1/index.html`;
    session = new BrowserSession();
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  function live(): BrowserSession {
    if (!session || !server) throw new Error('portal e2e did not start');
    return session;
  }

  async function onlyPortal(): Promise<void> {
    const browser = live();
    for (;;) {
      const listed = await browser.tabs({ action: 'list' });
      if (!('tabs' in listed) || listed.tabs.length <= 1) break;
      await browser.tabs({ action: 'close', index: listed.tabs.length });
    }
    await browser.navigate(portal);
  }

  beforeEach(async () => {
    await onlyPortal();
  });

  async function openMenu(): Promise<string> {
    const opened = await live().snapshot();
    const menu = refFor(opened.snapshot, /\[(e\d+)\] clickable "信息查询"/);
    const shown = await live().act({ action: 'click', ref: menu });
    return shown.snapshot;
  }

  it('follows a window.open click into the timetable tab', async () => {
    const menu = await openMenu();
    const link = refFor(menu, /\[(e\d+)\] link "个人课表查询"$/m);
    const jumped = await live().act({ action: 'click', ref: link });
    expect(jumped.snapshot.startsWith('(switched to new tab:')).toBe(true);
    expect(jumped.snapshot).toContain('combobox "学年"');
    expect(jumped.snapshot).toContain('tabs: 2 (active 2)');
    expect(jumped.url).toContain('gnmkdm=N2151');
  });

  it('follows a target=_blank link into the timetable tab', async () => {
    const menu = await openMenu();
    const link = refFor(menu, /\[(e\d+)\] link "个人课表查询\(新窗口\)"/);
    const jumped = await live().act({ action: 'click', ref: link });
    expect(jumped.snapshot.startsWith('(switched to new tab:')).toBe(true);
    expect(jumped.snapshot).toContain('combobox "学年"');
    expect(jumped.snapshot).toContain('tabs: 2 (active 2)');
    expect(jumped.url).toContain('gnmkdm=N2151');
  });

  it('lists, selects, and closes tabs, and rejects a ref from the other tab', async () => {
    const menu = await openMenu();
    const link = refFor(menu, /\[(e\d+)\] link "个人课表查询"$/m);
    const jumped = await live().act({ action: 'click', ref: link });
    const listed = await live().tabs({ action: 'list' });
    if (!('text' in listed)) throw new Error('expected a tab list');
    expect(listed.text).toContain('*[2]');
    expect(listed.text).toContain('[1]');
    expect(listed.tabs).toHaveLength(2);

    const selected = await live().tabs({ action: 'select', index: 1 });
    if (!('snapshot' in selected)) throw new Error('expected a snapshot');
    expect(selected.snapshot).toContain('tabs: 2 (active 1)');
    expect(selected.snapshot).toContain('教学管理信息服务平台');
    expect(selected.snapshot.startsWith('(switched')).toBe(false);

    const portalRefs = new Set(refsIn(selected.snapshot));
    const foreign = [...refsIn(jumped.snapshot)].reverse().find((ref) => ref && !portalRefs.has(ref));
    expect(foreign).toBeTruthy();
    await expect(live().act({ action: 'click', ref: foreign ?? '' })).rejects.toMatchObject({
      code: 'stale_ref',
      message: `The active tab changed. Ref ${foreign} is from a previous tab. Take a new snapshot.`,
    });

    const closed = await live().tabs({ action: 'close' });
    if (!('tabs' in closed)) throw new Error('expected a tab list');
    expect(closed.tabs).toHaveLength(1);
    expect(closed.text.startsWith('*[1]')).toBe(true);
  });

  it('snapshots a background tab without waiting on animation frames', async () => {
    // Headless Chrome often still runs requestAnimationFrame in a background tab.
    // This checks the call returns; the timeout itself is covered in test/hardening.test.ts.
    await live().tabs({ action: 'new', url: timetable });
    await live().tabs({ action: 'select', index: 1 });
    const pages = await live().openPages();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const background = pages[0];
    const front = pages[1];
    if (!background || !front) throw new Error('expected two pages');
    await front.bringToFront();
    const hidden = await PageController.attach(background);
    try {
      const started = Date.now();
      const first = await hidden.snapshot('full');
      const second = await hidden.snapshot('full');
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(first.url).toContain('portal.html');
      expect(second.url).toContain('portal.html');
    } finally {
      await hidden.dispose();
    }
  });

  it('replays a skill that opens the timetable in a new tab', async () => {
    const browser = live();
    browser.clearTrace();
    await browser.navigate(portal);
    const menu = await openMenu();
    const link = refFor(menu, /\[(e\d+)\] link "个人课表查询"$/m);
    const jumped = await browser.act({ action: 'click', ref: link });
    const year = refFor(jumped.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(jumped.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(jumped.snapshot, /\[(e\d+)\] button "查询"/);
    await browser.act({ action: 'select', ref: year, value: '2025-2026' });
    await browser.act({ action: 'select', ref: term, value: '2' });
    const clicked = await browser.act({ action: 'click', ref: search });
    if (!clicked.step) throw new Error('query click was not recorded');

    const steps = browser.trace().steps;
    const opener = steps.find((step) => step.action === 'click' && step.target?.name === '个人课表查询');
    expect(opener?.urlBefore).toContain('portal.html');
    const yearStep = steps.find((step) => step.action === 'select' && step.target?.name === '学年');
    expect(yearStep?.tabUrl).toContain('gnmkdm=N2151');

    const saved = browser.saveSkill({
      name: 'portal-timetable',
      description: '从门户打开个人课表并查询学年学期',
      params: { year: '2025-2026', term: '2' },
      checks: [
        {
          after_step: clicked.step,
          any: [
            { outcome: 'empty', when: { text_present: '尚无您的课表' }, message: '{{year}} 第{{term}}学期尚未排课' },
            { outcome: 'ok', when: { table_rows_min: 1 } },
          ],
        },
      ],
    });
    expect(saved.warnings.some((warning) => warning.includes('runs in tab') && warning.includes('gnmkdm=N2151'))).toBe(true);
    expect(saved.yaml).toContain('{{year}}');
    expect(saved.yaml).toContain('{{term}}');

    const report = await browser.runSkill('portal-timetable', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['2'] },
    });
    expect(report.exit_code).toBe(0);
    expect(report.results[0]).toMatchObject({ outcome: 'ok', params: { year: '2025-2026', term: '2' } });
    const empty = report.results[1];
    expect(empty?.outcome).toBe('empty');
    expect(empty?.params).toMatchObject({ year: '2026-2027', term: '2' });
  });
});
