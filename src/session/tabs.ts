import type { Browser, HTTPRequest, Page, Target } from 'puppeteer-core';
import { errorText, logDaemon } from '../config/paths.js';
import { RelayError } from '../errors.js';
import type { TabHint } from '../perception/snapshot.js';
import type { TabInfo } from '../protocol.js';
import { PageController } from './page.js';
import { bounded } from './timeout.js';

const PROBE_MS = 500;
const POPUP_GRACE_MS = 150;
const NEW_TAB_WAIT_MS = 5_000;

export type SwitchKind = 'new' | 'user';

export interface TabSetOptions {
  /** Attached browsers hide tabs that were already open until the human adopts one. */
  scope?: 'all' | 'owned';
  onController?: (controller: PageController) => Promise<void>;
}

interface Slot {
  page: Page;
  target: Target;
  controller: PageController | null;
  attaching: Promise<PageController> | null;
  lastActiveAt: number;
}

export function formatTabList(tabs: readonly TabInfo[]): string {
  if (tabs.length === 0) return '(no tabs)';
  return tabs
    .map((tab) => {
      const title = tab.title.replace(/\s+/g, ' ').trim();
      const mark = tab.active ? '*' : '';
      return `${mark}[${tab.index}] ${title}  ${tab.url}`;
    })
    .join('\n');
}

export class TabSet {
  private slots: Slot[] = [];
  private active: Slot | null = null;
  private pendingSwitch: SwitchKind | null = null;
  private stopping = false;
  private followGeneration = 0;
  private followInFlight: Promise<void> = Promise.resolve();
  private fallbackTask: Promise<void> | null = null;
  /** Pages we opened ourselves must not be treated as a popup from the active tab. */
  private suppressPopup = 0;
  private readonly following = new WeakSet<Page>();
  private readonly scope: 'all' | 'owned';
  private readonly onController: ((controller: PageController) => Promise<void>) | null;
  /** Tabs the model may see. */
  private readonly owned = new Set<Page>();
  /** Tabs relaywright opened. Adopted user tabs are not in this set and are never closed. */
  private readonly created = new Set<Page>();
  private readonly ownedTargets = new Set<Target>();
  private expectingOwned = 0;
  private readonly onCreated = (target: Target): void => {
    void this.trackCreated(target);
  };
  private readonly onDestroyed = (target: Target): void => {
    this.untrack(target);
  };

  constructor(
    private readonly browser: Browser,
    options: TabSetOptions = {},
  ) {
    this.scope = options.scope ?? 'all';
    this.onController = options.onController ?? null;
  }

  activePage(): Page | null {
    const page = this.active?.page;
    if (!page || page.isClosed()) return null;
    return page;
  }

  async attachAll(): Promise<void> {
    await this.reconcile();
    await Promise.all(this.slots.map((slot) => this.controllerFor(slot).catch(() => undefined)));
  }

  async start(): Promise<void> {
    this.browser.on('targetcreated', this.onCreated);
    this.browser.on('targetdestroyed', this.onDestroyed);
    if (this.scope === 'owned') {
      await this.openBlank();
      return;
    }
    await this.reconcile();
    const visible: Slot[] = [];
    for (const slot of this.slots) {
      if ((await visibilityOf(slot.page)) === 'visible') visible.push(slot);
    }
    const chosen = visible.length === 1 ? visible[0] : this.slots[0];
    if (chosen) {
      // Already on screen, or an arbitrary default. Bringing it forward would steal the user's tab.
      chosen.lastActiveAt = Date.now();
      this.active = chosen;
      return;
    }
    await this.fallback();
  }

  async closeCreated(): Promise<void> {
    this.stopping = true;
    const pages = [...this.created];
    this.created.clear();
    for (const page of pages) {
      this.owned.delete(page);
      if (!page.isClosed()) await page.close().catch(() => undefined);
    }
  }

  async listForeign(): Promise<TabInfo[]> {
    const pages = await this.foreignPages();
    const result: TabInfo[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      if (!page) continue;
      let title = '';
      try {
        title = await bounded(page.title(), PROBE_MS, 'title');
      } catch {
        title = '';
      }
      result.push({ index: index + 1, title, url: page.isClosed() ? '' : page.url(), active: false });
    }
    return result;
  }

  async foreignPage(index: number): Promise<Page> {
    const pages = await this.foreignPages();
    const page = pages[index - 1];
    if (!page) throw new RelayError('bad_request', `No user tab ${index}`);
    return page;
  }

