import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { recordAudit } from '../audit/log.js';
import { errorText, logDaemon } from '../config/paths.js';
import { notify } from '../notify.js';
import type { HandoffView, IdentityMeta } from '../protocol.js';
import type { IdentityStore } from './identity.js';
import { HANDOFF_STABLE_MS, HANDOFF_TIMEOUT_MS, handoffDone } from './login.js';
import type { TabSet } from './tabs.js';

const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 220;

export function tokensEqual(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface Waiting {
  state: 'waiting';
  id: string;
  token: string;
  reason: string;
  startedAt: number;
  loginUrl: string;
  loginPage: Page;
  statusTargetId: string | null;
}

interface Finished {
  state: 'finished';
  id: string;
  reason: string;
  startedAt: number;
  outcome: 'done' | 'cancelled' | 'timeout';
  identity?: IdentityMeta;
  elapsedMs: number;
}

export interface HandoffHost {
  getBrowser: () => Browser | null;
  getTabs: () => TabSet | null;
  getOrigin: () => string | null;
  identities: IdentityStore;
}

export class HandoffManager {
  private phase: { state: 'idle' } | Waiting | Finished = { state: 'idle' };
  private finishing = false;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly host: HandoffHost) {}

  lockReason(): string | null {
    return this.phase.state === 'waiting' ? this.phase.reason : null;
  }

  view(): HandoffView {
    if (this.phase.state === 'idle') return { state: 'idle' };
    if (this.phase.state === 'waiting') {
      const elapsed = Date.now() - this.phase.startedAt;
      const identity = this.host.identities.findByUrl(this.phase.loginUrl);
      return {
        state: 'waiting',
        id: this.phase.id,
        reason: this.phase.reason,
        elapsed_ms: elapsed,
        remaining_ms: Math.max(0, HANDOFF_TIMEOUT_MS - elapsed),
        ...(identity ? { identity } : {}),
      };
    }
    return {
      state: this.phase.outcome,
      id: this.phase.id,
      reason: this.phase.reason,
      elapsed_ms: this.phase.elapsedMs,
      remaining_ms: 0,
      ...(this.phase.identity ? { identity: this.phase.identity } : {}),
    };
  }

  async start(reason: string): Promise<HandoffView> {
    if (this.phase.state === 'waiting') return this.view();
    const browser = this.host.getBrowser();
    const tabs = this.host.getTabs();
    const page = tabs?.activePage();
    if (!browser || !page) throw new Error('Browser is not connected');
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const waiting: Waiting = {
      state: 'waiting',
      id,
      token,
      reason,
      startedAt: Date.now(),
      loginUrl: page.url(),
      loginPage: page,
      statusTargetId: null,
    };
    this.phase = waiting;
    recordAudit('handoff_start', { id, reason });
    await raiseWindow(browser, page);
    waiting.statusTargetId = await openStatusWindow(browser, this.host.getOrigin(), id, token);
    notify('relaywright 需要你登录', reason);
    void this.poll();
    return this.view();
  }

  async wait(timeoutMs: number): Promise<HandoffView> {
    if (this.phase.state !== 'waiting') return this.view();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, Math.max(0, timeoutMs));
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
    return this.view();
  }

  async cancel(): Promise<HandoffView> {
    if (this.phase.state === 'waiting') await this.finish('cancelled');
    return this.view();
  }

  async shutdown(): Promise<void> {
    if (this.phase.state === 'waiting') await this.finish('cancelled');
  }

  pageHtml(id: string, token: string): string | null {
    if (!this.tokenOk(id, token) || this.phase.state !== 'waiting') return null;
    return statusHtml(this.phase.reason, id, token);
  }

  stateForToken(id: string, token: string): HandoffView | null {
    if (!this.tokenOk(id, token)) return null;
    return this.view();
  }

  async cancelForToken(id: string, token: string): Promise<HandoffView | null> {
    if (!this.tokenOk(id, token)) return null;
    return this.cancel();
  }

  private tokenOk(id: string, token: string): boolean {
    if (this.phase.state !== 'waiting' || this.phase.id !== id) return false;
    return tokensEqual(token, this.phase.token);
  }

  private async poll(): Promise<void> {
    let stableSince: number | null = null;
    while (this.phase.state === 'waiting') {
      const waiting = this.phase;
      if (Date.now() - waiting.startedAt >= HANDOFF_TIMEOUT_MS) {
        await this.finish('timeout');
        return;
      }
      try {
        if (waiting.loginPage.isClosed()) {
          await this.finish('cancelled');
          return;
        }
        const origin = this.host.getOrigin();
        const active = this.host.getTabs()?.activePage();
        if (active && active !== waiting.loginPage && !active.isClosed()) {
          const activeUrl = active.url();
          if (!origin || !activeUrl.startsWith(origin)) waiting.loginPage = active;
        }
        const page = waiting.loginPage;
        if (page.isClosed()) {
          await this.finish('cancelled');
          return;
        }
        const url = page.url();
        if (origin && url.startsWith(origin)) {
          stableSince = null;
          await delay(1_000);
          if (this.phase !== waiting) return;
          continue;
        }
        const visible = await visiblePassword(page);
        const check = this.host.identities.findByUrl(waiting.loginUrl)?.login_check;
        const text = check?.text_absent ? await pageText(page) : '';
        if (handoffDone(waiting.loginUrl, url, visible, check, text)) {
          if (stableSince === null) stableSince = Date.now();
          if (Date.now() - stableSince >= HANDOFF_STABLE_MS) {
            await this.finish('done', url);
            return;
          }
        } else {
          stableSince = null;
        }
      } catch (err) {
        stableSince = null;
        logDaemon(`handoff poll: ${errorText(err)}`);
      }
      await delay(1_000);
      if (this.phase !== waiting) return;
    }
  }

  private async finish(outcome: 'done' | 'cancelled' | 'timeout', finalUrl?: string): Promise<void> {
    if (this.phase.state !== 'waiting' || this.finishing) return;
    this.finishing = true;
    const waiting = this.phase;
    try {
      let identity: IdentityMeta | undefined;
      if (outcome === 'done' && finalUrl) {
        try {
          identity = await this.host.identities.capture(waiting.loginUrl, finalUrl);
        } catch (err) {
          logDaemon(`identity capture failed: ${errorText(err)}`);
        }
      }
      const elapsed = Date.now() - waiting.startedAt;
      this.phase = {
        state: 'finished',
        id: waiting.id,
        reason: waiting.reason,
        startedAt: waiting.startedAt,
        outcome,
        elapsedMs: elapsed,
        ...(identity ? { identity } : {}),
      };
      recordAudit('handoff_end', {
        id: waiting.id,
        outcome,
        elapsed_ms: elapsed,
        ...(identity ? { identity: identity.name } : {}),
      });
      if (outcome === 'done') notify('已登录，relaywright 继续执行', identity?.name ?? '');
      await closeStatusWindow(this.host.getBrowser(), waiting.statusTargetId);
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) waiter();
    } finally {
      this.finishing = false;
    }
  }
}

