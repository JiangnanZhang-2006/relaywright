import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryAudit } from '../../src/audit/log.js';
import { whichBrowser } from '../../src/browser/resolve.js';
import { stopDaemon } from '../../src/daemon/client.js';
import { startStatic } from './static-server.js';

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) console.log('Skipping extract e2e: no Chrome, Edge, or cached Chrome for Testing.');

const EXPR = 'return { sum: args[0] + args[1] }';

describe.skipIf(!resolved.path)('extract and eval', () => {
  let home = '';
  let server: { port: number; close: () => Promise<void> } | undefined;
  let page = '';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'relaywright-extract-e2e-'));
    process.env.RELAYWRIGHT_HOME = home;
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    delete process.env.RELAYWRIGHT_EVAL;
    server = await startStatic(join(repoRoot, 'fixtures'));
    page = `http://127.0.0.1:${server.port}/extract/list.html`;
  });

  afterAll(async () => {
    await stopDaemon({ closeBrowser: true }).catch(() => undefined);
    await server?.close();
    if (!home) return;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(home, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  });

  it('extracts list rows, nested fields, an iframe, and redacts passwords', async () => {
    const opened = await cli(['open', page, '--json']);
    expect(opened.code, opened.stderr.slice(0, 500)).toBe(0);

    const denied = await cli(['eval', EXPR, '--arg', '20', '--arg', '22']);
    expect(denied.code, `${denied.stderr}\n${denied.stdout}`).toBe(1);
    const deniedText = `${denied.stderr}\n${denied.stdout}`;
    expect(deniedText).toContain('eval_disabled');
    expect(deniedText).toContain('relaywright config set eval on');

    const extracted = await cli([
      'extract',
      '--root',
      '.row',
      '--field',
      'title=.title',
      '--field',
      'year=.meta .year',
      '--field',
      'tags=.tag*',
      '--field',
      'link=.link@href',
      '--field',
      'secret=.secret@value',
      '--field',
      'alt=.alt@value',
      '--json',
    ]);
    expect(extracted.code, extracted.stderr.slice(0, 800)).toBe(0);
    const body = JSON.parse(extracted.stdout) as {
      truncated: boolean;
      rows: { title: string; year: string; tags: string[]; link: string; secret: string | null; alt: string | null; frame: { name: string; url: string } }[];
    };
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(62);
    expect(body.rows[0]).toMatchObject({
      title: 'Item 1',
      year: '2025',
      tags: ['a', 'b'],
      link: '/item/1',
      secret: '‹redacted›',
      alt: '‹redacted›',
    });
    expect(body.rows[0]?.frame.url).toContain('list.html');
    expect(body.rows[1]?.secret).toBeNull();
    expect(body.rows[59]?.title).toBe('Item 60');
    const framed = body.rows.filter((row) => row.frame.url.includes('frame.html'));
    expect(framed.map((row) => row.title)).toEqual(['Frame 1', 'Frame 2']);
    expect(framed[0]?.frame.name).toBe('extra');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('secret-like');

    const limited = await cli(['extract', '--root', '.row', '--field', 'title=.title', '--limit', '10', '--json']);
    expect(limited.code, limited.stderr.slice(0, 400)).toBe(0);
    const short = JSON.parse(limited.stdout) as { truncated: boolean; rows: unknown[] };
    expect(short.truncated).toBe(true);
    expect(short.rows).toHaveLength(10);

    const enabled = await cli(['config', 'set', 'eval', 'on', '--json']);
    expect(enabled.code, enabled.stderr).toBe(0);
    const ran = await cli(['eval', EXPR, '--arg', '20', '--arg', '22', '--json']);
    expect(ran.code, ran.stderr.slice(0, 500)).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ result: { sum: 42 } });

    const audit = queryAudit({ event: 'eval' });
    expect(audit.chain.ok).toBe(true);
    const hash = createHash('sha256').update(EXPR).digest('hex');
    expect(audit.entries.at(-1)).toMatchObject({
      event: 'eval',
      expr_sha256: hash,
      expr_len: Buffer.byteLength(EXPR),
      ok: true,
      result_len: Buffer.byteLength(JSON.stringify({ sum: 42 })),
    });
    const auditText = JSON.stringify(audit.entries);
    expect(auditText).not.toContain(EXPR);
    expect(auditText).not.toContain('sum');
    expect(String(audit.entries.at(-1)?.url_origin)).toContain('127.0.0.1');
  }, 180_000);
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAYWRIGHT_HOME: process.env.RELAYWRIGHT_HOME,
    RELAYWRIGHT_HEADLESS: '1',
    RELAYWRIGHT_NOTIFY: '0',
  };
  delete env.RELAYWRIGHT_EVAL;
  delete env.DEEPSEEK_API_KEY;
  try {
    const result = await exec(process.execPath, [tsx, join(repoRoot, 'src', 'cli', 'index.ts'), ...args], {
      cwd: repoRoot,
      env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const error = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}
