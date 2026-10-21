import puppeteer, { type Browser } from 'puppeteer-core';
import { resolveBrowserForLaunch, type ResolvedBrowser } from '../browser/resolve.js';
import { defaultProfileDir, ensureHomeLayout, errorText, logDaemon } from '../config/paths.js';
import { browserDownloadingMessage, RelayError } from '../errors.js';
import type { ActInput, DaemonStatus, PageBody, WaitInput } from '../protocol.js';
import { PageController } from './page.js';

export type { PageBody };

export type BrowserPhase =
  | { state: 'idle' }
  | { state: 'resolving' }
  | { state: 'downloading'; percent: number }
  | { state: 'launching' }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export interface BrowserStateView {
  state: BrowserPhase['state'];
  percent?: number;
  message?: string;
}

export interface BrowserControl {
  browserState(): BrowserStateView;
  status(): Promise<DaemonStatus>;
  navigate(url: string): Promise<PageBody>;
  snapshot(options?: { mode?: 'full' | 'diff'; maxRows?: number }): Promise<PageBody>;
  act(input: ActInput): Promise<PageBody>;
  waitFor(input: WaitInput): Promise<PageBody & { matched: boolean }>;
}

type LaunchFn = typeof puppeteer.launch;

export interface BrowserSessionOptions {
  resolveExecutable?: (onProgress?: (percent: number) => void) => Promise<ResolvedBrowser & { path: string }>;
  launchBrowser?: LaunchFn;
}

const READY_WAIT_MS = 30_000;

export class BrowserSession implements BrowserControl {
  private phase: BrowserPhase = { state: 'idle' };
  private attempt: Promise<void> | null = null;
  private browser: Browser | null = null;
  private controller: PageController | null = null;
  private executablePath = '';
  private browserVersion = '';
  private closed = false;
  private readonly resolveExecutable: NonNullable<BrowserSessionOptions['resolveExecutable']>;
  private readonly launchBrowser: LaunchFn;

  constructor(options: BrowserSessionOptions = {}) {
    this.resolveExecutable = options.resolveExecutable ?? resolveBrowserForLaunch;
    this.launchBrowser = options.launchBrowser ?? ((launchOptions) => puppeteer.launch(launchOptions));
  }

  browserState(): BrowserStateView {
    if (this.phase.state === 'downloading') return { state: 'downloading', percent: this.phase.percent };
    if (this.phase.state === 'error') return { state: 'error', message: this.phase.message };
    return { state: this.phase.state };
  }

  warmUp(): void {
    if (this.closed || this.isReady() || this.attempt) return;
    this.attempt = this.launchAttempt().finally(() => {
      this.attempt = null;
    });
  }

  async status(): Promise<DaemonStatus> {
    const browser: DaemonStatus['browser'] = { ...this.browserState() };
    const body: DaemonStatus = {
      pid: process.pid,
      uptime: Math.round(process.uptime() * 10) / 10,
      browser,
    };
    if (!this.isReady()) return body;
    browser.executablePath = this.executablePath;
    browser.version = this.browserVersion;
    try {
      const page = await this.currentPage();
      if (!page) return body;
      body.page = { url: page.url(), title: await page.title() };
    } catch (err) {
      logDaemon(`status page read failed: ${errorText(err)}`);
    }
    return body;
  }

  async navigate(url: string): Promise<PageBody> {
    const controller = await this.controllerReady();
    return controller.navigate(url);
  }

  async snapshot(options?: { mode?: 'full' | 'diff'; maxRows?: number }): Promise<PageBody> {
    const controller = await this.controllerReady();
    return controller.snapshot(options?.mode ?? 'full', options?.maxRows);
  }

  async act(input: ActInput): Promise<PageBody> {
    const controller = await this.controllerReady();
    return controller.act(input);
  }