async function raiseWindow(browser: Browser, page: Page): Promise<void> {
  let pageSession: CDPSession | null = null;
  let browserSession: CDPSession | null = null;
  try {
    pageSession = await page.createCDPSession();
    const info = await pageSession.send('Target.getTargetInfo');
    browserSession = await browser.target().createCDPSession();
    const { windowId } = await browserSession.send('Browser.getWindowForTarget', { targetId: info.targetInfo.targetId });
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await page.bringToFront();
  } catch (err) {
    logDaemon(`handoff raise failed: ${errorText(err)}`);
  } finally {
    await pageSession?.detach().catch(() => undefined);
    await browserSession?.detach().catch(() => undefined);
  }
}

async function openStatusWindow(browser: Browser, origin: string | null, id: string, token: string): Promise<string | null> {
  if (!origin) return null;
  const url = `${origin}/handoff/page/${id}?t=${encodeURIComponent(token)}`;
  let browserSession: CDPSession | null = null;
  try {
    browserSession = await browser.target().createCDPSession();
    const created = await browserSession.send('Target.createTarget', { url, newWindow: true, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
    const page = await waitForStatusPage(browser, id);
    if (page) {
      const screen = await page.evaluate(() => {
        const current = globalThis as unknown as {
          screen?: { availWidth?: number; availLeft?: number; availTop?: number };
        };
        return {
          availWidth: current.screen?.availWidth ?? 1280,
          availLeft: current.screen?.availLeft ?? 0,
          availTop: current.screen?.availTop ?? 0,
        };
      });
      const left = Math.max(0, Math.round(screen.availLeft + screen.availWidth - WINDOW_WIDTH - 12));
      const top = Math.round(screen.availTop + 12);
      const { windowId } = await browserSession.send('Browser.getWindowForTarget', { targetId: created.targetId });
      await browserSession.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left, top, width: WINDOW_WIDTH, height: WINDOW_HEIGHT, windowState: 'normal' },
      });
    }
    return created.targetId;
  } catch (err) {
    logDaemon(`handoff window failed: ${errorText(err)}`);
    return null;
  } finally {
    await browserSession?.detach().catch(() => undefined);
  }
}

