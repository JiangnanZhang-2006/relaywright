import { unlink } from 'node:fs/promises';
import type { Page } from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';
import { recordAudit } from '../audit/log.js';
import { resolveBrowserForLaunch, type ResolvedBrowser } from '../browser/resolve.js';
import { defaultProfileDir, downloadsDir, ensureHomeLayout, errorText, logDaemon } from '../config/paths.js';
import { browserDownloadingMessage, RelayError, staleTabRefMessage } from '../errors.js';
import type { HandoffView, IdentityMeta } from '../protocol.js';
import { ensureTabHeader, pageHeader, switchBanner } from '../perception/snapshot.js';
import type { ActInput, DaemonStatus, DownloadInfo, DownloadInput, PageBody, PdfInput, PdfResult, TabsCommand, TabsList, WaitInput } from '../protocol.js';
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
import {
  assertSaveAs,
  canceledLine,
  sanitizeFilename,
  downloadLine,
  DownloadManager,
  preferExternalPdf,
  PRINT_REQUESTED_LINE,
  publishDownload,
  stageBytes,
  stripDownloadUrl,
} from './downloads.js';
import { HandoffManager } from './handoff.js';
import { IdentityStore } from './identity.js';
import { adoptChrome, HEADLESS_VIEWPORT, launchChrome, type LaunchBrowserRequest } from './launch.js';
import { HANDOFF_TIMEOUT_MS } from './login.js';
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
  download(input: DownloadInput): Promise<PageBody>;
  pdf(input: PdfInput): Promise<PdfResult>;
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
  requestHandoff(reason: string, url?: string): Promise<HandoffView>;
  waitHandoff(timeoutMs: number): Promise<HandoffView>;
  cancelHandoff(): Promise<HandoffView>;
  listIdentities(): IdentityMeta[];
  saveIdentity(input: { name?: string; domains?: string[] }): Promise<IdentityMeta>;
  revokeIdentity(name: string): Promise<{ name: string }>;
}

export type LaunchBrowser = (request: LaunchBrowserRequest) => Promise<Browser>;

export interface BrowserSessionOptions {
  resolveExecutable?: (onProgress?: (percent: number) => void) => Promise<ResolvedBrowser & { path: string }>;
  launchBrowser?: LaunchBrowser;
}

const READY_WAIT_MS = 30_000;
const TITLE_TIMEOUT_MS = 3_000;

export class BrowserSession implements BrowserControl {
  private phase: BrowserPhase = { state: 'idle' };
  private attempt: Promise<void> | null = null;
  private browser: Browser | null = null;
  private downloads: DownloadManager | null = null;
  private tabSet: TabSet | null = null;
  private executablePath = '';
  private browserVersion = '';
  private closed = false;
  private replayDepth = 0;
  private lastActionPage: Page | null = null;
  private keepBrowser = false;
  private releasing = false;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private readonly traceLog = new TraceLog();
  private readonly identities: IdentityStore;
  private readonly handoff: HandoffManager;
  private readonly resolveExecutable: NonNullable<BrowserSessionOptions['resolveExecutable']>;
  private readonly launchBrowser: LaunchBrowser;

  constructor(options: BrowserSessionOptions = {}) {
    this.resolveExecutable = options.resolveExecutable ?? resolveBrowserForLaunch;
    this.launchBrowser = options.launchBrowser ?? ((request) => launchChrome(request));
    this.identities = new IdentityStore(() => this.browser);
    this.handoff = new HandoffManager({
      getBrowser: () => this.browser,
      getTabs: () => this.tabSet,
      identities: this.identities,
    });
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
    if (!this.isReady() || !this.tabSet) return this.withHandoff(body);
    browser.executablePath = this.executablePath;
    browser.version = this.browserVersion;
    try {
      const controller = await this.prepareController();
      const title = await bounded(controller.pageHandle().title(), TITLE_TIMEOUT_MS, 'title').catch(() => '');
      body.page = { url: controller.currentUrl(), title };
    } catch (err) {
      logDaemon(`status page read failed: ${errorText(err)}`);
    }
    return this.withHandoff(body);
  }

  async navigate(url: string): Promise<PageBody> {
    this.assertModel();
    const controller = await this.prepareController();
    const urlBefore = controller.currentUrl();
    const actionPage = controller.pageHandle();
    const page = await controller.navigate(url, this.tabset().tabHint());
    const shown = this.finishPage(page);
    this.identities.touch(shown.url);
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
    this.assertModel();
    const controller = await this.prepareController();
    const kind = this.tabset().peekSwitch();
    const mode = options?.mode ?? 'full';
    const body = await controller.snapshot(kind ? 'full' : mode, options?.maxRows, this.tabset().tabHint());
    return this.finishPage(body);
  }