  async adopt(index: number, pinned?: Page): Promise<PageController> {
    if (this.scope !== 'owned') throw new RelayError('bad_request', 'Adopt is only available while attached to an existing browser');
    const pages = await this.foreignPages();
    const page = pinned ? pages.find((candidate) => candidate === pinned) : pages[index - 1];
    if (!page) throw new RelayError('bad_request', pinned ? 'That tab is gone' : `No user tab ${index}`);
    this.owned.add(page);
    this.rememberTarget(page);
    const slot = this.addPage(page);
    if (!slot) throw new RelayError('bad_request', `No user tab ${index}`);
    await this.activate(slot, 'command');
    return this.controllerFor(slot);
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    this.browser.off('targetcreated', this.onCreated);
    this.browser.off('targetdestroyed', this.onDestroyed);
    const slots = this.slots;
    this.slots = [];
    this.active = null;
    await Promise.all(slots.map((slot) => slot.controller?.dispose().catch(() => undefined) ?? Promise.resolve()));
  }

  generation(): number {
    return this.followGeneration;
  }

  peekSwitch(): SwitchKind | null {
    return this.pendingSwitch;
  }

  consumeSwitch(): SwitchKind | null {
    const kind = this.pendingSwitch;
    this.pendingSwitch = null;
    return kind;
  }

  tabHint(): TabHint {
    const index = this.active ? this.slots.indexOf(this.active) : -1;
    return { count: this.slots.length, active: index < 0 ? 1 : index + 1 };
  }

  pages(): Page[] {
    return this.slots.map((slot) => slot.page);
  }

  hasRefElsewhere(current: PageController, ref: string): boolean {
    for (const slot of this.slots) {
      const controller = slot.controller;
      if (!controller || controller === current) continue;
      if (controller.hasRef(ref)) return true;
    }
    return false;
  }

  async current(): Promise<PageController> {
    await this.reconcile();
    if (!this.active || this.active.page.isClosed() || !this.slots.includes(this.active)) await this.fallback();
    const slot = this.active;
    if (!slot) throw new Error('Browser has no tab');
    return this.controllerFor(slot);
  }

  /** Follow a headful tab change: hidden active tab, exactly one other tab visible. */
  async prepare(): Promise<PageController> {
    await this.reconcile();
    if (!this.active || this.active.page.isClosed() || !this.slots.includes(this.active)) await this.fallback();
    const active = this.active;
    if (!active) throw new Error('Browser has no tab');
    await this.followVisible(active);
    const slot = this.active ?? active;
    return this.controllerFor(slot);
  }

  async waitForPopup(since: number, opener: Page, graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (this.followGeneration === since && Date.now() < deadline) await delay(40);
    if (this.followGeneration !== since) await this.followInFlight.catch(() => undefined);
    const active = this.active?.page;
    return active !== undefined && active !== opener && !active.isClosed();
  }

  async select(index: number): Promise<PageController> {
    this.pendingSwitch = null;
    await this.reconcile();
    const slot = this.slots[index - 1];
    if (!slot) throw new RelayError('bad_request', `No tab ${index}`);
    await this.activate(slot, 'command');
    return this.controllerFor(slot);
  }

  async closeIndex(index?: number): Promise<void> {
    this.pendingSwitch = null;
    await this.reconcile();
    const slot = index === undefined ? this.active : this.slots[index - 1];
    if (!slot) throw new RelayError('bad_request', index === undefined ? 'No active tab' : `No tab ${index}`);
    if (this.scope === 'owned' && !this.created.has(slot.page)) {
      throw new RelayError('bad_request', 'That tab belongs to the browser profile. relaywright only closes tabs it opened.');
    }
    await slot.controller?.dispose().catch(() => undefined);
    slot.controller = null;
    slot.attaching = null;
    await slot.page.close().catch(() => undefined);
    await this.reconcile();
    if (!this.active || this.active.page.isClosed() || !this.slots.includes(this.active)) await this.fallback();
  }

  async openBlank(): Promise<PageController> {
    this.suppressPopup += 1;
    this.expectingOwned += 1;
    try {
      const page = await this.browser.newPage();
      this.noteCreated(page);
      const slot = this.addPage(page);
      await this.reorder();
      if (!slot) throw new Error('Could not open a tab');
      this.pendingSwitch = null;
      await this.activate(slot, 'command');
      this.pendingSwitch = null;
      return this.controllerFor(slot);
    } finally {
      this.expectingOwned -= 1;
      this.suppressPopup -= 1;
    }
  }

