import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { downloadsDir } from '../../src/config/paths.js';
import { BrowserSession } from '../../src/session/browser.js';
import { parseSkill } from '../../src/skills/schema.js';
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

/** Leave fileName in the downloads dir and remove "name (n).ext" so the next save is "name (1).ext". */
function occupy(fileName: string): void {
  const dir = downloadsDir();
  mkdirSync(dir, { recursive: true });
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const prefix = `${base} (`;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
    const middle = name.slice(prefix.length, name.length - ext.length);
    if (/^\d+\)$/.test(middle)) unlinkSync(join(dir, name));
  }
  writeFileSync(join(dir, fileName), 'occupied');
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
    expect(browser.trace().steps.at(-1)).toMatchObject({ action: 'download', value: 'notes-saved.pdf' });

    const blobbed = await browser.act({ action: 'click', ref: blob });
    const blobFile = blobbed.downloads?.[0];
    if (!blobFile) throw new Error(`blob click produced no download\n${blobbed.snapshot}`);
    expect(blobbed.snapshot).toContain('(downloaded:');
    expect(blobFile.name).toContain('blob.pdf');
    expect(startsWithPdf(blobFile.path)).toBe(true);
    expect(browser.trace().steps.at(-1)).toMatchObject({ action: 'download', value: 'blob.pdf', suggested: 'blob.pdf' });

    const printed = await browser.act({ action: 'click', ref: print });
    expect(printed.snapshot).toContain('(print requested:');
    expect(printed.downloads).toBeUndefined();

    await expect(browser.download({ ref: noop, timeout_ms: 1500 })).rejects.toMatchObject({
      code: 'no_download',
      message: expect.stringContaining('another click'),
    });
    expect(browser.trace().steps.at(-1)).toMatchObject({ action: 'click', target: expect.objectContaining({ name: '无操作' }) });
  });

  it('records the undeduped name when a download already exists', async () => {
    const browser = live();
    const opened = await browser.navigate(downloadsPage);
    const blob = refFor(opened.snapshot, /\[(e\d+)\] button "下载 Blob"/);
    occupy('blob.pdf');

    const clicked = await browser.act({ action: 'click', ref: blob });
    const clickedFile = clicked.downloads?.[0];
    if (!clickedFile) throw new Error(`blob click produced no download\n${clicked.snapshot}`);
    expect(clickedFile.name).toBe('blob (1).pdf');
    expect(startsWithPdf(clickedFile.path)).toBe(true);
    expect(browser.trace().steps.at(-1)?.value).toBe('blob.pdf');
    expect(browser.trace().steps.at(-1)?.suggested).toBe('blob.pdf');

    occupy('blob.pdf');
    const saved = await browser.download({ ref: blob, timeout_ms: 30_000 });
    const savedFile = saved.downloads?.[0];
    if (!savedFile) throw new Error(`blob download produced no file\n${saved.snapshot}`);
    expect(savedFile.name).toBe('blob (1).pdf');
    expect(startsWithPdf(savedFile.path)).toBe(true);
    expect(browser.trace().steps.at(-1)?.value).toBe('blob.pdf');
    expect(browser.trace().steps.at(-1)?.suggested).toBe('blob.pdf');
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

  it('records the page title when a pdf without save_as is deduped', async () => {
    const browser = live();
    await browser.navigate(v1);
    occupy('个人课表查询.pdf');
    const result = await browser.pdf({});
    expect(result.file.name).toBe('个人课表查询 (1).pdf');
    expect(startsWithPdf(result.file.path)).toBe(true);
    expect(browser.trace().steps.at(-1)).toMatchObject({ action: 'pdf', value: '个人课表查询.pdf' });
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

  it('keeps the 输出PDF click after no_download and replays the saved skill', async () => {
    const browser = live();
    browser.clearTrace();
    const opened = await browser.navigate(v1);
    const traced = browser.trace().steps.length;
    await expect(browser.download({ ref: 'e999', timeout_ms: 500 })).rejects.toMatchObject({ code: 'stale_ref' });
    expect(browser.trace().steps.length).toBe(traced);

    const year = refFor(opened.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(opened.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(opened.snapshot, /\[(e\d+)\] button "查询"/);
    const pdf = refFor(opened.snapshot, /\[(e\d+)\] button "输出PDF"/);
    await browser.act({ action: 'select', ref: year, value: '2025-2026' });
    await browser.act({ action: 'select', ref: term, value: '1' });
    await browser.act({ action: 'click', ref: search });
    await expect(browser.download({ ref: pdf, timeout_ms: 1_500 })).rejects.toMatchObject({ code: 'no_download' });
    expect(browser.trace().steps.at(-1)).toMatchObject({
      action: 'click',
      target: expect.objectContaining({ name: '输出PDF' }),
    });

    const revealed = await browser.snapshot({ mode: 'full' });
    const ok = refFor(revealed.snapshot, /\[(e\d+)\] button "确定"/);
    const downloaded = await browser.download({ ref: ok, save_as: '2025-2026-1.pdf', timeout_ms: 30_000 });
    if (!downloaded.downloads?.[0]) throw new Error(`确定 produced no download\n${downloaded.snapshot}`);
    expect(browser.trace().steps.at(-1)?.action).toBe('download');

    const saved = browser.saveSkill({
      name: 'zf-demo',
      description: '按学年学期导出课表 PDF',
      params: { year: '2025-2026', term: '1' },
      from_step: 2,
    });
    const skill = parseSkill(saved.yaml);
    expect(skill.start_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/zf-mock\/v1\/$/);
    expect(skill.steps.map((step) => step.select?.target.name ?? step.click?.target.name ?? step.download?.click.target.name)).toEqual([
      '学年',
      '学期',
      '查询',
      '输出PDF',
      '确定',
    ]);
    expect(skill.steps[0]?.select?.value).toBe('{{year}}');
    expect(skill.steps[1]?.select?.value).toBe('{{term}}');
    expect(skill.steps[4]?.download?.save_as).toBe('{{year}}-{{term}}.pdf');
    expect(saved.warnings.some((warning) => warning.includes('term') && warning.includes('start_url host'))).toBe(true);
    expect(saved.warnings.some((warning) => warning.includes('term') && warning.includes('start_url path'))).toBe(true);
    expect(saved.warnings.some((warning) => warning.includes('save_as'))).toBe(false);

    const out = mkdtempSync(join(tmpdir(), 'relaywright-zf-demo-'));
    const report = await browser.runSkill('zf-demo', { params: { year: '2025-2026', term: '1' }, out_dir: out });
    expect(report.exit_code).toBe(0);
    expect(report.results[0]?.outcome).toBe('ok');
    const names = report.results.flatMap((result) => (result.artifacts ?? []).map((artifact) => basename(artifact.path)));
    expect(names).toEqual(['2025-2026-1.pdf']);
    const file = report.results[0]?.artifacts?.[0];
    if (!file) throw new Error('replay produced no pdf');
    expect(startsWithPdf(file.path)).toBe(true);
  });
});
