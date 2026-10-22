import type { CDPSession, Page } from 'puppeteer-core';
import { RelayError } from '../errors.js';
import { performAction, type ActInput } from '../actions/perform.js';
import { loadDocument } from '../perception/capture.js';
import { BROWSER_HELPERS } from '../perception/inspect-script.js';
import { diffLines } from '../perception/diff.js';
import { RefRegistry } from '../perception/registry.js';
import { formatLines, renderSnapshotParts, type ModelItem, type TabHint, type TableFact } from '../perception/snapshot.js';
import type { PageBody, WaitInput } from '../protocol.js';
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

export interface PageModel {
  items: ModelItem[];
  tables: TableFact[];
  url: string;
}

export interface ReplayPage {
  navigate(url: string): Promise<PageBody>;
  capture(): Promise<PageModel>;
  currentUrl(): string;
  pageText(): Promise<string>;
  queryCss(css: string, frame?: FrameRef): Promise<number[]>;
  performBackend(backend: number, input: Omit<ActInput, 'ref'>): Promise<void>;
  performInput(input: ActInput): Promise<void>;
  waitFor(input: WaitInput): Promise<WaitBody>;
  excerpt(): Promise<string>;
}

export class PageController {
  readonly registry = new RefRegistry();
  private baseline: string[] | null = null;
  private navigatedSinceBaseline = false;
  private loaderId = '';
  private inflight = 0;
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
    const { frameTree } = await bounded(cdp.send('Page.getFrameTree'), CALL_TIMEOUT_MS, 'frame tree');
    controller.loaderId = frameTree.frame.loaderId;
    cdp.on('Page.frameNavigated', (event) => {
      // Same-document history updates use navigatedWithinDocument and keep the loader id.
      if (event.frame.parentId) return;
      controller.noteLoader(event.frame.loaderId);
    });
    page.on('request', () => {
      controller.inflight += 1;
    });
    page.on('requestfinished', () => {
      controller.inflight = Math.max(0, controller.inflight - 1);
    });
    page.on('requestfailed', () => {
      controller.inflight = Math.max(0, controller.inflight - 1);
    });
    return controller;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cdp.detach().catch(() => undefined);
  }

  async navigate(url: string, tabs?: TabHint): Promise<PageBody> {
    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    return this.snapshot('full', undefined, tabs);
  }

  pageHandle(): Page {
    return this.page;
  }

  hasRef(ref: string): boolean {
    return this.registry.resolve(ref) !== undefined;
  }

  /** The next diff has no baseline, so it is returned as a full snapshot. */
  forgetBaseline(): void {
    this.baseline = null;
    this.navigatedSinceBaseline = false;
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
      return { url, title, snapshot: text };
    }
    const changes = diffLines(previous, rendered.lines);
    const body = changes.length === 0 ? ['(no changes)'] : changes;
    return { url, title, snapshot: formatLines(rendered.header, body) };
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

  async excerpt(): Promise<string> {
    const page = await this.snapshot('full');
    return page.snapshot.split('\n').slice(0, 40).join('\n');
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
      adaptedSelects: loaded.main.adaptedSelects,
      frames: loaded.frames,
      maxRows,
      tabs,
      registry: this.registry,
    });
    this.model = { items: rendered.items, tables: rendered.tables };
    return rendered;
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
    if (!hadDocument) return;
    this.registry.reset();
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
    let quietSince: number | null = this.inflight === 0 ? start : null;
    const idleDeadline = start + IDLE_CAP_MS;
    while (Date.now() < idleDeadline) {
      const now = Date.now();
      if (this.loaderId !== beforeLoader && now - start <= NAV_DETECT_MS + 50) {
        await this.waitForLoad(Math.max(0, start + LOAD_CAP_MS - now));
        return;
      }
      if (this.inflight === 0) {
        if (quietSince === null) quietSince = now;
      } else {
        quietSince = null;
      }
      if (now - start >= NAV_DETECT_MS && quietSince !== null && now - quietSince >= IDLE_QUIET_MS) return;
      await delay(50);
    }
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

  private async paint(): Promise<void> {
    if (this.disposed) return;
    // requestAnimationFrame does not run in a hidden tab, so this must be raced.
    await runPaint((fn) => this.page.evaluate(fn));
  }
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
          const child = frame.contentWindow as typeof view | null | undefined;
          if (child) visit(child);
        }
      } catch {
        // Out-of-process frames throw on contentWindow access.
      }
    };
    visit(globalThis as unknown as { document?: { body?: { innerText?: string }; querySelectorAll: (selector: string) => Iterable<{ contentWindow?: unknown }> } });
    return parts.join('\n');
  }), EVAL_TIMEOUT_MS, 'page text');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
