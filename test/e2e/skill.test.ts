import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { tracesDir } from '../../src/config/paths.js';
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

describe.skipIf(!resolved.path)('skill replay on the timetable fixture', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let v1 = '';
  let v2 = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-skill-e2e-'));
    process.env.RELAYWRIGHT_HEADLESS = '1';
    server = await startStatic(join(repoRoot, 'fixtures'));
    v1 = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
    v2 = `http://127.0.0.1:${server.port}/zf-mock/v2/`;
    session = new BrowserSession();
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  function live(): BrowserSession {
    if (!session || !server) throw new Error('skill e2e did not start');
    return session;
  }

  it('saves a timetable skill, replays the matrix, and breaks on v2', async () => {
    const browser = live();
    const opened = await browser.navigate(v1);
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
          any: [
            { outcome: 'empty', when: { text_present: '尚无您的课表' }, message: '{{year}} 第{{term}}学期尚未排课' },
            { outcome: 'ok', when: { table_rows_min: 1 } },
          ],
        },
      ],
    });
    expect(saved.warnings).toEqual([]);
    expect(saved.yaml).toContain('#xnm');
    expect(saved.yaml).toContain('#xqm');
    expect(saved.yaml).toContain('#search_go');
    expect(saved.yaml).toContain('{{year}}');
    expect(saved.yaml).toContain('{{term}}');
    expect(saved.yaml).not.toContain('2031-2032');
    expect(saved.yaml).not.toContain('---请选择---');

    const before = browser.trace().steps.length;
    const report = await browser.runSkill('zf-timetable', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1', '2'] },
    });
    expect(browser.trace().steps.length).toBe(before);
    expect(report.exit_code).toBe(0);
    expect(report.results.filter((result) => result.outcome === 'ok')).toHaveLength(3);
    const empty = report.results.find((result) => result.params.year === '2026-2027' && result.params.term === '2');
    expect(empty?.outcome).toBe('empty');
    expect(empty?.message).toBe('2026-2027 第2学期尚未排课');

    const broken = await browser.runSkill('zf-timetable', {
      params: { year: '2025-2026', term: '2' },
      startUrl: v2,
    });
    expect(browser.trace().steps.length).toBe(before);
    expect(broken.exit_code).toBe(30);
    const run = broken.results[0];
    expect(run?.outcome).toBe('broken');
    expect(run?.broken?.reason).toBe('target_not_found');
    expect(run?.broken?.step_id).toContain('click');
    const yearStep = run?.steps.find((step) => step.id.includes('学年'));
    expect(yearStep).toMatchObject({ status: 'done', locator: 'css' });
  });

  it('does not write the password literal into the trace', async () => {
    const browser = live();
    browser.clearTrace();
    const opened = await browser.navigate(v1);
    const password = refFor(opened.snapshot, /\[(e\d+)\] [^\n]*密码/);
    await browser.act({ action: 'type', ref: password, value: 'secret-fixture' });
    const typed = browser.trace().steps.find((step) => step.action === 'type');
    expect(typed?.value).toBe('{{secret}}');
    const files = readdirSync(tracesDir()).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(readFileSync(join(tracesDir(), name), 'utf8')).not.toContain('secret-fixture');
    }
  });
});