  async describe(): Promise<TabInfo[]> {
    const result: TabInfo[] = [];
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (!slot) continue;
      let title = '';
      try {
        title = await bounded(slot.page.title(), PROBE_MS, 'title');
      } catch {
        title = '';
      }
      result.push({
        index: index + 1,
        title,
        url: slot.page.isClosed() ? '' : slot.page.url(),
        active: slot === this.active,
      });
    }
    return result;
  }

  async reconcile(): Promise<void> {
    const all = (await this.browser.pages()).filter((page) => !page.isClosed());
    const open = this.scope === 'owned' ? all.filter((page) => this.owned.has(page)) : all;
    const seen = new Set<Page>();
    for (const page of open) {
      seen.add(page);
      this.addPage(page);
    }
    for (const slot of this.slots.filter((item) => !seen.has(item.page) || item.page.isClosed())) this.drop(slot);
    this.slots.sort((left, right) => {
      const leftAt = open.indexOf(left.page);
      const rightAt = open.indexOf(right.page);
      return (leftAt < 0 ? open.length : leftAt) - (rightAt < 0 ? open.length : rightAt);
    });
    if (this.active && (this.active.page.isClosed() || !this.slots.includes(this.active))) this.active = null;
  }

  private async followVisible(active: Slot): Promise<void> {
    if (this.slots.length < 2) return;
    if ((await visibilityOf(active.page)) !== 'hidden') return;
    const visible: Slot[] = [];
    for (const slot of this.slots) {
      if (slot === active || slot.page.isClosed()) continue;
      if ((await visibilityOf(slot.page)) === 'visible') visible.push(slot);
    }
    const only = visible.length === 1 ? visible[0] : undefined;
    if (!only) return;
    await this.activate(only, 'user');
  }

  private async activate(slot: Slot, kind: SwitchKind | 'command' | 'fallback'): Promise<void> {
    const changed = this.active !== slot;
    slot.lastActiveAt = Date.now();
    this.active = slot;
    if (changed) {
      const controller = await this.controllerFor(slot);
      controller.forgetBaseline();
      if (kind === 'user' || kind === 'new') this.pendingSwitch = kind;
    }
    await slot.page.bringToFront().catch(() => undefined);
  }

  private fallback(): Promise<void> {
    if (this.fallbackTask) return this.fallbackTask;
    this.fallbackTask = this.fallbackInner().finally(() => {
      this.fallbackTask = null;
    });
    return this.fallbackTask;
  }

  private async fallbackInner(): Promise<void> {
    if (this.stopping) return;
    await this.reconcile();
    if (this.active && !this.active.page.isClosed() && this.slots.includes(this.active)) return;
    const live = this.slots.filter((slot) => !slot.page.isClosed());
    if (live.length === 0) {
      this.suppressPopup += 1;
      this.expectingOwned += 1;
      try {
        const page = await this.browser.newPage();
        this.noteCreated(page);
        const slot = this.addPage(page);
        if (!slot) return;
        await this.activate(slot, 'fallback');
      } finally {
        this.expectingOwned -= 1;
        this.suppressPopup -= 1;
      }
      return;
    }
    const next = live.reduce((best, slot) => (slot.lastActiveAt >= best.lastActiveAt ? slot : best));
    await this.activate(next, 'fallback');
  }

  private async trackCreated(target: Target): Promise<void> {
    if (target.type() !== 'page' && target.type() !== 'webview') return;
    const page = await target.page().catch(() => null);
    if (!page) return;
    if (this.scope === 'owned' && !this.owned.has(page)) {
      const madeByUs = this.expectingOwned > 0 || this.openerWasCreated(target);
      const fromOurs = madeByUs || this.openerIsOurs(target);
      if (!fromOurs) return;
      this.owned.add(page);
      if (madeByUs) this.created.add(page);
      this.rememberTarget(page);
    }
    this.addPage(page);
    await this.reorder();
    const opener = target.opener();
    if (!opener || !this.active) return;
    const openerPage = await opener.page().catch(() => null);
    if (openerPage && openerPage === this.active.page) this.notePopup(openerPage, page);
  }

  private untrack(target: Target): void {
    const slot = this.slots.find((item) => item.target === target);
    if (!slot) return;
    this.owned.delete(slot.page);
    this.created.delete(slot.page);
    const wasActive = this.active === slot;
    this.drop(slot);
    if (wasActive && !this.stopping) {
      void this.fallback().catch((err) => logDaemon(`tab fallback failed: ${errorText(err)}`));
    }
  }

  private notePopup(opener: Page, popup: Page): void {
    if (this.stopping || this.suppressPopup > 0) return;
    if (this.active?.page !== opener) return;
    if (this.following.has(popup)) return;
    this.following.add(popup);
    this.followGeneration += 1;
    const run = (): Promise<void> => this.followNewTab(popup);
    this.followInFlight = this.followInFlight.then(run, run);
  }

  private async followNewTab(popup: Page): Promise<void> {
    try {
      await waitForRealUrl(popup, NEW_TAB_WAIT_MS);
      if (this.stopping || popup.isClosed()) return;
      // A download opened with target=_blank often stays on about:blank. Following it
      // steals the page the skill is still using.
      if (!followablePopupUrl(popup.url())) return;
      const slot = this.addPage(popup);
      await this.reorder();
      if (!slot) return;
      await this.activate(slot, 'new');
    } catch (err) {
      logDaemon(`tab follow failed: ${errorText(err)}`);
    }
  }

  private addPage(page: Page): Slot | null {
    if (page.isClosed()) return null;
    const existing = this.slots.find((slot) => slot.page === page);
    if (existing) return existing;
    let target: Target;
    try {
      target = page.target();
    } catch {
      return null;
    }
    const slot: Slot = { page, target, controller: null, attaching: null, lastActiveAt: 0 };
    page.on('popup', (popup) => {
      if (popup) this.notePopup(page, popup);
    });
    this.slots.push(slot);
    return slot;
  }

  private drop(slot: Slot): void {
    this.slots = this.slots.filter((item) => item !== slot);
    const controller = slot.controller;
    slot.controller = null;
    slot.attaching = null;
    void controller?.dispose().catch(() => undefined);
    if (this.active === slot) this.active = null;
  }

  private async reorder(): Promise<void> {
    const open = await this.browser.pages().catch(() => [] as Page[]);
    this.slots.sort((left, right) => open.indexOf(left.page) - open.indexOf(right.page));
  }

  private noteCreated(page: Page): void {
    this.owned.add(page);
    this.created.add(page);
    this.rememberTarget(page);
  }

  private rememberTarget(page: Page): void {
    try {
      this.ownedTargets.add(page.target());
    } catch {
      // The page can close before its target is readable.
    }
  }

  private openerIsOurs(target: Target): boolean {
    const opener = target.opener();
    return opener !== undefined && this.ownedTargets.has(opener);
  }

  private openerWasCreated(target: Target): boolean {
    const opener = target.opener();
    if (!opener) return false;
    for (const page of this.created) {
      try {
        if (page.target() === opener) return true;
      } catch {
        // Closed page.
      }
    }
    return false;
  }

  private async foreignPages(): Promise<Page[]> {
    if (this.scope !== 'owned') return [];
    const open = (await this.browser.pages()).filter((page) => !page.isClosed());
    return open.filter((page) => !this.owned.has(page));
  }

  private controllerFor(slot: Slot): Promise<PageController> {
    if (slot.controller) return Promise.resolve(slot.controller);
    if (!slot.attaching) {
      slot.attaching = PageController.attach(slot.page)
        .then(async (controller) => {
          if (!this.slots.includes(slot) || slot.page.isClosed()) {
            void controller.dispose().catch(() => undefined);
            throw new Error('Tab closed during attach');
          }
          if (this.onController) {
            try {
              await this.onController(controller);
            } catch (err) {
              void controller.dispose().catch(() => undefined);
              throw err;
            }
          }
          slot.controller = controller;
          return controller;
        })
        .finally(() => {
          slot.attaching = null;
        });
    }
    return slot.attaching;
  }
}