  async act(input: ActInput): Promise<PageBody> {
    this.assertModel();
    const controller = await this.prepareController();
    const urlBefore = controller.currentUrl();
    const actionPage = controller.pageHandle();
    const described = input.ref ? await this.describe(controller, input.ref) : undefined;
    if (input.ref && (input.action === 'type' || input.action === 'press') && (await controller.isPasswordRef(input.ref))) {
      recordAudit('password_blocked', { action: input.action });
      throw new RelayError('human_required', 'Passwords are typed by a human. Call request_human.');
    }
    const since = this.tabset().generation();
    const mark = this.downloader().mark();
    const printBefore = await controller.printCount();
    try {
      await controller.performInput(input);
      const switched = await this.tabset().waitForPopup(since, actionPage, input.action === 'click' ? POPUP_GRACE_MS : 0);
      // target=_blank (a PDF form, for example) can emit the download after the click returns.
      if (input.action === 'click' && this.tabset().generation() !== since) {
        await this.downloader().waitForAnyBegin(mark, 2_000);
      }
      const caught = await this.finishDownloads(mark);
      const lines = [...caught.lines];
      if (await this.printIncreased(controller, printBefore)) lines.push(PRINT_REQUESTED_LINE);
      const kind = this.tabset().peekSwitch();
      const body = await this.readSnapshot(kind || switched ? 'full' : 'diff');
      const shown = this.finishPage(body, { downloads: caught.files, lines });
      const produced = input.action === 'click' && caught.files.length > 0;
      return this.record(shown, {
        action: produced ? 'download' : input.action,
        urlBefore,
        urlAfter: shown.url,
        target: described?.target,
        value: produced ? caught.requested : valueForTrace(input.action, input.value, described ? { ...described.target, sensitive: described.sensitive } : undefined),
        suggested: produced ? caught.suggested : undefined,
        key: input.key,
        observed: observedLines(shown.snapshot),
        tabUrl: this.noteTab(actionPage, urlBefore),
      });
    } finally {
      this.downloads?.release(mark);
    }
  }

  async download(input: DownloadInput): Promise<PageBody> {
    this.assertModel();
    if (input.save_as) assertSaveAs(input.save_as);
    const controller = await this.prepareController();
    const urlBefore = controller.currentUrl();
    const actionPage = controller.pageHandle();
    const described = await this.describe(controller, input.ref);
    const since = this.tabset().generation();
    const mark = this.downloader().mark();
    const printBefore = await controller.printCount();
    const timeout = input.timeout_ms ?? 30_000;
    try {
      await controller.performInput({ action: 'click', ref: input.ref });
      await this.tabset().waitForPopup(since, actionPage, POPUP_GRACE_MS);
      const started = await this.downloader().waitForBegin(mark, timeout);
      if (!started) {
        throw new RelayError(
          'no_download',
          'No download began after the click. The click may have opened a dialog that needs another click.',
        );
      }
      const done = await this.downloader().waitForComplete(started);
      const lines: string[] = [];
      const files: DownloadInfo[] = [];
      let requested = '';
      if (done.state === 'canceled') {
        lines.push(canceledLine(done.suggestedFilename));
      } else {
        const published = await this.downloader().finalize(done, {
          dir: downloadsDir(),
          fileName: input.save_as ?? done.suggestedFilename,
          dedupe: true,
        });
        files.push(published.info);
        lines.push(downloadLine(published.info));
        requested = published.requested;
      }
      if (await this.printIncreased(controller, printBefore)) lines.push(PRINT_REQUESTED_LINE);
      const kind = this.tabset().peekSwitch();
      const body = await this.readSnapshot(kind ? 'full' : 'diff');
      const shown = this.finishPage(body, { downloads: files, lines });
      const file = files[0];
      if (!file) return shown;
      return this.record(shown, {
        action: 'download',
        urlBefore,
        urlAfter: shown.url,
        target: described.target,
        value: input.save_as ?? requested,
        suggested: done.suggestedFilename,
        timeout_ms: timeout,
        observed: observedLines(shown.snapshot),
        tabUrl: this.noteTab(actionPage, urlBefore),
      });
    } finally {
      this.downloads?.release(mark);
    }
  }

