import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { daemonLogPath, defaultProfileDir } from '../../src/config/paths.js';
import { probeBrowserWebsocket, readDevToolsEndpoint } from '../../src/session/launch.js';
import { BrowserSession } from '../../src/session/browser.js';
import { startStatic } from './static-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) {
  console.log('Skipping reconnect e2e: no Chrome, Edge, or cached Chrome for Testing.');
}

describe.skipIf(!resolved.path)('chrome stays up across a daemon disconnect', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let pageUrl = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-reconnect-e2e-'));
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    server = await startStatic(join(repoRoot, 'fixtures'));
    pageUrl = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
  });

  afterAll(async () => {
    await session?.close().catch(() => undefined);
    const endpoint = readDevToolsEndpoint(defaultProfileDir());
    if (endpoint) {
      const ws = await probeBrowserWebsocket(endpoint.port, 1_000);
      if (ws) {
        const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null }).catch(() => null);
        await browser?.close().catch(() => undefined);
      }
    }
    await server?.close();
  });

  it('adopts the same page after disconnect and closes chrome on the second close', async () => {
    const first = new BrowserSession();
    session = first;
    const opened = await first.navigate(pageUrl);
    expect(opened.url).toContain('/zf-mock/v1/');
    await first.close({ keepBrowser: true });
    const endpoint = readDevToolsEndpoint(defaultProfileDir());
    expect(endpoint).not.toBeNull();
    expect(await probeBrowserWebsocket(endpoint?.port ?? 0, 1_000)).toBeTruthy();

    const second = new BrowserSession();
    session = second;
    const adopted = await second.snapshot({ mode: 'full' });
    expect(adopted.url).toContain('/zf-mock/v1/');
    expect(readFileSync(daemonLogPath(), 'utf8')).toContain('adopted browser');
    await second.close();
    session = undefined;

    const deadline = Date.now() + 10_000;
    let gone = false;
    while (Date.now() < deadline) {
      const still = readDevToolsEndpoint(defaultProfileDir());
      if (!still || !(await probeBrowserWebsocket(still.port, 500))) {
        gone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(gone).toBe(true);
  });
});
