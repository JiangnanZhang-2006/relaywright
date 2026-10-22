import type { Page } from 'puppeteer-core';
import puppeteer, { type Browser } from 'puppeteer-core';
import { resolveBrowserForLaunch, type ResolvedBrowser } from '../browser/resolve.js';
import { defaultProfileDir, ensureHomeLayout, errorText, logDaemon } from '../config/paths.js';
import { browserDownloadingMessage, RelayError, staleTabRefMessage } from '../errors.js';
import { ensureTabHeader, switchBanner } from '../perception/snapshot.js';
import type { ActInput, DaemonStatus, PageBody, TabsCommand, TabsList, WaitInput } from '../protocol.js';
import { observedLines, TraceLog } from '../recorder/trace.js';
import { valueForTrace } from '../recorder/redact.js';
import type { DescribedTarget, TraceView } from '../recorder/types.js';
import { buildSkill } from '../skills/save.js';
import type { MatrixResult, RunSkillInput, SaveSkillInput, SaveSkillResult, SkillDocument, SkillHistory, SkillSummary } from '../skills/schema.js';
import { runMatrix } from '../skills/run.js';
import {
  listSkills as listStoredSkills,
  readSkill as readStoredSkill,
  rollbackSkill as rollbackStoredSkill,
  skillHistory as storedSkillHistory,
  writeSkill as writeStoredSkill,
} from '../skills/store.js';
import { PageController, type ReplayPage } from './page.js';
import { formatTabList, POPUP_GRACE_MS, TabSet } from './tabs.js';
import { bounded } from './timeout.js';

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
  tabs(input: TabsCommand): Promise<TabsList | PageBody>;
  trace(): TraceView;
  clearTrace(): TraceView;
  saveSkill(input: SaveSkillInput): SaveSkillResult;
  listSkills(): SkillSummary[];
  readSkill(name: string, version?: number): SkillDocument;
  skillHistory(name: string): SkillHistory;
  rollbackSkill(name: string, to: number): SkillDocument;
  runSkill(name: string, input: RunSkillInput): Promise<MatrixResult>;
}

type LaunchFn = typeof puppeteer.launch;

export interface BrowserSessionOptions {
  resolveExecutable?: (onProgress?: (percent: number) => void) => Promise<ResolvedBrowser & { path: string }>;
  launchBrowser?: LaunchFn;
}

const READY_WAIT_MS = 30_000;
const TITLE_TIMEOUT_MS = 3_000;