  async pdf(input: PdfInput): Promise<PdfResult> {
    this.assertModel();
    if (input.save_as) assertSaveAs(input.save_as);
    const controller = await this.prepareController();
    const url = controller.currentUrl();
    const title = await bounded(controller.pageHandle().title(), TITLE_TIMEOUT_MS, 'title').catch(() => '');
    const bytes = await controller.printToPdf({ landscape: input.landscape });
    const fileName = input.save_as ?? `${sanitizeTitle(title)}.pdf`;
    const sourcePath = await stageBytes(bytes);
    try {
      const published = await publishDownload({
        sourcePath,
        dir: downloadsDir(),
        fileName,
        url: stripDownloadUrl(url),
        mime: 'application/pdf',
        dedupe: true,
      });
      const header = pageHeader(title, url, this.tabset().tabHint());
      return this.record(
        { url, title, header, file: published.info },
        {
          action: 'pdf',
          urlBefore: url,
          urlAfter: url,
          value: input.save_as ?? published.requested,
          ...(input.landscape !== undefined ? { landscape: input.landscape } : {}),
          observed: [],
        },
      );
    } catch (err) {
      await unlink(sourcePath).catch(() => undefined);
      throw err;
    }
  }

  async waitFor(input: WaitInput): Promise<PageBody & { matched: boolean }> {
    this.assertModel();
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
    const shown = this.finishPage(result);
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
    if (input.action !== 'list') this.assertModel();
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
      return this.finishPage(await controller.snapshot('full', undefined, tabs.tabHint()));
    }
    if (input.action === 'new') {
      const controller = await tabs.openBlank();
      if (input.url) {
        const body = await controller.navigate(parseHttpUrl(input.url), tabs.tabHint());
        return this.finishPage(body);
      }
      return this.finishPage(await controller.snapshot('full', undefined, tabs.tabHint()));
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
    this.assertModel();
    this.lastActionPage = null;
    return this.traceLog.clear();
  }

  saveSkill(input: SaveSkillInput): SaveSkillResult {
    this.assertModel();
    const steps = this.traceLog.view().steps;
    const identity = this.identities.matchUrls(steps.flatMap((step) => [step.urlBefore, step.urlAfter]));
    const built = buildSkill(steps, identity ? { ...input, identity } : input);
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
    this.assertModel();
    await this.ensureReady();
    const skill = readStoredSkill(name).skill;
    this.replayDepth += 1;
    try {
      return await runMatrix(this.replayPage(), skill, input, {
        waitForHuman: input.wait_human ? (reason) => this.waitOutHandoff(reason) : undefined,
      });
    } finally {
      this.replayDepth -= 1;
      this.tabSet?.consumeSwitch();
    }
  }

  async requestHandoff(reason: string, url?: string): Promise<HandoffView> {
    await this.ensureReady();
    const target = url === undefined ? undefined : parseHttpUrl(url);
    return this.handoff.start(reason, target);
  }

  waitHandoff(timeoutMs: number): Promise<HandoffView> {
    return this.handoff.wait(timeoutMs);
  }

  cancelHandoff(): Promise<HandoffView> {
    return this.handoff.cancel();
  }

  listIdentities(): IdentityMeta[] {
    return this.identities.list();
  }

  async saveIdentity(input: { name?: string; domains?: string[] }): Promise<IdentityMeta> {
    this.assertModel();
    await this.ensureReady();
    const controller = await this.prepareController();
    return this.identities.saveManual({ ...input, pageUrl: controller.currentUrl() });
  }

  async revokeIdentity(name: string): Promise<{ name: string }> {
    this.assertModel();
    await this.ensureReady();
    await this.identities.revoke(name);
    return { name };
  }

  async close(options?: { keepBrowser?: boolean }): Promise<void> {
    this.keepBrowser = options?.keepBrowser === true;
    this.closed = true;
    // Resolving or downloading has no Chrome yet. Waiting here would deadlock a caller
    // that releases the resolver only after close returns.
    const launchInFlight = this.browser !== null || this.phase.state === 'launching' || this.phase.state === 'ready';
    if (launchInFlight && this.attempt) await this.attempt.catch(() => undefined);
    this.stopPersistTimer();
    await this.identities.persistAll().catch((err: unknown) => logDaemon(`cookie persist failed: ${errorText(err)}`));
    await this.handoff.shutdown().catch((err: unknown) => logDaemon(`handoff shutdown: ${errorText(err)}`));
    const downloads = this.downloads;
    this.downloads = null;
    if (downloads) await downloads.dispose().catch(() => undefined);
    const tabs = this.tabSet;
    this.tabSet = null;
    if (tabs) await tabs.dispose().catch(() => undefined);
    const browser = this.browser;
    this.browser = null;
    if (browser) await this.releaseBrowser(browser);
  }

