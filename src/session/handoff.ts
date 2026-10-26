import { randomBytes } from 'node:crypto';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { recordAudit } from '../audit/log.js';
import { errorText, logDaemon } from '../config/paths.js';
import { notify } from '../notify.js';
import { visiblePasswordEvaluator } from '../perception/password-like.js';
import { loginAccountEvaluator } from '../privacy/login-account.js';
import type { HandoffView, IdentityMeta } from '../protocol.js';
import { hostOfUrl } from './domain.js';
import type { IdentityStore } from './identity.js';
import { HANDOFF_STABLE_MS, HANDOFF_TIMEOUT_MS, handoffDone, handoffStartUrl, isLoginPath } from './login.js';
import type { TabSet } from './tabs.js';
import { restoredWindowState } from './window.js';

interface Waiting {
  state: 'waiting';
  id: string;
  reason: string;
  startedAt: number;
  loginUrl: string;
  loginPage: Page;
  /** Last poll URL that still looked like the page where the person logs in. */
  lastLoginPageUrl: string | null;
  /** Last poll URL before completion. Fallback when no password page was seen. */
  humanPageUrl: string;
  siteHost: string;
  /** Last non-empty username seen on the login page. Never returned to the model. */
  loginAccount: string;
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
  identities: IdentityStore;
  noteLoginAccount?: (account: string, urls: string[]) => void;
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

  async start(reason: string, url?: string): Promise<HandoffView> {
    if (this.phase.state === 'waiting') return this.view();
    const browser = this.host.getBrowser();
    const tabs = this.host.getTabs();
    const page = tabs?.activePage();
    if (!browser || !page) throw new Error('Browser is not connected');
    const id = randomBytes(16).toString('hex');
    const waiting: Waiting = {
      state: 'waiting',
      id,
      reason,
      startedAt: Date.now(),
      loginUrl: page.url(),
      loginPage: page,
      lastLoginPageUrl: null,
      humanPageUrl: page.url(),
      siteHost: hostOfUrl(page.url()) ?? '',
      loginAccount: '',
    };
    this.phase = waiting;
    try {
      const destination = await this.chooseStartUrl(page, url);
      if (destination) await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const landed = page.url();
      waiting.loginUrl = landed;
      waiting.humanPageUrl = landed;
      waiting.siteHost = hostOfUrl(landed) ?? waiting.siteHost;
      if (isLoginPath(landed)) waiting.lastLoginPageUrl = landed;
    } catch (err) {
      this.phase = { state: 'idle' };
      throw err;
    }
    recordAudit('handoff_start', { id, reason, url: waiting.loginUrl });
    await raiseWindow(browser, page);
    notify('relaywright 需要你登录', reason, waiting.siteHost || undefined);
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

  private async chooseStartUrl(page: Page, explicit?: string): Promise<string | null> {
    const current = page.url();
    if (explicit) return handoffStartUrl({ currentUrl: current, explicitUrl: explicit, loginPage: false });
    let loginPage = isLoginPath(current);
    if (!loginPage) loginPage = (await passwordPresence(page)) === 'yes';
    return handoffStartUrl({
      currentUrl: current,
      loginPage,
      rememberedLoginUrl: this.host.identities.findByUrl(current)?.login_url,
    });
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
        const active = this.host.getTabs()?.activePage();
        if (active && active !== waiting.loginPage && !active.isClosed()) waiting.loginPage = active;
        const page = waiting.loginPage;
        if (page.isClosed()) {
          await this.finish('cancelled');
          return;
        }
        const url = page.url();
        if (isLoginPath(url)) waiting.lastLoginPageUrl = url;
        const presence = await passwordPresence(page);
        if (this.phase !== waiting) return;
        if (page.isClosed()) {
          await this.finish('cancelled');
          return;
        }
        const now = page.url();
        const moved = now !== url;
        if (!moved && (presence === 'yes' || isLoginPath(now))) waiting.lastLoginPageUrl = now;
        if (moved && isLoginPath(now)) waiting.lastLoginPageUrl = now;
        if (presence !== 'unknown' && (presence === 'yes' || isLoginPath(now))) {
          const account = await readLoginAccount(page);
          if (this.phase !== waiting) return;
          if (account) waiting.loginAccount = account;
        }
        const visible = moved || presence !== 'no';
        const check = this.host.identities.findByUrl(waiting.loginUrl)?.login_check;
        const text = check?.text_absent ? await pageText(page) : '';
        if (handoffDone(waiting.loginUrl, now, visible, check, text)) {
          if (stableSince === null) stableSince = Date.now();
          if (Date.now() - stableSince >= HANDOFF_STABLE_MS) {
            await this.finish('done', now);
            return;
          }
        } else {
          waiting.humanPageUrl = now;
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
          const loginPageUrl = waiting.lastLoginPageUrl ?? waiting.humanPageUrl ?? waiting.loginUrl;
          identity = await this.host.identities.capture(waiting.loginUrl, finalUrl, loginPageUrl);
        } catch (err) {
          logDaemon(`identity capture failed: ${errorText(err)}`);
        }
        if (waiting.loginAccount) {
          try {
            const urls = [finalUrl, waiting.loginUrl, waiting.lastLoginPageUrl].filter((item): item is string => Boolean(item));
            this.host.noteLoginAccount?.(waiting.loginAccount, urls);
          } catch (err) {
            logDaemon(`login account capture failed: ${errorText(err)}`);
          }
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
      if (outcome === 'timeout') notify('relaywright 登录等待超时', waiting.reason, waiting.siteHost || undefined);
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
    const current = await browserSession.send('Browser.getWindowBounds', { windowId });
    const restore = restoredWindowState(current.bounds.windowState);
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: restore } });
    await page.bringToFront();
  } catch (err) {
    logDaemon(`handoff raise failed: ${errorText(err)}`);
  } finally {
    await pageSession?.detach().catch(() => undefined);
    await browserSession?.detach().catch(() => undefined);
  }
}

type PasswordPresence = 'yes' | 'no' | 'unknown';

let passwordRead: Promise<boolean> | null = null;

async function passwordPresence(page: Page): Promise<PasswordPresence> {
  if (!passwordRead) {
    const reading = readVisiblePassword(page).finally(() => {
      if (passwordRead === reading) passwordRead = null;
    });
    passwordRead = reading;
  }
  try {
    // A timed-out read still means "password present" so a blip cannot finish the handoff.
    // The read itself stays single-flight so a slow evaluate cannot pile up on the page.
    return await Promise.race([
      passwordRead.then((value): PasswordPresence => (value ? 'yes' : 'no')),
      delay(1_000).then((): PasswordPresence => 'unknown'),
    ]);
  } catch {
    return 'unknown';
  }
}

async function readLoginAccount(page: Page): Promise<string> {
  try {
    const value = await Promise.race([page.evaluate(loginAccountEvaluator()), delay(1_000).then(() => '')]);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

async function readVisiblePassword(page: Page): Promise<boolean> {
  try {
    const value = await page.evaluate(visiblePasswordEvaluator());
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
