import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { errorText } from '../config/paths.js';

export const HEADLESS_VIEWPORT = { width: 1280, height: 800 } as const;

export interface LaunchBrowserRequest {
  executablePath: string;
  userDataDir: string;
  headless: boolean;
  defaultViewport: { width: number; height: number } | null;
  timeoutMs: number;
}

/**
 * Puppeteer's default Chrome flags, minus --password-store=basic and --use-mock-keychain.
 * Those two weaken OS cookie encryption (DPAPI on Windows), which persisted logins rely on.
 */
const STABILITY_ARGS = [
  '--allow-pre-commit-input',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-crash-reporter',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-hang-monitor',
  '--disable-infobars',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-search-engine-choice-screen',
  '--disable-sync',
  '--enable-automation',
  '--export-tagged-pdf',
  '--force-color-profile=srgb',
  '--generate-pdf-document-outline',
  '--metrics-recording-only',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,WebUIOmniboxPopup,WebUIOmniboxAimPopup,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes',
  '--enable-features=PdfOopif',
];

export function chromeLaunchArgs(input: { userDataDir: string; headless: boolean }): string[] {
  const args = [...STABILITY_ARGS, `--user-data-dir=${input.userDataDir}`, '--remote-debugging-port=0'];
  if (input.headless) args.push('--headless=new', '--hide-scrollbars', '--mute-audio', `--window-size=${HEADLESS_VIEWPORT.width},${HEADLESS_VIEWPORT.height}`);
  else args.push('--start-maximized');
  // The new tab page fetches Google resources; navigating away mid-load leaves requests that never settle.
  args.push('about:blank');
  return args;
}

export function readDevToolsEndpoint(profileDir: string): { port: number; browserWSEndpoint: string } | null {
  try {
    const text = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8');
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const port = Number(lines[0]);
    const path = lines[1] ?? '';
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith('/')) return null;
    return { port, browserWSEndpoint: `ws://127.0.0.1:${port}${path}` };
  } catch {
    return null;
  }
}

export async function probeBrowserWebsocket(port: number, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

export async function adoptChrome(
  profileDir: string,
  viewport: { width: number; height: number } | null,
): Promise<Browser | null> {
  const existing = readDevToolsEndpoint(profileDir);
  if (!existing) return null;
  const endpoint = await probeBrowserWebsocket(existing.port, 1_000);
  if (!endpoint) return null;
  return puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: viewport });
}

export async function launchChrome(request: LaunchBrowserRequest): Promise<Browser> {
  await rm(join(request.userDataDir, 'DevToolsActivePort'), { force: true });
  const args = chromeLaunchArgs(request);
  const child = spawn(request.executablePath, args, {
    detached: true,
    stdio: 'ignore',
    // SW_HIDE on a headful process can keep the first window hidden.
    ...(request.headless ? { windowsHide: true } : {}),
  });
  child.unref();
  try {
    const endpoint = await waitForEndpoint(request.userDataDir, request.timeoutMs);
    return await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: request.defaultViewport });
  } catch (err) {
    killChild(child);
    throw err;
  }
}

async function waitForEndpoint(profileDir: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'Chrome did not open a DevTools port';
  while (Date.now() < deadline) {
    const existing = readDevToolsEndpoint(profileDir);
    if (existing) {
      const endpoint = await probeBrowserWebsocket(existing.port, 1_000);
      if (endpoint) return endpoint;
      last = `DevTools port ${existing.port} did not answer`;
    }
    await delay(100);
  }
  throw new Error(`${last} within ${timeoutMs}ms`);
}

function killChild(child: ChildProcess): void {
  try {
    if (child.pid && !child.killed) child.kill();
  } catch (err) {
    void errorText(err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
