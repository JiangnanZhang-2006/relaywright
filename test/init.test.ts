import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { INIT_HINT } from '../src/cli/hint.js';

const exec = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const homes: string[] = [];
const SELF = 'RWSELF9kQ';

describe('init and doctor', () => {
  afterAll(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  it('writes flags, keeps unknown keys, and does not print a self value', async () => {
    const home = freshHome();
    const downloads = join(home, 'saved');
    writeFileSync(join(home, 'config.json'), `${JSON.stringify({ custom: { keep: true }, browser: { mode: 'cdp', cdp_url: 'http://127.0.0.1:9' } }, null, 2)}\n`, 'utf8');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: { other: { command: 'other' } }, extra: 1 }, null, 2)}\n`, 'utf8');

    const first = await cli(home, [
      'init',
      '--yes',
      '--browser',
      'separate',
      '--privacy',
      'off',
      '--eval',
      'off',
      '--notify',
      'off',
      '--headless',
      '--downloads',
      downloads,
      '--allow-domains',
      'https://www.example.com/path',
      '--self',
      `name=${SELF}`,
      '--write-mcp',
      'cursor',
    ]);
    expect(first.code, `${first.stderr}\n${first.stdout}`).toBe(0);
    expect(`${first.stdout}\n${first.stderr}`).not.toContain(SELF);
    expect(first.stdout).toContain('mcpServers');
    expect(first.stdout).toContain('relaywright doctor');

    const saved = readConfig(home);
    expect(saved.custom).toEqual({ keep: true });
    expect(saved.browser).toEqual({ mode: 'separate' });
    expect(saved.headless).toBe(true);
    expect(saved.downloads).toBe(downloads);
    expect(saved.eval).toBe(false);
    expect(saved.notify).toBe(false);
    expect(saved.privacy).toEqual({ model_redaction: false });
    expect(saved.allow_domains).toEqual(['example.com']);
    expect(typeof saved.initialized_at).toBe('string');
    expect(readFileSync(join(home, 'privacy', 'self.json'), 'utf8')).toContain(SELF);

    const mcp = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      extra?: number;
      mcpServers?: { other?: { command?: string }; relaywright?: { command?: string; args?: string[] } };
    };
    expect(mcp.extra).toBe(1);
    expect(mcp.mcpServers?.other?.command).toBe('other');
    expect(mcp.mcpServers?.relaywright?.command).toBe(process.execPath);
    expect(mcp.mcpServers?.relaywright?.args?.at(-1)).toBe('mcp');

    const second = await cli(home, ['init', '--yes', '--eval', 'on']);
    expect(second.code, second.stderr).toBe(0);
    const again = readConfig(home);
    expect(again.custom).toEqual({ keep: true });
    expect(again.browser).toEqual({ mode: 'separate' });
    expect(again.headless).toBe(true);
    expect(again.eval).toBe(true);
    expect(again.notify).toBe(false);
    expect(again.allow_domains).toEqual(['example.com']);
  });

  it('does not connect when cdp mode is only saved', async () => {
    const home = freshHome();
    const result = await cli(home, ['init', '--yes', '--browser', 'cdp', '--cdp-url', 'http://127.0.0.1:9']);
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(readConfig(home).browser).toEqual({ mode: 'cdp', cdp_url: 'http://127.0.0.1:9' });
  }, 20_000);

  it('prints the init hint once per day until init', async () => {
    const home = freshHome();
    const first = await cli(home, ['browser', 'which']);
    expect(first.stderr).toContain(INIT_HINT);
    const second = await cli(home, ['browser', 'which']);
    expect(second.stderr).not.toContain(INIT_HINT);
    const done = await cli(home, ['init', '--yes', '--browser', 'separate', '--notify', 'off']);
    expect(done.code, done.stderr).toBe(0);
    const after = await cli(home, ['browser', 'which']);
    expect(after.stderr).not.toContain(INIT_HINT);
  });

  it('rewrites a stored own or attach mode on read', async () => {
    const separateHome = freshHome();
    writeFileSync(
      join(separateHome, 'config.json'),
      `${JSON.stringify({ custom: { keep: true }, browser: { mode: 'own' } }, null, 2)}\n`,
      'utf8',
    );
    await cli(separateHome, ['doctor', '--json']);
    const separate = readConfig(separateHome);
    expect(separate.custom).toEqual({ keep: true });
    expect(separate.browser).toEqual({ mode: 'separate' });

    const dailyHome = freshHome();
    const profile = join(dailyHome, 'kept-profile');
    writeFileSync(
      join(dailyHome, 'config.json'),
      `${JSON.stringify({ browser: { mode: 'attach', user_data_dir: profile } }, null, 2)}\n`,
      'utf8',
    );
    await cli(dailyHome, ['doctor', '--json']);
    expect(readConfig(dailyHome).browser).toEqual({ mode: 'daily', user_data_dir: profile });
  });

  it('fails doctor when an attach profile has no DevToolsActivePort', async () => {
    const home = freshHome();
    const profile = join(home, 'empty-profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      `${JSON.stringify({ browser: { mode: 'daily', user_data_dir: profile }, initialized_at: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    const result = await cli(home, ['doctor', '--json']);
    expect(result.code, result.stdout.slice(0, 500)).toBe(1);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: { name: string; status: string; detail: string; hint: string }[] };
    expect(report.ok).toBe(false);
    const attach = report.checks.find((check) => check.name === 'attach');
    expect(attach?.status).toBe('FAIL');
    expect(attach?.detail).toContain(profile);
    expect(`${attach?.hint}`).toMatch(/DevToolsActivePort|chrome:\/\/inspect/);
    expect(result.stdout).not.toContain('Google\\Chrome\\User Data');
  });

  it('reports a DevToolsActivePort whose port is not listening', async () => {
    const home = freshHome();
    const profile = join(home, 'quiet-profile');
    const port = await freePort();
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'DevToolsActivePort'), `${port}\n/devtools/browser/doctor-test\n`, 'utf8');
    writeFileSync(
      join(home, 'config.json'),
      `${JSON.stringify({ browser: { mode: 'daily', user_data_dir: profile }, initialized_at: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    const result = await cli(home, ['doctor', '--json']);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { checks: { name: string; status: string; detail: string; hint: string }[] };
    const attach = report.checks.find((check) => check.name === 'attach');
    expect(attach?.status).toBe('FAIL');
    expect(attach?.detail).toContain(String(port));
    expect(attach?.detail).toContain('not listening');
    expect(attach?.hint).toMatch(/chrome:\/\/inspect/);
  });
});

async function freePort(): Promise<number> {
  const reserved = new Set([9222, 9333, 61173]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port > 0 && !reserved.has(port)) return port;
  }
  throw new Error('no free port');
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rw-init-'));
  homes.push(home);
  return home;
}

function readConfig(home: string): {
  custom?: { keep?: boolean };
  browser?: { mode?: string; cdp_url?: string; user_data_dir?: string };
  headless?: boolean;
  downloads?: string;
  eval?: boolean;
  notify?: boolean;
  privacy?: { model_redaction?: boolean };
  allow_domains?: string[];
  initialized_at?: string;
} {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as ReturnType<typeof readConfig>;
}

async function cli(home: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAYWRIGHT_HOME: home,
    RELAYWRIGHT_HEADLESS: '1',
    RELAYWRIGHT_NOTIFY: '0',
    ...extra,
  };
  delete env.RELAYWRIGHT_EVAL;
  delete env.DEEPSEEK_API_KEY;
  delete env.RELAYWRIGHT_TEST_ACCESS_DECISION;
  try {
    const result = await exec(process.execPath, [tsx, join(repoRoot, 'src', 'cli', 'index.ts'), ...args], {
      cwd: home,
      env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
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
