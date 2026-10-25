import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allocateFilename,
  assertSaveAs,
  preferExternalPdf,
  publishDownload,
  sanitizeFilename,
  stripDownloadUrl,
} from '../src/session/downloads.js';

describe('download file names', () => {
  it('sanitizes Windows-invalid characters, reserved names, and length', () => {
    expect(sanitizeFilename('a<b>c:d.pdf')).toBe('a_b_c_d.pdf');
    expect(sanitizeFilename('quote"star*bar?.pdf')).toBe('quote_star_bar_.pdf');
    expect(sanitizeFilename('a/b\\c.pdf')).toBe('a_b_c.pdf');
    expect(sanitizeFilename(`line\u0001break.pdf`)).toBe('line_break.pdf');
    expect(sanitizeFilename('report.')).toBe('report');
    expect(sanitizeFilename('report...')).toBe('report');
    expect(sanitizeFilename('   ')).toBe('download');
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('...')).toBe('download');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('con.txt')).toBe('_con.txt');
    expect(sanitizeFilename('Prn')).toBe('_Prn');
    expect(sanitizeFilename('AUX.')).toBe('_AUX');
    expect(sanitizeFilename('NUL.pdf')).toBe('_NUL.pdf');
    expect(sanitizeFilename('COM1.jpg')).toBe('_COM1.jpg');
    expect(sanitizeFilename('lpt9.txt')).toBe('_lpt9.txt');
    expect(sanitizeFilename('COM10.txt')).toBe('COM10.txt');
    const long = `${'a'.repeat(200)}.pdf`;
    const capped = sanitizeFilename(long);
    expect(capped.length).toBeLessThanOrEqual(150);
    expect(capped.endsWith('.pdf')).toBe(true);
  });

  it('dedupes by appending a number before the extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaywright-names-'));
    writeFileSync(join(dir, 'notes.pdf'), 'a');
    writeFileSync(join(dir, 'notes (1).pdf'), 'b');
    expect(allocateFilename(dir, 'notes.pdf')).toEqual({ name: 'notes (2).pdf', deduped: true });
    expect(allocateFilename(dir, 'fresh.pdf')).toEqual({ name: 'fresh.pdf', deduped: false });
    expect(allocateFilename(dir, 'CON.txt')).toEqual({ name: '_CON.txt', deduped: false });
  });

  it('rejects a save_as that is a path', () => {
    expect(() => assertSaveAs('ok.pdf')).not.toThrow();
    for (const name of ['a/b.pdf', 'a\\b.pdf', '../secret.pdf', 'foo/../x.pdf', '', '   ']) {
      expect(() => assertSaveAs(name)).toThrow(expect.objectContaining({ code: 'bad_params' }));
    }
  });

  it('strips query and fragment from a download url', () => {
    expect(stripDownloadUrl('https://school.example/kb.pdf?token=abc#page=1')).toBe('https://school.example/kb.pdf');
    expect(stripDownloadUrl('not a url?token=abc#x')).toBe('not a url');
  });

  it('moves a finished file, hashes it, and dedupes the destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relaywright-publish-'));
    const source = join(root, 'guid-1');
    const dir = join(root, 'out');
    const bytes = Buffer.from('%PDF-1.4\n');
    writeFileSync(source, bytes);
    const first = await publishDownload({
      sourcePath: source,
      dir,
      fileName: 'kb.pdf',
      url: 'http://127.0.0.1/export.pdf?token=1',
      mime: 'application/pdf',
      dedupe: true,
    });
    expect(first.deduped).toBe(false);
    expect(first.requested).toBe('kb.pdf');
    expect(first.info).toMatchObject({
      name: 'kb.pdf',
      path: join(dir, 'kb.pdf'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'http://127.0.0.1/export.pdf',
      mime: 'application/pdf',
    });
    const again = await publishDownload({
      sourcePath: writeTemp(root, 'guid-2', bytes),
      dir,
      fileName: 'kb.pdf',
      url: 'http://127.0.0.1/export.pdf',
      dedupe: true,
    });
    expect(again.deduped).toBe(true);
    expect(again.requested).toBe('kb.pdf');
    expect(again.info.name).toBe('kb (1).pdf');
  });

  it('keeps the sanitized name when dedupe renames the file on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relaywright-requested-'));
    const dir = join(root, 'out');
    const bytes = Buffer.from('%PDF-1.4\n');
    const first = await publishDownload({
      sourcePath: writeTemp(root, 'guid-1', bytes),
      dir,
      fileName: 'a:b.pdf',
      url: 'http://127.0.0.1/export.pdf?token=1',
      dedupe: true,
    });
    expect(first.requested).toBe('a_b.pdf');
    expect(first.info.name).toBe('a_b.pdf');
    expect(first.deduped).toBe(false);

    const again = await publishDownload({
      sourcePath: writeTemp(root, 'guid-2', bytes),
      dir,
      fileName: 'a:b.pdf',
      url: 'http://127.0.0.1/export.pdf',
      dedupe: true,
    });
    expect(again.requested).toBe('a_b.pdf');
    expect(again.info.name).toBe('a_b (1).pdf');
    expect(again.deduped).toBe(true);
    expect(again.info.path).toBe(join(dir, 'a_b (1).pdf'));
  });
});

describe('pdf profile preference', () => {
  it('sets always_open_pdf_externally and keeps other keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaywright-prefs-'));
    const path = join(dir, 'Default', 'Preferences');
    preferExternalPdf(dir);
    const created = JSON.parse(readFileSync(path, 'utf8')) as { plugins: { always_open_pdf_externally: boolean } };
    expect(created.plugins.always_open_pdf_externally).toBe(true);

    writeFileSync(path, JSON.stringify({ homepage: 'about:blank', plugins: { other: 1 } }));
    preferExternalPdf(dir);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      homepage: 'about:blank',
      plugins: { other: 1, always_open_pdf_externally: true },
    });
  });

  it('leaves an unreadable Preferences file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaywright-prefs-'));
    const path = join(dir, 'Default', 'Preferences');
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(path, '{');
    expect(() => preferExternalPdf(dir)).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{');
  });
});

function writeTemp(root: string, name: string, bytes: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}
