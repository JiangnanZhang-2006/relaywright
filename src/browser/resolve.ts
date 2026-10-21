import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  Browser as BrowserProduct,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from '@puppeteer/browsers';
import { browsersDir, ensureHomeLayout, logDaemon } from '../config/paths.js';

const execFileAsync = promisify(execFile);

export type BrowserSource = 'env' | 'chrome' | 'edge' | 'cached-cft' | 'none';
export type ForcedBrowser = 'chrome' | 'edge' | 'cft';

export interface ResolvedBrowser {
  source: BrowserSource;
  path: string | null;
}

export function readForcedBrowser(): ForcedBrowser | null {
  const raw = process.env.RELAYWRIGHT_BROWSER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'chrome' || raw === 'edge' || raw === 'cft') return raw;
  throw new Error(`RELAYWRIGHT_BROWSER must be chrome, edge, or cft, got ${raw}`);
}

/** Locate a browser without downloading. RELAYWRIGHT_CHROME wins over RELAYWRIGHT_BROWSER. */
export async function whichBrowser(): Promise<ResolvedBrowser> {
  const configured = process.env.RELAYWRIGHT_CHROME?.trim();
  if (configured) {
    if (!isFile(configured)) throw new Error(`RELAYWRIGHT_CHROME does not point to a file: ${configured}`);
    return { source: 'env', path: configured };
  }

  const forced = readForcedBrowser();
  if (forced === 'chrome') return found('chrome', await findChrome());
  if (forced === 'edge') return found('edge', await findEdge());
  if (forced === 'cft') return found('cached-cft', await cachedChromeForTesting());

  const chrome = await findChrome();
  if (chrome) return { source: 'chrome', path: chrome };
  const edge = await findEdge();
  if (edge) return { source: 'edge', path: edge };
  const cached = await cachedChromeForTesting();
  if (cached) return { source: 'cached-cft', path: cached };
  return { source: 'none', path: null };
}

export async function resolveBrowserForLaunch(onProgress?: (percent: number) => void): Promise<ResolvedBrowser & { path: string }> {
  const foundBrowser = await whichBrowser();
  if (foundBrowser.path) return { source: foundBrowser.source, path: foundBrowser.path };
  const forced = readForcedBrowser();
  if (forced === 'chrome' || forced === 'edge') {
    throw new Error(`No ${forced} executable found. Set RELAYWRIGHT_CHROME or run: relaywright browser install`);
  }
  const path = await installChromeForTesting(onProgress);
  return { source: 'cached-cft', path };
}

export async function installChromeForTesting(onProgress?: (percent: number) => void): Promise<string> {
  ensureHomeLayout();
  const cacheDir = browsersDir();
  const cached = await cachedChromeForTesting();
  if (cached) {
    onProgress?.(100);
    logDaemon(`browser: cached Chrome for Testing ${cached}`);
    return cached;
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('No system Chrome or Edge was found, and the platform is not supported for Chrome for Testing.');
  }
  const buildId = await resolveBuildId(BrowserProduct.CHROME, platform, 'stable');
  logDaemon(`downloading Chrome for Testing ${buildId} (${platform})`);
  onProgress?.(0);
  let lastLogged = -1;
  let lastPercent = -1;
  const result = await install({
    browser: BrowserProduct.CHROME,
    buildId,
    cacheDir,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      if (totalBytes <= 0) return;
      const percent = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
      if (percent === lastPercent) return;
      lastPercent = percent;
      onProgress?.(percent);
      if (Math.floor(percent / 10) === lastLogged) return;
      lastLogged = Math.floor(percent / 10);
      logDaemon(`Chrome for Testing download ${lastLogged * 10}%`);
    },
  });
  onProgress?.(100);
  logDaemon(`browser: Chrome for Testing ${result.executablePath}`);
  return result.executablePath;
}

function found(source: BrowserSource, path: string | null): ResolvedBrowser {
  return path ? { source, path } : { source: 'none', path: null };
}

async function cachedChromeForTesting(): Promise<string | null> {
  try {
    const installed = await getInstalledBrowsers({ cacheDir: browsersDir() });
    return installed.find((browser) => browser.browser === BrowserProduct.CHROME)?.executablePath ?? null;
  } catch {
    return null;
  }
}

async function findChrome(): Promise<string | null> {
  if (process.platform === 'win32') {
    return firstFile(windowsCandidates(['Google', 'Chrome', 'Application', 'chrome.exe']));
  }
  if (process.platform === 'darwin') return firstFile(macApps('Google Chrome'));
  return findLinux(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], ['/opt/google/chrome/chrome']);
}

async function findEdge(): Promise<string | null> {
  if (process.platform === 'win32') {
    return firstFile(windowsCandidates(['Microsoft', 'Edge', 'Application', 'msedge.exe']));
  }
  if (process.platform === 'darwin') return firstFile(macApps('Microsoft Edge'));
  return findLinux(['microsoft-edge', 'microsoft-edge-stable'], ['/opt/microsoft/msedge/msedge']);
}

function windowsCandidates(parts: string[]): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, process.env.ProgramW6432];
  const paths: string[] = [];
  for (const root of roots) {
    if (root) paths.push(join(root, ...parts));
  }
  return paths;
}

function macApps(name: string): string[] {
  const relative = join(`${name}.app`, 'Contents', 'MacOS', name);
  return [join('/Applications', relative), join(homedir(), 'Applications', relative)];
}

async function findLinux(names: string[], absolute: string[]): Promise<string | null> {
  const directories = ['/usr/bin', '/usr/local/bin', '/snap/bin'];
  const candidates = [...absolute];
  for (const directory of directories) {
    for (const name of names) candidates.push(join(directory, name));
  }
  const direct = firstFile(candidates);
  if (direct) return direct;
  for (const name of names) {
    const foundOnPath = await commandOnPath(name);
    if (foundOnPath) return foundOnPath;
  }
  return null;
}

function firstFile(paths: string[]): string | null {
  for (const path of paths) {
    if (isFile(path)) return path;
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function commandOnPath(name: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 3_000, windowsHide: true });
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    return line && isFile(line) ? line : null;
  } catch {
    return null;
  }
}