async function visibilityOf(page: Page): Promise<'visible' | 'hidden' | 'unknown'> {
  if (page.isClosed()) return 'unknown';
  try {
    const value = await bounded(
      page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { visibilityState?: string } }).document;
        return doc?.visibilityState ?? '';
      }),
      PROBE_MS,
      'visibility',
    );
    if (value === 'visible' || value === 'hidden') return value;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A popup is only worth following once it has a real page. Download targets stay blank or chrome-error. */
export function followablePopupUrl(url: string): boolean {
  if (url.length === 0 || url === 'about:blank' || url.startsWith('about:')) return false;
  if (url.startsWith('chrome-error:') || url.startsWith('chrome:')) return false;
  return true;
}

function realUrl(url: string): boolean {
  return followablePopupUrl(url);
}

async function waitForRealUrl(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (!page.isClosed() && !realUrl(page.url())) {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        page.off('framenavigated', onNav);
        page.off('requestfailed', onFailed);
        page.off('close', finish);
        resolve();
      };
      const onNav = (): void => {
        if (realUrl(page.url())) finish();
      };
      // Chrome turns a PDF opened with target=_blank into a download and aborts the popup navigation.
      const onFailed = (request: HTTPRequest): void => {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        if (!realUrl(page.url())) finish();
      };
      const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
      page.on('framenavigated', onNav);
      page.on('requestfailed', onFailed);
      page.on('close', finish);
      if (page.isClosed() || realUrl(page.url())) finish();
    });
  }
  while (!page.isClosed() && Date.now() < deadline) {
    const state = await bounded(
      page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { readyState?: string } }).document;
        return doc?.readyState ?? '';
      }),
      Math.min(PROBE_MS, Math.max(50, deadline - Date.now())),
      'readyState',
    ).catch(() => '');
    if (state === 'interactive' || state === 'complete') return;
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { POPUP_GRACE_MS };
