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
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { browsersDir, defaultProfileDir, errorText, logDaemon } from '../config/paths.js';
import { renderSnapshot, type AxNode } from './snapshot.js';

const execFileAsync = promisify(execFile);
const NAVIGATE_TIMEOUT_MS = 30_000;

export interface StatusBody {
  pid: number;
  uptime: number;
  browser: {
    executablePath: string;
    version: string;
  };
  page: {
    url: string;
    title: string;
  };
}

export interface PageBody {
  url: string;
  title: string;
  snapshot: string;
}

export class BrowserSession {
  private browser: Browser | null = null;
  private launching: Promise<void> | null = null;
  private executablePath = '';
  private browserVersion = '';

  async start(): Promise<void> {
    await this.ensure();
  }

  async status(): Promise<StatusBody> {
    const page = await this.page();
    return {
      pid: process.pid,
      uptime: Math.round(process.uptime() * 10) / 10,
      browser: {
        executablePath: this.executablePath,
        version: this.browserVersion,
      },
      page: {
        url: page.url(),
        title: await page.title(),
      },
    };
  }

  async navigate(url: string): Promise<PageBody> {
    const page = await this.page();
    // Puppeteer's TimeoutError keeps its name so the HTTP layer can return 504.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAVIGATE_TIMEOUT_MS });
    return this.view(page);
  }

  async snapshot(): Promise<PageBody> {
    return this.view(await this.page());
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    await browser.close();
  }

  private async view(page: Page): Promise<PageBody> {
    return {
      url: page.url(),
      title: await page.title(),
      snapshot: await captureSnapshot(page),
    };
  }

  private async page(): Promise<Page> {
    await this.ensure();
    const browser = this.browser;
    if (!browser?.connected) throw new Error('Browser is not connected');
    const open = (await browser.pages()).filter((candidate) => !candidate.isClosed());
    if (open.length === 0) return browser.newPage();
    const [first, ...extra] = open;
    if (!first) return browser.newPage();
    await Promise.all(extra.map((candidate) => candidate.close().catch(() => undefined)));
    return first;
  }

  private async ensure(): Promise<void> {
    if (this.browser?.connected) return;
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    await this.launching;
  }

  private async launch(): Promise<void> {
    const executablePath = await resolveBrowserExecutable();
    // Puppeteer defaults to headless. Relaywright is headful unless asked.
    const headless = process.env.RELAYWRIGHT_HEADLESS === '1';
    logDaemon(`launching browser headless=${headless ? '1' : '0'} path=${executablePath}`);
    const browser = await puppeteer.launch({
      executablePath,
      headless,
      userDataDir: defaultProfileDir(),
      defaultViewport: null,
      // Puppeteer's own signal handlers call process.exit and skip daemon cleanup.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 20_000,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync'],
    });
    browser.on('disconnected', () => {
      logDaemon('browser disconnected');
      if (this.browser === browser) this.browser = null;
    });
    this.browser = browser;
    this.executablePath = executablePath;
    this.browserVersion = await browser.version();
    logDaemon(`browser ready ${this.browserVersion}`);
  }
}

async function captureSnapshot(page: Page): Promise<string> {
  const cdp = await page.createCDPSession();
  try {
    const passwordBackendNodeIds = await passwordBackendIds(cdp);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return renderSnapshot({
      title: await page.title(),
      url: page.url(),
      nodes: nodes as AxNode[],
      passwordBackendNodeIds,
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function passwordBackendIds(cdp: CDPSession): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0, pierce: true });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: 'input[type="password"]',
    });
    for (const nodeId of nodeIds) {
      const described = await cdp.send('DOM.describeNode', { nodeId });
      ids.add(described.node.backendNodeId);
    }
  } catch (err) {
    logDaemon(`password field lookup failed: ${errorText(err)}`);
  }
  return ids;
}

async function resolveBrowserExecutable(): Promise<string> {
  const configured = process.env.RELAYWRIGHT_CHROME?.trim();
  if (configured) {
    if (!isFile(configured)) {
      throw new Error(`RELAYWRIGHT_CHROME does not point to a file: ${configured}`);
    }
    logDaemon(`browser: RELAYWRIGHT_CHROME ${configured}`);
    return configured;
  }

  const chrome = await findChrome();
  if (chrome) {
    logDaemon(`browser: system Chrome ${chrome}`);
    return chrome;
  }

  const edge = await findEdge();
  if (edge) {
    logDaemon(`browser: system Edge ${edge}`);
    return edge;
  }

  logDaemon('browser: no system Chrome or Edge found; using Chrome for Testing');
  return downloadChromeForTesting();
}

async function findChrome(): Promise<string | null> {
  if (process.platform === 'win32') {
    return firstFile(windowsCandidates(['Google', 'Chrome', 'Application', 'chrome.exe']));
  }
  if (process.platform === 'darwin') {
    return firstFile(macApps('Google Chrome'));
  }
  return findLinux(
    ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    ['/opt/google/chrome/chrome'],
  );
}

async function findEdge(): Promise<string | null> {
  if (process.platform === 'win32') {
    return firstFile(windowsCandidates(['Microsoft', 'Edge', 'Application', 'msedge.exe']));
  }
  if (process.platform === 'darwin') {
    return firstFile(macApps('Microsoft Edge'));
  }
  return findLinux(
    ['microsoft-edge', 'microsoft-edge-stable'],
    ['/opt/microsoft/msedge/msedge'],
  );
}

function windowsCandidates(parts: string[]): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.ProgramW6432,
  ];
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
    const found = await commandOnPath(name);
    if (found) return found;
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

async function downloadChromeForTesting(): Promise<string> {
  const cacheDir = browsersDir();
  const installed = await getInstalledBrowsers({ cacheDir });
  const cached = installed.find((browser) => browser.browser === BrowserProduct.CHROME);
  if (cached) {
    logDaemon(`browser: cached Chrome for Testing ${cached.executablePath}`);
    return cached.executablePath;
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('No system Chrome or Edge was found, and the platform is not supported for Chrome for Testing.');
  }
  const buildId = await resolveBuildId(BrowserProduct.CHROME, platform, 'stable');
  logDaemon(`downloading Chrome for Testing ${buildId} (${platform})`);
  let lastBucket = -1;
  const result = await install({
    browser: BrowserProduct.CHROME,
    buildId,
    cacheDir,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      if (totalBytes <= 0) return;
      const bucket = Math.floor((downloadedBytes / totalBytes) * 10);
      if (bucket === lastBucket) return;
      lastBucket = bucket;
      logDaemon(`Chrome for Testing download ${bucket * 10}%`);
    },
  });
  logDaemon(`browser: Chrome for Testing ${result.executablePath}`);
  return result.executablePath;
}
