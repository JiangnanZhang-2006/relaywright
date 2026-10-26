import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { stopDaemon } from '../../src/daemon/client.js';
import { writeSkill } from '../../src/skills/store.js';
import type { Skill } from '../../src/skills/schema.js';
import { startStatic } from './static-server.js';

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) console.log('Skipping state e2e: no Chrome, Edge, or cached Chrome for Testing.');

describe.skipIf(!resolved.path)('state across a daemon restart', () => {
  let home = '';
  let server: { port: number; close: () => Promise<void> } | undefined;
  let page = '';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'relaywright-state-e2e-'));
    process.env.RELAYWRIGHT_HOME = home;
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    server = await startStatic(join(repoRoot, 'fixtures'));
    page = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
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

  it('lets a skill write state and a later run read it after the daemon restarts', async () => {
    const set = await cli(['state', 'set', 'notes/marker', '{"ok":true}', '--if-version', '0', '--json']);
    expect(set.code, set.stderr).toBe(0);
    const conflict = await cli(['state', 'set', 'notes/marker', '"nope"', '--if-version', '0']);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('version_conflict');
    expect(conflict.stderr).toContain('current 1');
    const got = await cli(['state', 'get', 'notes/marker', '--json']);
    expect(got.code, got.stderr).toBe(0);
    expect(JSON.parse(got.stdout)).toMatchObject({ value: { ok: true }, version: 1 });
    const listed = await cli(['state', 'list', 'notes', '--json']);
    expect(JSON.parse(listed.stdout).keys).toEqual([expect.objectContaining({ key: 'marker', version: 1 })]);

    writeSkill(noteSkill('state-writer', page, [
      { id: 'save', state_set: { ns: 'notes', key: 'page', value: page } },
      { id: 'back', goto: { url: '{{state.notes.page}}' } },
      { id: 'see', expect: { any: [{ outcome: 'ok', when: { text_present: '查询' } }] } },
    ]), false);
    writeSkill(noteSkill('state-reader', '{{state.notes.page}}', [
      { id: 'see', expect: { any: [{ outcome: 'ok', when: { text_present: '查询' } }] } },
    ]), false);
    writeSkill(noteSkill('state-gap', '{{state.notes.absent}}', [
      { id: 'see', expect: { any: [{ outcome: 'ok', when: { url_contains: 'never' } }] } },
    ]), false);

    const wrote = await cli(['skill', 'run', 'state-writer', '--json']);
    expect(wrote.code, wrote.stderr.slice(0, 800)).toBe(0);
    expect(JSON.parse(wrote.stdout).results[0].outcome).toBe('ok');
    const stored = await cli(['state', 'get', 'notes/page', '--json']);
    expect(JSON.parse(stored.stdout).value).toBe(page);

    const read = await cli(['skill', 'run', 'state-reader', '--json']);
    expect(read.code, read.stderr.slice(0, 800)).toBe(0);
    expect(JSON.parse(read.stdout).results[0].outcome).toBe('ok');

    await stopDaemon({ closeBrowser: true });
    const again = await cli(['skill', 'run', 'state-reader', '--json']);
    expect(again.code, again.stderr.slice(0, 800)).toBe(0);
    expect(JSON.parse(again.stdout).results[0].outcome).toBe('ok');

    const gap = await cli(['skill', 'run', 'state-gap', '--json']);
    expect(gap.code).toBe(30);
    expect(JSON.parse(gap.stdout).results[0].broken.reason).toContain('state_missing');
  }, 240_000);
});

function noteSkill(name: string, startUrl: string, steps: Skill['steps']): Skill {
  return {
    name,
    description: 'state round trip',
    version: 1,
    start_url: startUrl,
    params: {},
    steps,
  };
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAYWRIGHT_HOME: process.env.RELAYWRIGHT_HOME,
    RELAYWRIGHT_HEADLESS: '1',
    RELAYWRIGHT_NOTIFY: '0',
  };
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
