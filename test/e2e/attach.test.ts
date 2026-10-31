import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryAudit } from '../../src/audit/log.js';
import { whichBrowser } from '../../src/browser/resolve.js';
import { stopDaemon } from '../../src/daemon/client.js';
import { readDevToolsEndpoint } from '../../src/session/launch.js';
import { startStatic } from './static-server.js';

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
const FORBIDDEN = new Set([9222, 9333, 61173]);
if (!resolved.path) console.log('Skipping attach e2e: no Chrome, Edge, or cached Chrome for Testing.');

describe.skipIf(!resolved.path)('attach to a test Chrome', () => {
  let home = '';
  let profile = '';
  let chrome: ChildProcess | undefined;
  let server: { port: number; close: () => Promise<void> } | undefined;
  let debugPort = 0;
  let ours = '';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'relaywright-attach-e2e-'));
    profile = mkdtempSync(join(tmpdir(), 'relaywright-attach-profile-'));
    process.env.RELAYWRIGHT_HOME = home;
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    delete process.env.RELAYWRIGHT_EVAL;
    delete process.env.RELAYWRIGHT_TEST_ACCESS_DECISION;
    server = await startStatic(join(repoRoot, 'fixtures'));
    ours = `http://127.0.0.1:${server.port}/attach/ours.html`;
    debugPort = await freePort();
    const endpoint = await launchTestChrome(profile, debugPort, `http://127.0.0.1:${server.port}/attach/user.html`);
    chrome = endpoint.chrome;
    if (FORBIDDEN.has(endpoint.port)) throw new Error(`Refusing test Chrome port ${endpoint.port}`);
    debugPort = endpoint.port;
    await waitForTitle(debugPort, 'USER-TAB-SECRET');
  }, 60_000);

  afterAll(async () => {
    await stopDaemon().catch(() => undefined);
    stopChrome(chrome);
    await server?.close();
    await removeDir(profile);
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

  it('hides user tabs, gates domains, and leaves the browser running', async () => {
    const attached = await cli(['daemon', 'attach', '--user-data-dir', profile, '--json'], 'deny');
    expect(attached.code, attached.stderr.slice(0, 800)).toBe(0);
    expect(JSON.parse(attached.stdout)).toMatchObject({ mode: 'daily', endpoint_kind: 'devtools-file' });

    const hidden = await cli(['tabs', 'list', '--json'], 'deny');
    expect(hidden.code, hidden.stderr.slice(0, 500)).toBe(0);
    expect(hidden.stdout).not.toContain('USER-TAB-SECRET');

    const blocked = await cli(['open', ours], 'deny');
    expect(blocked.code).toBe(1);
    expect(`${blocked.stderr}\n${blocked.stdout}`).toContain('domain_not_allowed');
    expect(`${blocked.stderr}\n${blocked.stdout}`).toContain('browser_request_access');

    const denied = await cli(['access', 'request', '127.0.0.1', '--reason', 'read the fixture'], 'deny');
    expect(denied.code, denied.stderr).toBe(0);
    expect(denied.stdout).toContain('deny');
    const still = await cli(['open', ours], 'deny');
    expect(still.code).toBe(1);
    expect(still.stderr).toContain('domain_not_allowed');

    const pdf = await cli(['pdf'], 'deny');
    expect(pdf.code).toBe(1);
    expect(`${pdf.stderr}\n${pdf.stdout}`).toContain('attach_downloads_disabled');

    const foreign = await cli(['tabs', 'adopt', '--json'], 'deny');
    expect(foreign.code, foreign.stderr.slice(0, 500)).toBe(0);
    const userTabs = JSON.parse(foreign.stdout) as { tabs: { index: number; title: string }[] };
    const user = userTabs.tabs.find((tab) => tab.title.includes('USER-TAB-SECRET'));
    expect(user).toBeTruthy();
    const adopted = await cli(['tabs', 'adopt', '--index', String(user?.index), '--json'], 'deny');
    expect(adopted.code, adopted.stderr.slice(0, 500)).toBe(0);
    const visible = await cli(['tabs', 'list', '--json'], 'deny');
    expect(visible.stdout).toContain('USER-TAB-SECRET');

    const attachCount = queryAudit({ event: 'attach' }).entries.length;
    const again = await cli(['daemon', 'attach', '--user-data-dir', profile, '--json'], 'deny');
    expect(again.code, again.stderr.slice(0, 800)).toBe(0);
    expect(queryAudit({ event: 'attach' }).entries.length).toBe(attachCount);
    const keptAdopted = await cli(['tabs', 'list', '--json'], 'deny');
    expect(keptAdopted.stdout).toContain('USER-TAB-SECRET');
    expect(keptAdopted.stdout).toContain('"adopted": true');

    const audit = queryAudit({ event: 'attach' });
    expect(audit.chain.ok).toBe(true);
    expect(audit.entries.at(-1)).toMatchObject({ event: 'attach', mode: 'daily', endpoint_kind: 'devtools-file' });
    expect(JSON.stringify(audit.entries)).not.toContain('user.html');
    expect(JSON.stringify(queryAudit({ event: 'access_request' }).entries)).toContain('"decision":"deny"');

    await stopDaemon();
    expect(await versionOk(debugPort)).toBe(true);

    const cold = await cli(['open', ours], 'once');
    expect(cold.code).toBe(1);
    expect(cold.stderr).toContain('domain_not_allowed');
    const once = await cli(['access', 'request', '127.0.0.1', '--reason', 'once'], 'once');
    expect(once.stdout).toContain('once');
    const opened = await cli(['open', ours, '--json'], 'once');
    expect(opened.code, opened.stderr.slice(0, 800)).toBe(0);
    expect(opened.stdout).toContain('OURS-PAGE');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('127.0.0.1');

    await stopDaemon();
    const expired = await cli(['open', ours], 'deny');
    expect(expired.code).toBe(1);
    expect(expired.stderr).toContain('domain_not_allowed');

    await stopDaemon();
    const always = await cli(['access', 'request', '127.0.0.1', '--reason', 'keep'], 'always');
    expect(always.stdout).toContain('always');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toContain('127.0.0.1');
    const kept = await cli(['open', ours, '--json'], 'always');
    expect(kept.code, kept.stderr.slice(0, 500)).toBe(0);
    expect(kept.stdout).toContain('OURS-PAGE');

    await stopDaemon();
    const persisted = await cli(['open', ours, '--json'], 'deny');
    expect(persisted.code, persisted.stderr.slice(0, 500)).toBe(0);
    expect(persisted.stdout).toContain('OURS-PAGE');

    const detached = await cli(['daemon', 'detach', '--json'], 'deny');
    expect(detached.code, detached.stderr.slice(0, 400)).toBe(0);
    expect(await versionOk(debugPort)).toBe(true);
    const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as { title?: string }[];
    expect(targets.some((target) => target.title?.includes('USER-TAB-SECRET'))).toBe(true);

    const viaHttp = await cli(['daemon', 'attach', '--cdp-url', `http://127.0.0.1:${debugPort}`, '--json'], 'deny');
    expect(viaHttp.code, viaHttp.stderr.slice(0, 800)).toBe(0);
    expect(JSON.parse(viaHttp.stdout)).toMatchObject({ mode: 'cdp', endpoint_kind: 'cdp-http' });
    const hiddenAgain = await cli(['tabs', 'list', '--json'], 'deny');
    expect(hiddenAgain.stdout).not.toContain('USER-TAB-SECRET');
    expect(JSON.stringify(queryAudit({ event: 'attach' }).entries)).not.toContain('user.html');
  }, 300_000);
});