  private replayPage(): ReplayPage {
    const session = this;
    let current: PageController | null = null;
    const use = async (): Promise<PageController> => {
      current = await session.prepareController();
      return current;
    };
    return {
      navigate: async (url) => {
        const body = await (await use()).navigate(url);
        session.identities.touch(body.url);
        return body;
      },
      capture: async () => (await use()).capture(),
      hasVisiblePassword: async () => (await use()).hasVisiblePassword(),
      isPasswordBackend: async (backend) => (await use()).isPasswordBackend(backend),
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
      markDownloads: () => session.downloader().mark(),
      releaseDownloads: (mark) => session.downloader().release(mark),
      waitForDownloadBegin: async (mark, timeoutMs) => {
        const pending = await session.downloader().waitForBegin(mark, timeoutMs);
        if (!pending) return null;
        return { id: pending.id, suggestedFilename: pending.suggestedFilename, url: pending.url };
      },
      waitForDownloadComplete: async (download) => {
        const done = await session.downloader().waitForComplete(download);
        return done.state === 'canceled' ? 'canceled' : 'completed';
      },
      saveDownload: async (download, dir, fileName) => {
        assertSaveAs(fileName);
        const published = await session.downloader().finalize(download, { dir, fileName, dedupe: true });
        return { file: published.info, deduped: published.deduped };
      },
      printPdf: async ({ dir, fileName, landscape }) => {
        assertSaveAs(fileName);
        const controller = await use();
        const bytes = await controller.printToPdf({ landscape });
        const sourcePath = await stageBytes(bytes);
        try {
          const published = await publishDownload({
            sourcePath,
            dir,
            fileName,
            url: stripDownloadUrl(controller.currentUrl()),
            mime: 'application/pdf',
            dedupe: true,
          });
          return { file: published.info, deduped: published.deduped };
        } catch (err) {
          await unlink(sourcePath).catch(() => undefined);
          throw err;
        }
      },
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

  private finishPage<T extends PageBody>(body: T, extra?: { downloads?: DownloadInfo[]; lines?: string[] }): T {
    const pending = this.downloads?.takeUnreported() ?? { files: [], lines: [] };
    const downloads = [...(extra?.downloads ?? []), ...pending.files];
    const lines = [...(extra?.lines ?? []), ...pending.lines];
    let snapshot = body.snapshot;
    if (lines.length > 0) snapshot = `${snapshot}\n${lines.join('\n')}`;
    const presented = this.present({ ...body, snapshot });
    if (downloads.length === 0) return presented;
    return { ...presented, downloads };
  }

  private async finishDownloads(mark: number): Promise<{ files: DownloadInfo[]; lines: string[]; suggested?: string; requested?: string }> {
    const pending = this.downloader().claimSince(mark);
    const files: DownloadInfo[] = [];
    const lines: string[] = [];
    let suggested: string | undefined;
    let requested: string | undefined;
    for (const item of pending) {
      const done = await this.downloader().waitForComplete(item);
      if (done.state === 'canceled') {
        lines.push(canceledLine(done.suggestedFilename));
        continue;
      }
      const published = await this.downloader().finalize(done, {
        dir: downloadsDir(),
        fileName: done.suggestedFilename,
        dedupe: true,
      });
      files.push(published.info);
      lines.push(downloadLine(published.info));
      if (!suggested) {
        suggested = done.suggestedFilename;
        requested = published.requested;
      }
    }
    return { files, lines, suggested, requested };
  }

  private async readSnapshot(mode: 'full' | 'diff'): Promise<PageBody> {
    const once = async (): Promise<PageBody> => {
      const current = await this.tabset().current();
      if (current.pageHandle().isClosed()) throw new Error('Target closed');
      return current.snapshot(mode, undefined, this.tabset().tabHint());
    };
    try {
      return await once();
    } catch (err) {
      if (!isClosedTarget(err)) throw err;
      logDaemon(`snapshot retried after tab close: ${errorText(err)}`);
      return once();
    }
  }

  private async printIncreased(controller: PageController, before: number): Promise<boolean> {
    if (controller.pageHandle().isClosed()) return false;
    return (await controller.printCount()) > before;
  }

  private downloader(): DownloadManager {
    const downloads = this.downloads;
    if (!downloads) throw new Error('Browser is not connected');
    return downloads;
  }

  private record<T extends { url?: string; step?: number }>(page: T, input: Parameters<TraceLog['append']>[0]): T {
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
      preferExternalPdf(defaultProfileDir());
      const headless = process.env.RELAYWRIGHT_HEADLESS === '1';
      const profile = defaultProfileDir();
      const viewport = headless ? { width: HEADLESS_VIEWPORT.width, height: HEADLESS_VIEWPORT.height } : null;
      let browser = await adoptChrome(profile, viewport);
      if (browser) {
        logDaemon('adopted browser');
      } else {
        logDaemon(`launching browser headless=${headless ? '1' : '0'} source=${resolved.source} path=${resolved.path}`);
        browser = await this.launchBrowser({
          executablePath: resolved.path,
          userDataDir: profile,
          headless,
          defaultViewport: viewport,
          timeoutMs: 45_000,
        });
      }
      if (this.closed) {
        await this.releaseBrowser(browser);
        return;
      }
      this.browser = browser;
      const downloads = await DownloadManager.start(browser);
      if (this.closed) {
        await downloads.dispose().catch(() => undefined);
        this.browser = null;
        await this.releaseBrowser(browser);
        return;
      }
      this.downloads = downloads;
      browser.on('disconnected', () => {
        logDaemon('browser disconnected');
        if (this.browser === browser) {
          this.browser = null;
          const open = this.tabSet;
          this.tabSet = null;
          const caught = this.downloads;
          this.downloads = null;
          this.stopPersistTimer();
          void caught?.dispose().catch(() => undefined);
          void open?.dispose().catch(() => undefined);
          if (!this.closed && !this.releasing && this.phase.state === 'ready') {
            this.phase = { state: 'error', message: 'Browser disconnected' };
          }
        }
      });
      const tabs = new TabSet(browser);
      this.tabSet = tabs;
      await tabs.start();
      await tabs.attachAll();
      if (this.closed) {
        await tabs.dispose().catch(() => undefined);
        await downloads.dispose().catch(() => undefined);
        this.downloads = null;
        this.tabSet = null;
        this.browser = null;
        await this.releaseBrowser(browser);
        return;
      }
      this.tabSet = tabs;
      this.executablePath = resolved.path;
      this.browserVersion = await browser.version();
      this.phase = { state: 'ready' };
      this.startPersistTimer();
      logDaemon(`browser ready ${this.browserVersion}`);
    } catch (err) {
      if (this.closed) return;
      const message = errorText(err);
      logDaemon(`browser launch failed: ${message}`);
      this.phase = { state: 'error', message };
      const tabs = this.tabSet;
      this.tabSet = null;
      void tabs?.dispose().catch(() => undefined);
      const downloads = this.downloads;
      this.downloads = null;
      void downloads?.dispose().catch(() => undefined);
      const browser = this.browser;
      this.browser = null;
      if (browser) await this.releaseBrowser(browser);
    }
  }

  private withHandoff(body: DaemonStatus): DaemonStatus {
    const handoff = this.handoff.view();
    if (handoff.state === 'idle') return body;
    return { ...body, handoff };
  }

  private assertModel(): void {
    const reason = this.handoff.lockReason();
    if (!reason) return;
    throw new RelayError('human_in_control', `A human is completing login: ${reason}. Call request_human to keep waiting.`);
  }

  private async waitOutHandoff(reason: string): Promise<'done' | 'cancelled' | 'timeout'> {
    await this.handoff.start(reason);
    const view = await this.handoff.wait(HANDOFF_TIMEOUT_MS);
    if (view.state === 'done' || view.state === 'cancelled' || view.state === 'timeout') return view.state;
    return 'timeout';
  }

  private startPersistTimer(): void {
    this.stopPersistTimer();
    const timer = setInterval(() => {
      void this.identities.persistAll().catch((err: unknown) => logDaemon(`cookie persist failed: ${errorText(err)}`));
    }, 5 * 60_000);
    timer.unref?.();
    this.persistTimer = timer;
  }

  private stopPersistTimer(): void {
    if (!this.persistTimer) return;
    clearInterval(this.persistTimer);
    this.persistTimer = null;
  }

  private async releaseBrowser(browser: Browser): Promise<void> {
    this.releasing = true;
    try {
      if (this.keepBrowser) await browser.disconnect().catch(() => undefined);
      else await browser.close().catch(() => undefined);
    } finally {
      this.releasing = false;
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

function sanitizeTitle(title: string): string {
  const name = sanitizeFilename(title.trim() || 'page');
  if (name.toLowerCase().endsWith('.pdf')) {
    const stem = name.slice(0, -4).replace(/[. ]+$/g, '');
    return stem || 'page';
  }
  return name;
}

function isClosedTarget(err: unknown): boolean {
  return /Target closed|Session closed|Connection closed|TargetClose|detached|Tab closed|Tab is closed/i.test(errorText(err));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