export class BrowserSession implements BrowserControl {
  private phase: BrowserPhase = { state: 'idle' };
  private attempt: Promise<void> | null = null;
  private browser: Browser | null = null;
  private tabSet: TabSet | null = null;
  private executablePath = '';
  private browserVersion = '';
  private closed = false;
  private replayDepth = 0;
  private lastActionPage: Page | null = null;
  private readonly traceLog = new TraceLog();
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
    if (!this.isReady() || !this.tabSet) return body;
    browser.executablePath = this.executablePath;
    browser.version = this.browserVersion;
    try {
      const controller = await this.prepareController();
      const title = await bounded(controller.pageHandle().title(), TITLE_TIMEOUT_MS, 'title').catch(() => '');
      body.page = { url: controller.currentUrl(), title };
    } catch (err) {
      logDaemon(`status page read failed: ${errorText(err)}`);
    }
    return body;
  }

  async navigate(url: string): Promise<PageBody> {
    const controller = await this.prepareController();
    const urlBefore = controller.currentUrl();
    const actionPage = controller.pageHandle();
    const page = await controller.navigate(url, this.tabset().tabHint());
    const shown = this.present(page);
    return this.record(shown, {
      action: 'goto',
      urlBefore,
      urlAfter: shown.url,
      value: url,
      observed: observedLines(shown.snapshot),
      tabUrl: this.noteTab(actionPage, urlBefore),
    });
  }

  async snapshot(options?: { mode?: 'full' | 'diff'; maxRows?: number }): Promise<PageBody> {
    const controller = await this.prepareController();
    const kind = this.tabset().peekSwitch();
    const mode = options?.mode ?? 'full';
    const body = await controller.snapshot(kind ? 'full' : mode, options?.maxRows, this.tabset().tabHint());
    return this.present(body);
  }

  async act(input: ActInput): Promise<PageBody> {
    const controller = await this.prepareController();
    const urlBefore = controller.currentUrl();
    const actionPage = controller.pageHandle();
    const described = input.ref ? await this.describe(controller, input.ref) : undefined;
    const since = this.tabset().generation();
    await controller.performInput(input);
    const switched = await this.tabset().waitForPopup(since, actionPage, input.action === 'click' ? POPUP_GRACE_MS : 0);
    const current = switched ? await this.tabset().current() : controller;
    const kind = this.tabset().peekSwitch();
    const body = await current.snapshot(kind || switched ? 'full' : 'diff', undefined, this.tabset().tabHint());
    const shown = this.present(body);
    return this.record(shown, {
      action: input.action,
      urlBefore,
      urlAfter: shown.url,
      target: described?.target,
      value: valueForTrace(input.action, input.value, described ? { ...described.target, sensitive: described.sensitive } : undefined),
      key: input.key,
      observed: observedLines(shown.snapshot),
      tabUrl: this.noteTab(actionPage, urlBefore),
    });
  }

  async waitFor(input: WaitInput): Promise<PageBody & { matched: boolean }> {
    const controller = await this.prepareController();
    const urlBefore = controller.currentUrl();
    const actionPage = controller.pageHandle();
    const described = input.ref ? await this.describe(controller, input.ref) : undefined;
    const since = this.tabset().generation();
    let result = await controller.waitFor(input);
    const switched = await this.tabset().waitForPopup(since, actionPage, 0);
    if (switched) {
      const current = await this.tabset().current();
      const body = await current.snapshot('full', undefined, this.tabset().tabHint());
      result = { matched: result.matched, url: body.url, title: body.title, snapshot: body.snapshot };
    }
    const shown = this.present(result);
    const withMatch = { ...shown, matched: result.matched };
    if (!result.matched) return withMatch;
    return this.record(withMatch, {
      action: 'wait',
      urlBefore,
      urlAfter: shown.url,
      target: described?.target,
      value: input.text,
      url: input.url,
      timeout_ms: input.timeoutMs,
      observed: observedLines(shown.snapshot),
      tabUrl: this.noteTab(actionPage, urlBefore),
    });
  }

  async tabs(input: TabsCommand): Promise<TabsList | PageBody> {
    await this.ensureReady();
    const tabs = this.tabset();
    if (input.action === 'list') {
      if (this.replayDepth > 0) await tabs.current();
      else await tabs.prepare();
      const described = await tabs.describe();
      return { tabs: described, text: formatTabList(described) };
    }
    if (input.action === 'select') {
      if (input.index === undefined) throw new RelayError('bad_request', 'index is required for select');
      const controller = await tabs.select(input.index);
      return this.present(await controller.snapshot('full', undefined, tabs.tabHint()));
    }
    if (input.action === 'new') {
      const controller = await tabs.openBlank();
      if (input.url) {
        const body = await controller.navigate(parseHttpUrl(input.url), tabs.tabHint());
        return this.present(body);
      }
      return this.present(await controller.snapshot('full', undefined, tabs.tabHint()));
    }
    await tabs.closeIndex(input.index);
    const described = await tabs.describe();
    return { tabs: described, text: formatTabList(described) };
  }

  async openPages(): Promise<Page[]> {
    await this.ensureReady();
    await this.tabset().reconcile();
    return this.tabset().pages();
  }

  trace(): TraceView {
    return this.traceLog.view();
  }

  clearTrace(): TraceView {
    this.lastActionPage = null;
    return this.traceLog.clear();
  }

  saveSkill(input: SaveSkillInput): SaveSkillResult {
    const built = buildSkill(this.traceLog.view().steps, input);
    const stored = writeStoredSkill(built.skill, input.overwrite === true);
    return {
      name: built.skill.name,
      version: stored.version,
      path: stored.path,
      yaml: stored.yaml,
      warnings: built.warnings,
    };
  }

  listSkills(): SkillSummary[] {
    return listStoredSkills();
  }

  readSkill(name: string, version?: number): SkillDocument {
    return readStoredSkill(name, version);
  }

  skillHistory(name: string): SkillHistory {
    return storedSkillHistory(name);
  }

  rollbackSkill(name: string, to: number): SkillDocument {
    return rollbackStoredSkill(name, to);
  }

  async runSkill(name: string, input: RunSkillInput): Promise<MatrixResult> {
    await this.ensureReady();
    const skill = readStoredSkill(name).skill;
    this.replayDepth += 1;
    try {
      return await runMatrix(this.replayPage(), skill, input);
    } finally {
      this.replayDepth -= 1;
      this.tabSet?.consumeSwitch();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const tabs = this.tabSet;
    this.tabSet = null;
    if (tabs) await tabs.dispose().catch(() => undefined);
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => undefined);
  }

  private replayPage(): ReplayPage {
    const session = this;
    let current: PageController | null = null;
    const use = async (): Promise<PageController> => {
      current = await session.prepareController();
      return current;
    };
    return {
      navigate: async (url) => (await use()).navigate(url),
      capture: async () => (await use()).capture(),
      currentUrl: () => {
        if (!current) throw new Error('Replay has not opened a page');
        return current.currentUrl();
      },
      pageText: async () => (await use()).pageText(),
      queryCss: async (css, frame) => (await use()).queryCss(css, frame),
      performBackend: async (backend, input) => {
        const page = await use();
        const opener = page.pageHandle();
        const since = session.tabset().generation();
        await page.performBackend(backend, input);
        await session.tabset().waitForPopup(since, opener, input.action === 'click' ? POPUP_GRACE_MS : 0);
        current = await session.prepareController();
      },
      performInput: async (input) => {
        const page = await use();
        const opener = page.pageHandle();
        const since = session.tabset().generation();
        await page.performInput(input);
        await session.tabset().waitForPopup(since, opener, input.action === 'click' ? POPUP_GRACE_MS : 0);
        current = await session.prepareController();
      },
      waitFor: async (input) => (await use()).waitFor(input),
      excerpt: async () => (await use()).excerpt(),
    };
  }

  private present<T extends PageBody>(body: T): T {
    const tabs = this.tabSet;
    const kind = tabs?.consumeSwitch() ?? null;
    let snapshot = ensureTabHeader(body.snapshot, tabs?.tabHint());
    if (kind) snapshot = `${switchBanner(kind, body.title)}\n${snapshot}`;
    return { ...body, snapshot };
  }

  private noteTab(page: Page, url: string): string | undefined {
    const previous = this.lastActionPage;
    this.lastActionPage = page;
    if (!previous || previous === page) return undefined;
    return url;
  }

  private async describe(controller: PageController, ref: string): Promise<DescribedTarget> {
    if (!controller.hasRef(ref) && this.tabset().hasRefElsewhere(controller, ref)) {
      throw new RelayError('stale_ref', staleTabRefMessage(ref));
    }
    return controller.describeRef(ref);
  }

  private record<T extends PageBody>(page: T, input: Parameters<TraceLog['append']>[0]): T {
    if (this.replayDepth > 0) return page;
    const step = this.traceLog.append(input);
    return { ...page, step: step.n };
  }

  private tabset(): TabSet {
    const tabs = this.tabSet;
    if (!tabs) throw new Error('Browser is not connected');
    return tabs;
  }

  private async prepareController(): Promise<PageController> {
    await this.ensureReady();
    const tabs = this.tabset();
    if (this.replayDepth > 0) return tabs.current();
    return tabs.prepare();
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
    return this.phase.state === 'ready' && this.browser?.connected === true && this.tabSet !== null;
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
        args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-popup-blocking'],
      });
      if (this.closed) {
        await browser.close().catch(() => undefined);
        return;
      }
      this.browser = browser;
      browser.on('disconnected', () => {
        logDaemon('browser disconnected');
        if (this.browser === browser) {
          this.browser = null;
          const open = this.tabSet;
          this.tabSet = null;
          void open?.dispose().catch(() => undefined);
          if (!this.closed && this.phase.state === 'ready') {
            this.phase = { state: 'error', message: 'Browser disconnected' };
          }
        }
      });
      const tabs = new TabSet(browser);
      this.tabSet = tabs;
      await tabs.start();
      if (this.closed) {
        await tabs.dispose().catch(() => undefined);
        await browser.close().catch(() => undefined);
        this.browser = null;
        return;
      }
      this.tabSet = tabs;
      this.executablePath = resolved.path;
      this.browserVersion = await browser.version();
      this.phase = { state: 'ready' };
      logDaemon(`browser ready ${this.browserVersion}`);
    } catch (err) {
      if (this.closed) return;
      const message = errorText(err);
      logDaemon(`browser launch failed: ${message}`);
      this.phase = { state: 'error', message };
      const tabs = this.tabSet;
      this.tabSet = null;
      void tabs?.dispose().catch(() => undefined);
      const browser = this.browser;
      this.browser = null;
      if (browser) await browser.close().catch(() => undefined);
    }
  }
}

function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError('bad_request', `Invalid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayError('bad_request', `Only http and https URLs are supported, got ${url.protocol}`);
  }
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
