import { fileURLToPath } from 'node:url';
import type { CDPSession, HTTPRequest, Page } from 'puppeteer-core';
import { RelayError } from '../errors.js';
import { performAction, type ActInput } from '../actions/perform.js';
import { loadDocument } from '../perception/capture.js';
import { EXTRACT_SOURCE } from '../perception/extract-script.js';
import { normalizeExtract, withExtractWarning, type ExtractInput, type ExtractResult, type ExtractRow } from '../perception/extract.js';
import { BROWSER_HELPERS } from '../perception/inspect-script.js';
import { diffLines } from '../perception/diff.js';
import { RefRegistry } from '../perception/registry.js';
import { formatLines, loginHintLine, renderSnapshotParts, type ModelItem, type TabHint, type TableFact } from '../perception/snapshot.js';
import { errorText, logDaemon } from '../config/paths.js';
import { TEXT_DEFAULT_CHARS, TEXT_MAX_CHARS, type DownloadInfo, type PageBody, type WaitInput } from '../protocol.js';
import { bounded, runPaint } from './timeout.js';
import { describeBackend, findFrameId, queryCssBackends, type FrameNode } from '../recorder/dom.js';
import { isSensitive } from '../recorder/redact.js';
import type { DescribedTarget, FrameRef, TargetDescriptor } from '../recorder/types.js';

export interface WaitBody extends PageBody {
  matched: boolean;
}

const NAV_DETECT_MS = 500;
const LOAD_CAP_MS = 15_000;
const IDLE_CAP_MS = 5_000;
const IDLE_QUIET_MS = 500;
const CALL_TIMEOUT_MS = 8_000;
const EVAL_TIMEOUT_MS = 3_000;
const PDF_TIMEOUT_MS = 60_000;

const PRINT_HOOK = `(() => {
  const w = window;
  if (typeof w.__rwPrintRequests !== 'number') w.__rwPrintRequests = 0;
  w.print = function () { w.__rwPrintRequests += 1; };
})();`;

const NAME_SHIM = `(() => {
  const w = window;
  if (typeof w.__name === 'function') return;
  w.__name = function (target, value) {
    try { Object.defineProperty(target, 'name', { value: value, configurable: true }); } catch (err) {}
    return target;
  };
})();`;

/**
 * tsx keepNames rewrites closures passed to page.evaluate so they call __name.
 * tsc output does not. The shim belongs only on pages driven by the TypeScript sources.
 */
export function needsNameShim(moduleUrl: string, argv: readonly string[] = []): boolean {
  const path = modulePath(moduleUrl);
  if (/\.(?:[cm]?ts|tsx)$/.test(path)) return true;
  return argv.some((arg) => /(?:^|[\\/])tsx(?:[\\/]|$)/.test(arg));
}

