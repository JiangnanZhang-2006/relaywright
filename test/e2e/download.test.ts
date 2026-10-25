import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { downloadsDir } from '../../src/config/paths.js';
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

function startsWithPdf(path: string): boolean {
  return readFileSync(path).subarray(0, 5).toString('latin1') === '%PDF-';
}

describe.skipIf(!resolved.path)('downloads and pdf', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let v1 = '';
  let downloadsPage = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-download-e2e-'));
    server = await startStatic(join(repoRoot, 'fixtures'));
    v1 = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
    downloadsPage = `http://127.0.0.1:${server.port}/downloads.html`;
    session = new BrowserSession();
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  function live(): BrowserSession {
    if (!session || !server) throw new Error('download e2e did not start');
    return session;
  }

  it('falls back when the active tab closes', async () => {
    const browser = live();
    await browser.navigate(v1);
    await browser.tabs({ action: 'close' });
    const page = await browser.snapshot({ mode: 'full' });
    expect(page.snapshot.length).toBeGreaterThan(0);
    expect(page.url).toBeTruthy();
    const listed = await browser.tabs({ action: 'list' });
    expect('text' in listed).toBe(true);
  });

  it('saves an attachment, a blob, a print request, and reports no_download', async () => {
    const browser = live();
    const opened = await browser.navigate(downloadsPage);
    const attachment = refFor(opened.snapshot, /\[(e\d+)\] link "下载附件"/);
    const blob = refFor(opened.snapshot, /\[(e\d+)\] button "下载 Blob"/);
    const print = refFor(opened.snapshot, /\[(e\d+)\] button "打印"/);
    const noop = refFor(opened.snapshot, /\[(e\d+)\] button "无操作"/);

    const saved = await browser.download({ ref: attachment, save_as: 'notes-saved.pdf', timeout_ms: 30_000 });
    const file = saved.downloads?.[0];
    if (!file) throw new Error(`attachment produced no download\n${saved.snapshot}`);
    expect(file.name).toBe('notes-saved.pdf');
    expect(file.path.startsWith(downloadsDir())).toBe(true);
    expect(startsWithPdf(file.path)).toBe(true);
    expect(saved.snapshot).toContain(`(downloaded: notes-saved.pdf`);
    expect(browser.trace().steps.at(-1)?.action).toBe('download');

    const blobbed = await browser.act({ action: 'click', ref: blob });
    const blobFile = blobbed.downloads?.[0];
    if (!blobFile) throw new Error(`blob click produced no download\n${blobbed.snapshot}`);
    expect(blobbed.snapshot).toContain('(downloaded:');
    expect(blobFile.name).toContain('blob.pdf');
    expect(startsWithPdf(blobFile.path)).toBe(true);
    expect(browser.trace().steps.at(-1)).toMatchObject({ action: 'download', suggested: 'blob.pdf' });

    const printed = await browser.act({ action: 'click', ref: print });
    expect(printed.snapshot).toContain('(print requested:');
    expect(printed.downloads).toBeUndefined();

    await expect(browser.download({ ref: noop, timeout_ms: 1500 })).rejects.toMatchObject({
      code: 'no_download',
      message: expect.stringContaining('another click'),
    });
  });

  it('prints the timetable page to a PDF', async () => {
    const browser = live();
    await browser.navigate(v1);
    const result = await browser.pdf({ save_as: 'timetable.pdf' });
    expect(result.header).toContain('个人课表查询');
    expect(result.file.name).toBe('timetable.pdf');
    expect(startsWithPdf(result.file.path)).toBe(true);
    expect(browser.trace().steps.at(-1)).toMatchObject({ action: 'pdf', value: 'timetable.pdf' });
  });

  it('captures the inline PDF from the 输出PDF dialog and stays usable', async () => {
    const browser = live();
    const opened = await browser.navigate(v1);
    const pdf = refFor(opened.snapshot, /\[(e\d+)\] button "输出PDF"/);
    const revealed = await browser.act({ action: 'click', ref: pdf });
    expect(revealed.snapshot).toContain('确定');
    const ok = refFor(revealed.snapshot, /\[(e\d+)\] button "确定"/);
    const saved = await browser.act({ action: 'click', ref: ok });
    const file = saved.downloads?.[0];
    if (!file) throw new Error(`确定 produced no download\n${saved.snapshot}`);
    expect(saved.snapshot).toContain('(downloaded:');
    expect(startsWithPdf(file.path)).toBe(true);
    const again = await browser.snapshot({ mode: 'full' });
    expect(again.snapshot.length).toBeGreaterThan(0);
    expect(again.title.length).toBeGreaterThan(0);
  });

  it('saves a parameterized PDF skill and replays the matrix', async () => {
    const browser = live();
    browser.clearTrace();
    const opened = await browser.navigate(v1);
    const year = refFor(opened.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(opened.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(opened.snapshot, /\[(e\d+)\] button "查询"/);
    const pdf = refFor(opened.snapshot, /\[(e\d+)\] button "输出PDF"/);
    await browser.act({ action: 'select', ref: year, value: '2025-2026' });
    await browser.act({ action: 'select', ref: term, value: '2' });
    const queried = await browser.act({ action: 'click', ref: search });
    if (!queried.step) throw new Error('查询 was not recorded');
    const revealed = await browser.act({ action: 'click', ref: pdf });
    const ok = refFor(revealed.snapshot, /\[(e\d+)\] button "确定"/);
    const downloaded = await browser.act({ action: 'click', ref: ok });
    if (!downloaded.downloads?.[0]) throw new Error(`skill recording missed the download\n${downloaded.snapshot}`);
    expect(browser.trace().steps.at(-1)?.action).toBe('download');

    const saved = browser.saveSkill({
      name: 'zf-pdf',
      description: '按学年学期导出课表 PDF',
      params: { year: '2025-2026', term: '2' },
      checks: [
        {
          after_step: queried.step,
          any: [
            { outcome: 'empty', when: { text_present: '尚无您的课表' }, message: '{{year}} 第{{term}}学期尚未排课' },
            { outcome: 'ok', when: { table_rows_min: 1 } },
          ],
        },
      ],
    });
    expect(saved.yaml).toContain('{{year}}-{{term}}.pdf');
    expect(saved.warnings.some((warning) => warning.includes('rewrote'))).toBe(true);

    const out = mkdtempSync(join(tmpdir(), 'relaywright-pdf-matrix-'));
    const report = await browser.runSkill('zf-pdf', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1', '2'] },
      out_dir: out,
    });
    expect(report.exit_code).toBe(0);
    expect(report.out_dir).toBe(out);
    expect(report.results.filter((result) => result.outcome === 'ok')).toHaveLength(3);
    const empty = report.results.find((result) => result.params.year === '2026-2027' && result.params.term === '2');
    expect(empty?.outcome).toBe('empty');
    expect(empty?.message).toBe('2026-2027 第2学期尚未排课');
    expect(empty?.artifacts ?? []).toEqual([]);

    const names = report.results.flatMap((result) => (result.artifacts ?? []).map((artifact) => basename(artifact.path)));
    expect(names.sort()).toEqual(['2025-2026-1.pdf', '2025-2026-2.pdf', '2026-2027-1.pdf']);
    for (const result of report.results) {
      for (const artifact of result.artifacts ?? []) {
        expect(artifact.path.startsWith(out)).toBe(true);
        expect(startsWithPdf(artifact.path)).toBe(true);
        expect(artifact.bytes).toBeGreaterThan(0);
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });
});