async function cli(args: string[], decision: 'once' | 'always' | 'deny'): Promise<{ code: number; stdout: string; stderr: string }> {
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAYWRIGHT_HOME: process.env.RELAYWRIGHT_HOME,
    RELAYWRIGHT_HEADLESS: '1',
    RELAYWRIGHT_NOTIFY: '0',
    RELAYWRIGHT_TEST_ACCESS_DECISION: decision,
    VITEST: 'true',
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

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const value = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(value));
      });
    });
    if (port > 0 && !FORBIDDEN.has(port)) return port;
  }
  throw new Error('No safe debugging port');
}

/**
 * A chosen --remote-debugging-port prints the socket on stderr and does not
 * create DevToolsActivePort. The daily-browser file has the same two lines,
 * so the test records them before attach. Attach itself only reads the file.
 */
function launchTestChrome(profile: string, port: number, url: string): Promise<{ chrome: ChildProcess; port: number }> {
  const chrome = spawn(
    resolved.path as string,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Chrome did not publish a DevTools socket.\n${stderr.slice(-500)}`));
    }, 20_000);
    chrome.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Test Chrome exited ${code ?? 'null'} before DevTools was ready.\n${stderr.slice(-500)}`));
    });
    chrome.stderr?.setEncoding('utf8');
    chrome.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      const match = /ws:\/\/127\.0\.0\.1:(\d+)(\/devtools\/browser\/\S+)/.exec(stderr);
      const found = match?.[1];
      const path = match?.[2];
      if (!found || !path || settled) return;
      settled = true;
      const actual = Number(found);
      clearTimeout(timer);
      chrome.removeAllListeners('exit');
      writeFileSync(join(profile, 'DevToolsActivePort'), `${actual}\n${path}\n`, 'utf8');
      const recorded = readDevToolsEndpoint(profile);
      if (recorded.kind !== 'ok' || recorded.port !== actual) {
        reject(new Error('DevToolsActivePort could not be recorded'));
        return;
      }
      resolve({ chrome, port: actual });
    });
  });
}

async function removeDir(path: string): Promise<void> {
  if (!path) return;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

async function waitForTitle(port: number, title: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const body = (await response.json()) as { title?: string }[];
      if (body.some((item) => item.title?.includes(title))) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Chrome did not open ${title}`);
}

async function versionOk(port: number): Promise<boolean> {
  if (FORBIDDEN.has(port)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function stopChrome(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    return;
  }
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}