function modulePath(moduleUrl: string): string {
  const trimmed = moduleUrl.split(/[?#]/)[0] ?? moduleUrl;
  if (!trimmed.startsWith('file:')) return trimmed;
  try {
    return fileURLToPath(trimmed);
  } catch {
    return trimmed;
  }
}

function startupSource(): string {
  return needsNameShim(import.meta.url, process.argv) ? `${PRINT_HOOK}\n${NAME_SHIM}` : PRINT_HOOK;
}

export interface PageModel {
  items: ModelItem[];
  tables: TableFact[];
  url: string;
}

export interface ReplayDownload {
  id: string;
  suggestedFilename: string;
  url: string;
}

export interface SavedDownload {
  file: DownloadInfo;
  deduped: boolean;
}

export interface ReplayPage {
  navigate(url: string): Promise<PageBody>;
  capture(): Promise<PageModel>;
  currentUrl(): string;
  pageText(): Promise<string>;
  extract(input: ExtractInput): Promise<ExtractResult>;
  /** Returns the JSON text of an eval result. The caller audits and enforces the size cap. */
  evalExpr(expr: string, args: unknown[]): Promise<string>;
  queryCss(css: string, frame?: FrameRef): Promise<number[]>;
  hasVisiblePassword(): Promise<boolean>;
  isPasswordBackend(backend: number): Promise<boolean>;
  performBackend(backend: number, input: Omit<ActInput, 'ref'>): Promise<void>;
  performInput(input: ActInput): Promise<void>;
  waitFor(input: WaitInput): Promise<WaitBody>;
  excerpt(): Promise<string>;
  fullSnapshot(): Promise<string>;
  /** Increments when the main frame loads a new document and refs are reset. */
  documentEpoch(): number;
  markDownloads(): number;
  releaseDownloads(mark: number): void;
  waitForDownloadBegin(mark: number, timeoutMs: number): Promise<ReplayDownload | null>;
  waitForDownloadComplete(download: ReplayDownload): Promise<'completed' | 'canceled'>;
  saveDownload(download: ReplayDownload, dir: string, fileName: string): Promise<SavedDownload>;
  printPdf(input: { dir: string; fileName: string; landscape?: boolean }): Promise<SavedDownload>;
}

export class PageController {
  readonly registry = new RefRegistry();
  private baseline: string[] | null = null;
  private navigatedSinceBaseline = false;
  private loaderId = '';
  private epoch = 0;
  private readonly pending = new Map<HTTPRequest, number>();
  private lastNetwork = 0;
  private disposed = false;
  private model: { items: ModelItem[]; tables: TableFact[] } = { items: [], tables: [] };

  private constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async attach(page: Page): Promise<PageController> {
    const cdp = await bounded(page.createCDPSession(), CALL_TIMEOUT_MS, 'cdp');
    const controller = new PageController(page, cdp);
    await bounded(cdp.send('Page.enable'), CALL_TIMEOUT_MS, 'Page.enable');
    await bounded(cdp.send('DOM.enable'), CALL_TIMEOUT_MS, 'DOM.enable').catch(() => undefined);
    await installPrintHook(page, cdp);
    const { frameTree } = await bounded(cdp.send('Page.getFrameTree'), CALL_TIMEOUT_MS, 'frame tree');
    controller.loaderId = frameTree.frame.loaderId;
    cdp.on('Page.frameNavigated', (event) => {
      // Same-document history updates use navigatedWithinDocument and keep the loader id.
      if (event.frame.parentId) return;
      controller.noteLoader(event.frame.loaderId);
    });
    page.on('request', (request) => {
      controller.pending.set(request, Date.now());
      controller.lastNetwork = Date.now();
    });
    page.on('requestfinished', (request) => {
      controller.pending.delete(request);
      controller.lastNetwork = Date.now();
    });
    page.on('requestfailed', (request) => {
      controller.pending.delete(request);
      controller.lastNetwork = Date.now();
    });
    return controller;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cdp.detach().catch(() => undefined);
  }

  async navigate(url: string, tabs?: TabHint): Promise<PageBody> {
    // Login pages long-poll (QR codes), so network idle may never come; settle has its own cap.
    await this.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await this.settle(this.loaderId);
    return this.snapshot('full', undefined, tabs);
  }

  pageHandle(): Page {
    return this.page;
  }

  /** Milliseconds since the page last started or finished a request; 0 while one is open. */
  networkQuietMs(): number {
    return this.pending.size > 0 ? 0 : Date.now() - this.lastNetwork;
  }

  hasRef(ref: string): boolean {
    return this.registry.resolve(ref) !== undefined;
  }

  /** The next diff has no baseline, so it is returned as a full snapshot. */
  forgetBaseline(): void {
    this.baseline = null;
    this.navigatedSinceBaseline = false;
  }

  /** Visible text only. Does not move the diff baseline. */
  async visibleText(maxChars?: number): Promise<PageBody> {
    await this.paint();
    const title = await bounded(this.page.title(), EVAL_TIMEOUT_MS, 'title');
    const url = this.page.url();
    const raw = await readPageText(this.page);
    return { url, title, snapshot: formatVisibleText({ title, url, text: raw, maxChars }) };
  }

  async snapshot(mode: 'full' | 'diff', maxRows?: number, tabs?: TabHint): Promise<PageBody> {
    await this.paint();
    const title = await bounded(this.page.title(), EVAL_TIMEOUT_MS, 'title');
    const url = this.page.url();
    const rendered = await this.render(title, url, maxRows, tabs);
    const previous = this.baseline;
    const navigated = previous !== null && this.navigatedSinceBaseline;
    this.baseline = rendered.lines;
    this.navigatedSinceBaseline = false;
    if (mode === 'full' || previous === null || navigated) {
      const text = mode === 'diff' && navigated ? `(navigated: full snapshot)\n${rendered.text}` : rendered.text;
      return { url, title, snapshot: this.withLoginHint(text, title, rendered.visiblePassword) };
    }
    const changes = diffLines(previous, rendered.lines);
    const body = changes.length === 0 ? ['(no changes)'] : changes;
    return { url, title, snapshot: this.withLoginHint(formatLines(rendered.header, body), title, rendered.visiblePassword) };
  }

  async act(input: ActInput): Promise<PageBody> {
    await this.performInput(input);
    return this.snapshot('diff');
  }

  currentUrl(): string {
    return this.page.url();
  }

  pageText(): Promise<string> {
    return readPageText(this.page);
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const request = normalizeExtract(input);
    try {
      const raw = await bounded(
        this.page.evaluate(
          (source: string, payload: ExtractInput & { limit: number }) => {
            const fn = new Function('request', source) as (request: ExtractInput & { limit: number }) => {
              rows: ExtractRow[];
              truncated: boolean;
            };
            return fn(payload);
          },
          EXTRACT_SOURCE,
          request,
        ),
        10_000,
        'extract',
      );
      return withExtractWarning({ rows: raw.rows, limit: request.limit, truncated: Boolean(raw.truncated) });
    } catch (err) {
      if (err instanceof RelayError) throw err;
      const message = err instanceof Error ? err.message : 'Extract failed';
      throw new RelayError('bad_request', message.includes('Invalid selector') ? message : `Extract failed: ${message}`);
    }
  }

  async evalExpr(expr: string, args: unknown[]): Promise<string> {
    return bounded(
      this.page.evaluate((input: { expr: string; args: unknown[] }) => {
        const ctor = globalThis.eval('(async function(){}).constructor') as new (
          names: string,
          source: string,
        ) => (args: unknown[]) => Promise<unknown>;
        const fn = new ctor('args', input.expr);
        return fn(input.args).then((value) => {
          const text = JSON.stringify(value);
          if (typeof text !== 'string') throw new Error('EVAL_NOT_JSON');
          return text;
        });
      }, { expr, args }),
      10_000,
      'eval',
    );
  }

  /** Role and name come from the last snapshot model; CSS is read from the live node before it can disappear. */
  async describeRef(ref: string): Promise<DescribedTarget> {
    const backend = this.resolveRef(ref);
    const item = this.model.items.find((entry) => entry.ref === ref) ?? this.model.items.find((entry) => entry.backend === backend);
    const dom = await bounded(describeBackend(this.cdp, backend), CALL_TIMEOUT_MS, 'describe element');
    if (!dom) throw new RelayError('stale_ref', `Ref ${ref} no longer matches an element. Take a new snapshot.`);
    const name = item?.name ?? '';
    const label = item?.label;
    const role = item?.role ?? dom.tag;
    const sensitive = isSensitive({ role, name, label, sensitive: dom.password || item?.redacted === true });
    const target: TargetDescriptor = {
      role,
      name,
      tag: dom.tag,
      css: dom.css,
      cssUnique: dom.cssUnique,
    };
    if (label && label !== name) target.label = label;
    if (dom.id) target.id = dom.id;
    if (dom.text && !sensitive) target.text = dom.text;
    if (item?.frame) target.frame = item.frame;
    return { target, sensitive };
  }

  async capture(): Promise<PageModel> {
    await this.paint();
    const url = this.page.url();
    const rendered = await this.render(await bounded(this.page.title(), EVAL_TIMEOUT_MS, 'title'), url);
    this.baseline = rendered.lines;
    this.navigatedSinceBaseline = false;
    return { items: rendered.items, tables: rendered.tables, url };
  }

  async queryCss(css: string, frame?: FrameRef): Promise<number[]> {
    return bounded(this.queryCssInner(css, frame), CALL_TIMEOUT_MS, 'query css');
  }

  async hasVisiblePassword(): Promise<boolean> {
    const loaded = await bounded(loadDocument(this.cdp), CALL_TIMEOUT_MS, 'password');
    if (loaded.main.visiblePassword) return true;
    return loaded.frames.some((frame) => frame.visiblePassword === true);
  }

  async isPasswordBackend(backend: number): Promise<boolean> {
    const dom = await bounded(describeBackend(this.cdp, backend), CALL_TIMEOUT_MS, 'describe element').catch(() => null);
    return dom?.password === true;
  }

  async isPasswordRef(ref: string): Promise<boolean> {
    const backend = this.registry.resolve(ref);
    if (backend === undefined) return false;
    return this.isPasswordBackend(backend);
  }

  async performInput(input: ActInput): Promise<void> {
    const before = this.loaderId;
    await bounded(
      performAction(
        {
          page: this.page,
          cdp: this.cdp,
          resolve: (ref) => this.resolveRef(ref),
        },
        input,
      ),
      CALL_TIMEOUT_MS,
      'action',
    );
    await this.settle(before);
  }

  async performBackend(backend: number, input: Omit<ActInput, 'ref'>): Promise<void> {
    const ref = this.registry.refFor(backend);
    await this.performInput({ ...input, ref });
  }

  async printCount(): Promise<number> {
    if (this.disposed || this.page.isClosed()) return 0;
    try {
      const value = await bounded(
        this.page.evaluate(() => {
          const count = (globalThis as { __rwPrintRequests?: unknown }).__rwPrintRequests;
          return typeof count === 'number' ? count : 0;
        }),
        EVAL_TIMEOUT_MS,
        'print count',
      );
      return value;
    } catch {
      return 0;
    }
  }

  async printToPdf(options: { landscape?: boolean }): Promise<Buffer> {
    if (this.disposed || this.page.isClosed()) throw new Error('Tab is closed');
    return bounded(this.readPdf(options.landscape === true), PDF_TIMEOUT_MS, 'printToPDF');
  }

  async excerpt(): Promise<string> {
    const page = await this.snapshot('full');
    return page.snapshot.split('\n').slice(0, 40).join('\n');
  }

  documentEpoch(): number {
    return this.epoch;
  }

  async waitFor(input: WaitInput): Promise<WaitBody> {
    const timeout = input.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeout;
    let matched = false;
    for (;;) {
      matched = await this.matches(input);
      if (matched || Date.now() >= deadline) break;
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    const page = await this.snapshot('diff');
    return { matched, url: page.url, title: page.title, snapshot: page.snapshot };
  }

  private async queryCssInner(css: string, frame?: FrameRef): Promise<number[]> {
    const listed = await this.cdp.send('Page.getFrameTree');
    const frameId = findFrameId(listed.frameTree as FrameNode, frame);
    if (!frameId) return [];
    return queryCssBackends(this.cdp, frameId, css);
  }

  private async render(title: string, url: string, maxRows?: number, tabs?: TabHint) {
    const loaded = await bounded(loadDocument(this.cdp), CALL_TIMEOUT_MS, 'snapshot');
    const rendered = renderSnapshotParts({
      title,
      url,
      nodes: loaded.main.nodes,
      passwordBackendNodeIds: loaded.main.passwordBackendNodeIds,
      clickableBackendNodeIds: loaded.main.clickableBackendNodeIds,
      clickableLabels: loaded.main.clickableLabels,
      controlNames: loaded.main.controlNames,
      adaptedSelects: loaded.main.adaptedSelects,
      frames: loaded.frames,
      maxRows,
      tabs,
      registry: this.registry,
    });
    this.model = { items: rendered.items, tables: rendered.tables };
    const visiblePassword = loaded.main.visiblePassword || loaded.frames.some((frame) => frame.visiblePassword === true);
    return { ...rendered, visiblePassword };
  }

  private withLoginHint(text: string, title: string, visiblePassword: boolean): string {
    if (!visiblePassword) return text;
    const line = loginHintLine(title);
    if (text.includes(line)) return text;
    return `${text}\n${line}`;
  }

  private resolveRef(ref: string): number {
    const backend = this.registry.resolve(ref);
    if (backend === undefined) throw new RelayError('stale_ref', `Unknown ref ${ref}. Take a new snapshot.`);
    return backend;
  }

  private noteLoader(loaderId: string): void {
    if (!loaderId || loaderId === this.loaderId) return;
    const hadDocument = this.loaderId !== '';
    this.loaderId = loaderId;
    // Subresources of the old document may never report finished or failed once it is gone.
    this.pending.clear();
    if (!hadDocument) return;
    this.registry.reset();
    // A heal token's refs belong to this document. The next load makes them unusable.
    this.epoch += 1;
    if (this.baseline) this.navigatedSinceBaseline = true;
  }

  private async matches(input: WaitInput): Promise<boolean> {
    if (input.url && !this.page.url().includes(input.url)) return false;
    if (input.text) {
      const text = await readPageText(this.page).catch(() => '');
      if (!text.includes(input.text)) return false;
    }
    if (input.ref) {
      const backend = this.resolveRef(input.ref);
      const visible = await bounded(this.refVisible(backend), EVAL_TIMEOUT_MS, 'ref').catch(() => false);
      if (!visible) return false;
    }
    return true;
  }

  private async refVisible(backendNodeId: number): Promise<boolean> {
    try {
      const resolved = await this.cdp.send('DOM.resolveNode', { backendNodeId });
      const objectId = resolved.object.objectId;
      if (!objectId) return false;
      const result = await this.cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          ${BROWSER_HELPERS}
          const style = getComputedStyle(this);
          const rect = this.getBoundingClientRect();
          const selfVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          if (selfVisible) return true;
          if (this instanceof HTMLSelectElement && rwFindWidget(this)) return true;
          return false;
        }`,
        returnByValue: true,
      });
      return result.result.value === true;
    } catch {
      return false;
    }
  }

  private async settle(beforeLoader: string): Promise<void> {
    const start = Date.now();
    let quietSince: number | null = this.pending.size === 0 ? start : null;
    const idleDeadline = start + IDLE_CAP_MS;
    while (Date.now() < idleDeadline) {
      const now = Date.now();
      if (this.loaderId !== beforeLoader && now - start <= NAV_DETECT_MS + 50) {
        await this.waitForLoad(Math.max(0, start + LOAD_CAP_MS - now));
        return;
      }
      if (this.pending.size === 0) {
        if (quietSince === null) quietSince = now;
      } else {
        quietSince = null;
      }
      if (now - start >= NAV_DETECT_MS && quietSince !== null && now - quietSince >= IDLE_QUIET_MS) return;
      await delay(50);
    }
    const open = [...this.pending.keys()].slice(0, 3).map((request) => `${request.resourceType()} ${request.url().slice(0, 120)}`);
    logDaemon(`settle cap reached with ${this.pending.size} open request(s): ${open.join(', ')}`);
  }

  private async waitForLoad(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;
    const ready = await bounded(
      this.page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { readyState?: string } }).document;
        return doc?.readyState ?? 'complete';
      }),
      EVAL_TIMEOUT_MS,
      'readyState',
    ).catch(() => 'complete');
    if (ready === 'complete') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.page.off('load', onLoad);
        resolve();
      }, timeoutMs);
      const onLoad = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.page.once('load', onLoad);
    });
  }

  private async readPdf(landscape: boolean): Promise<Buffer> {
    let stream: string | undefined;
    try {
      const result = await this.cdp.send('Page.printToPDF', {
        printBackground: true,
        landscape,
        preferCSSPageSize: true,
        transferMode: 'ReturnAsStream',
      });
      if (result.stream) {
        stream = result.stream;
        return await readIoStream(this.cdp, result.stream);
      }
      if (result.data) return Buffer.from(result.data, 'base64');
      throw new RelayError('pdf_unsupported', 'Page.printToPDF returned no data');
    } catch (err) {
      if (err instanceof RelayError) throw err;
      if (isPdfUnsupported(err)) throw new RelayError('pdf_unsupported', errorText(err));
      throw err;
    } finally {
      if (stream) await this.cdp.send('IO.close', { handle: stream }).catch(() => undefined);
    }
  }

  private async paint(): Promise<void> {
    if (this.disposed) return;
    // requestAnimationFrame does not run in a hidden tab, so this must be raced.
    await runPaint((fn) => this.page.evaluate(fn));
  }
}

export function formatVisibleText(input: { title: string; url: string; text: string; maxChars?: number }): string {
  const limit = input.maxChars ?? TEXT_DEFAULT_CHARS;
  if (!Number.isInteger(limit) || limit < 1 || limit > TEXT_MAX_CHARS) {
    throw new RelayError('bad_request', `max_chars must be an integer from 1 to ${TEXT_MAX_CHARS}`);
  }
  const collapsed = input.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chars = [...collapsed];
  const truncated = chars.length > limit;
  const body = truncated ? `${chars.slice(0, limit).join('')}\n[truncated]` : collapsed;
  return `page: ${input.title}  url: ${input.url}\n${body}`;
}

async function readPageText(page: Page): Promise<string> {
  return bounded(page.evaluate(() => {
    const parts: string[] = [];
    const visit = (view: {
      document?: {
        body?: { innerText?: string };
        querySelectorAll: (selector: string) => Iterable<{ contentWindow?: unknown }>;
      };
    }): void => {
      try {
        const body = view.document?.body;
        if (body?.innerText) parts.push(body.innerText);
        const frames = view.document?.querySelectorAll('iframe,frame');
        if (!frames) return;
        for (const frame of frames) {
          try {
            const child = frame.contentWindow as typeof view | null | undefined;
            if (child) visit(child);
          } catch {
            // A cross-origin frame throws; keep reading the frames after it.
          }
        }
      } catch {
        // The document itself is unreachable.
      }
    };
    visit(globalThis as unknown as { document?: { body?: { innerText?: string }; querySelectorAll: (selector: string) => Iterable<{ contentWindow?: unknown }> } });
    return parts.join('\n');
  }), EVAL_TIMEOUT_MS, 'page text');
}

async function installPrintHook(page: Page, cdp: CDPSession): Promise<void> {
  try {
    await bounded(
      cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: startupSource(), runImmediately: true }),
      CALL_TIMEOUT_MS,
      'print hook',
    );
  } catch (err) {
    logDaemon(`print hook install failed: ${errorText(err)}`);
  }
  await bounded(
    page.evaluate(() => {
      const w = globalThis as unknown as { __rwPrintRequests?: number; print: () => void };
      if (typeof w.__rwPrintRequests !== 'number') w.__rwPrintRequests = 0;
      w.print = () => {
        w.__rwPrintRequests = (w.__rwPrintRequests ?? 0) + 1;
      };
    }),
    EVAL_TIMEOUT_MS,
    'print hook',
  ).catch(() => undefined);
}

async function readIoStream(cdp: CDPSession, handle: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle });
    chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'latin1'));
    if (chunk.eof) break;
  }
  return Buffer.concat(chunks);
}

function isPdfUnsupported(err: unknown): boolean {
  const text = errorText(err);
  return /not implemented|not supported|unsupported|print preview is not available/i.test(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