  async waitFor(input: WaitInput): Promise<PageBody & { matched: boolean }> {
    const controller = await this.controllerReady();
    return controller.waitFor(input);
  }

  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    if (this.controller) {
      await this.controller.dispose().catch(() => undefined);
      this.controller = null;
    }
    if (browser) await browser.close().catch(() => undefined);
  }

  private async controllerReady(): Promise<PageController> {
    await this.ensureReady();
    if (this.controller) return this.controller;
    const browser = this.browser;
    if (!browser?.connected) throw new Error('Browser is not connected');
    const page = await acquirePage(browser);
    this.controller = await PageController.attach(page);
    return this.controller;
  }

  private async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('Browser session is closed');
    if (this.isReady()) return;
    const initial = this.downloadError();
    if (initial) throw initial;

    // Re-read phase after every await. The background launch mutates it.
    if (this.launchInFlight()) {
      await this.waitPhase(READY_WAIT_MS);
      if (this.isReady()) return;
      const waited = this.downloadError();
      if (waited) throw waited;
      if (this.launchInFlight()) {
        throw new RelayError('browser_not_ready', 'Browser is still starting. Retry shortly, or run: relaywright browser install');
      }
    }

    if (this.isReady()) return;
    const beforeRetry = this.downloadError();
    if (beforeRetry) throw beforeRetry;

    this.warmUp();
    await this.waitPhase(READY_WAIT_MS);
    if (this.isReady()) return;
    const finished = this.downloadError();
    if (finished) throw finished;
    if (this.phase.state === 'error') throw new Error(this.phase.message);
    throw new RelayError('browser_not_ready', 'Browser is still starting. Retry shortly, or run: relaywright browser install');
  }

  private downloadError(): RelayError | null {
    if (this.phase.state !== 'downloading') return null;
    return new RelayError('browser_not_ready', browserDownloadingMessage(this.phase.percent));
  }

  private launchInFlight(): boolean {
    return this.attempt !== null && this.phase.state !== 'error' && this.phase.state !== 'idle' && this.phase.state !== 'downloading';
  }

  private async waitPhase(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isReady()) return;
      if (this.phase.state === 'downloading' || this.phase.state === 'error') return;
      if (!this.attempt) return;
      await delay(50);
    }
  }

  private isReady(): boolean {
    return this.phase.state === 'ready' && this.browser?.connected === true;
  }

  private async currentPage() {
    const browser = this.browser;
    if (!browser?.connected) return null;
    const open = (await browser.pages()).filter((candidate) => !candidate.isClosed());
    return open[0] ?? null;
  }

  private async launchAttempt(): Promise<void> {
    this.phase = { state: 'resolving' };
    try {
      const resolved = await this.resolveExecutable((percent) => {
        this.phase = { state: 'downloading', percent };
      });
      if (this.closed) return;
      this.phase = { state: 'launching' };
      ensureHomeLayout();
      const headless = process.env.RELAYWRIGHT_HEADLESS === '1';
      logDaemon(`launching browser headless=${headless ? '1' : '0'} source=${resolved.source} path=${resolved.path}`);
      const browser = await this.launchBrowser({
        executablePath: resolved.path,
        headless,
        userDataDir: defaultProfileDir(),
        // Headless has no window size of its own; a fixed viewport keeps hit-testing laid out.
        defaultViewport: headless ? { width: 1280, height: 800 } : null,
        // Puppeteer's own signal handlers call process.exit and skip daemon cleanup.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: 45_000,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-sync'],
      });
      if (this.closed) {
        await browser.close().catch(() => undefined);
        return;
      }
      browser.on('disconnected', () => {
        logDaemon('browser disconnected');
        if (this.browser === browser) {
          this.browser = null;
          this.controller = null;
          if (!this.closed && this.phase.state === 'ready') {
            this.phase = { state: 'error', message: 'Browser disconnected' };
          }
        }
      });
      this.browser = browser;
      this.executablePath = resolved.path;
      this.browserVersion = await browser.version();
      this.phase = { state: 'ready' };
      logDaemon(`browser ready ${this.browserVersion}`);
    } catch (err) {
      if (this.closed) return;
      const message = errorText(err);
      logDaemon(`browser launch failed: ${message}`);
      this.phase = { state: 'error', message };
      this.browser = null;
      this.controller = null;
    }
  }
}

async function acquirePage(browser: Browser) {
  const open = (await browser.pages()).filter((candidate) => !candidate.isClosed());
  if (open.length === 0) return browser.newPage();
  const [first, ...extra] = open;
  if (!first) return browser.newPage();
  await Promise.all(extra.map((candidate) => candidate.close().catch(() => undefined)));
  return first;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