async function closeStatusWindow(browser: Browser | null, targetId: string | null): Promise<void> {
  if (!browser || !targetId) return;
  const session = await browser.target().createCDPSession().catch(() => null);
  if (!session) return;
  try {
    await session.send('Target.closeTarget', { targetId });
  } catch (err) {
    logDaemon(`handoff window close failed: ${errorText(err)}`);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function waitForStatusPage(browser: Browser, id: string): Promise<Page | null> {
  const needle = `/handoff/page/${id}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pages = await browser.pages().catch(() => [] as Page[]);
    const found = pages.find((page) => page.url().includes(needle));
    if (found) return found;
    await delay(50);
  }
  return null;
}

let passwordRead: Promise<boolean> | null = null;

async function visiblePassword(page: Page): Promise<boolean> {
  if (!passwordRead) {
    const reading = readVisiblePassword(page).finally(() => {
      if (passwordRead === reading) passwordRead = null;
    });
    passwordRead = reading;
  }
  try {
    // A timed-out read still means "password present" so a blip cannot finish the handoff.
    // The read itself stays single-flight so a slow evaluate cannot pile up on the page.
    return await Promise.race([passwordRead, delay(1_000).then(() => true)]);
  } catch {
    return true;
  }
}

async function readVisiblePassword(page: Page): Promise<boolean> {
  try {
    const value = await page.evaluate(() => {
        type El = {
          getBoundingClientRect(): { width: number; height: number };
          contentDocument?: Doc | null;
        };
        type Doc = { querySelectorAll(selector: string): Iterable<El> };
        const g = globalThis as unknown as {
          document?: Doc;
          getComputedStyle(el: El): { display: string; visibility: string };
        };
        const shown = (el: El): boolean => {
          const style = g.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const walk = (doc: Doc | null | undefined): boolean => {
          if (!doc) return false;
          for (const input of doc.querySelectorAll('input[type="password"]')) {
            if (shown(input)) return true;
          }
          for (const frame of doc.querySelectorAll('iframe, frame')) {
            try {
              if (walk(frame.contentDocument)) return true;
            } catch {
              // Out-of-process frames are not inspected.
            }
          }
          return false;
        };
        return walk(g.document);
      });
    return value === true;
  } catch {
    return true;
  }
}

async function pageText(page: Page): Promise<string> {
  try {
    return await Promise.race([
      page.evaluate(() => {
        const doc = (globalThis as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText ?? '';
      }),
      delay(1_000).then(() => ''),
    ]);
  } catch {
    return '';
  }
}

function statusHtml(reason: string, id: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>relaywright</title>
<style>
  body { font-family: "Segoe UI", sans-serif; margin: 16px; color: #222; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 6px 0; word-break: break-word; }
  #clock { font-variant-numeric: tabular-nums; font-size: 20px; }
  button { margin-top: 12px; }
</style>
</head>
<body>
<h1>需要你登录</h1>
<p id="reason"></p>
<p id="who"></p>
<p id="clock"></p>
<button id="cancel" type="button">放弃</button>
<script>
const id = ${JSON.stringify(id)};
const token = ${JSON.stringify(token)};
const reasonEl = document.getElementById('reason');
const whoEl = document.getElementById('who');
const clockEl = document.getElementById('clock');
reasonEl.textContent = ${JSON.stringify(reason)};
function fmt(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}
async function tick() {
  try {
    const res = await fetch('/handoff/state/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token));
    if (!res.ok) { document.body.textContent = '交接已结束'; return; }
    const data = await res.json();
    reasonEl.textContent = data.reason || '';
    whoEl.textContent = data.identity && data.identity.name ? data.identity.name : '';
    clockEl.textContent = fmt(data.remaining_ms || 0);
    if (data.state !== 'waiting') window.close();
  } catch (err) {}
}
document.getElementById('cancel').addEventListener('click', function () {
  fetch('/handoff/cancel/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token), { method: 'POST' });
});
tick();
setInterval(tick, 1000);
</script>
</body>
</html>
`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
