import { randomBytes } from 'node:crypto';
import { recordAudit } from '../audit/log.js';
import { errorText, logDaemon } from '../config/paths.js';
import { notify } from '../notify.js';
import { visiblePasswordEvaluator } from '../perception/password-like.js';
import { loginAccountEvaluator, loginAccountWatchSource, readBindingPayload } from '../privacy/login-account.js';
import { hostOfUrl } from './domain.js';
import { HANDOFF_STABLE_MS, HANDOFF_TIMEOUT_MS, handoffDone, handoffStartUrl, isLoginPath } from './login.js';
import { restoredWindowState } from './window.js';
export class HandoffManager {
    host;
    phase = { state: 'idle' };
    finishing = false;
    waiters = [];
    loginSessions = [];
    armedPages = new Set();
    constructor(host) {
        this.host = host;
    }
    lockReason() {
        return this.phase.state === 'waiting' ? this.phase.reason : null;
    }
    view() {
        if (this.phase.state === 'idle')
            return { state: 'idle' };
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
    async start(reason, url) {
        if (this.phase.state === 'waiting')
            return this.view();
        const browser = this.host.getBrowser();
        const tabs = this.host.getTabs();
        const page = tabs?.activePage();
        if (!browser || !page)
            throw new Error('Browser is not connected');
        const id = randomBytes(16).toString('hex');
        const waiting = {
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
            if (destination)
                await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 45_000 });
            const landed = page.url();
            waiting.loginUrl = landed;
            waiting.humanPageUrl = landed;
            waiting.siteHost = hostOfUrl(landed) ?? waiting.siteHost;
            if (isLoginPath(landed))
                waiting.lastLoginPageUrl = landed;
        }
        catch (err) {
            this.phase = { state: 'idle' };
            throw err;
        }
        recordAudit('handoff_start', { id, reason, url: waiting.loginUrl });
        await this.armLoginWatch(page, waiting);
        await raiseWindow(browser, page);
        notify('relaywright 需要你登录', reason, waiting.siteHost || undefined);
        void this.poll();
        return this.view();
    }
    async wait(timeoutMs) {
        if (this.phase.state !== 'waiting')
            return this.view();
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                const index = this.waiters.indexOf(done);
                if (index >= 0)
                    this.waiters.splice(index, 1);
                resolve();
            }, Math.max(0, timeoutMs));
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            this.waiters.push(done);
        });
        return this.view();
    }
    async cancel() {
        if (this.phase.state === 'waiting')
            await this.finish('cancelled');
        return this.view();
    }
    async shutdown() {
        if (this.phase.state === 'waiting')
            await this.finish('cancelled');
    }
    async chooseStartUrl(page, explicit) {
        const current = page.url();
        if (explicit)
            return handoffStartUrl({ currentUrl: current, explicitUrl: explicit, loginPage: false });
        let loginPage = isLoginPath(current);
        if (!loginPage)
            loginPage = (await passwordPresence(page)) === 'yes';
        return handoffStartUrl({
            currentUrl: current,
            loginPage,
            rememberedLoginUrl: this.host.identities.findByUrl(current)?.login_url,
        });
    }
    async poll() {
        let stableSince = null;
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
                if (active && active !== waiting.loginPage && !active.isClosed())
                    waiting.loginPage = active;
                const page = waiting.loginPage;
                if (page.isClosed()) {
                    await this.finish('cancelled');
                    return;
                }
                await this.armLoginWatch(page, waiting);
                if (this.phase !== waiting)
                    return;
                const url = page.url();
                if (isLoginPath(url))
                    waiting.lastLoginPageUrl = url;
                const presence = await passwordPresence(page);
                if (this.phase !== waiting)
                    return;
                if (page.isClosed()) {
                    await this.finish('cancelled');
                    return;
                }
                const now = page.url();
                const moved = now !== url;
                if (!moved && (presence === 'yes' || isLoginPath(now)))
                    waiting.lastLoginPageUrl = now;
                if (moved && isLoginPath(now))
                    waiting.lastLoginPageUrl = now;
                if (presence !== 'unknown' && (presence === 'yes' || isLoginPath(now))) {
                    const account = await readLoginAccount(page);
                    if (this.phase !== waiting)
                        return;
                    if (account)
                        waiting.loginAccount = account;
                }
                const visible = moved || presence !== 'no';
                const check = this.host.identities.findByUrl(waiting.loginUrl)?.login_check;
                const text = check?.text_absent ? await pageText(page) : '';
                if (handoffDone(waiting.loginUrl, now, visible, check, text)) {
                    if (stableSince === null)
                        stableSince = Date.now();
                    if (Date.now() - stableSince >= HANDOFF_STABLE_MS) {
                        await this.finish('done', now);
                        return;
                    }
                }
                else {
                    waiting.humanPageUrl = now;
                    stableSince = null;
                }
            }
            catch (err) {
                stableSince = null;
                logDaemon(`handoff poll: ${errorText(err)}`);
            }
            await delay(1_000);
            if (this.phase !== waiting)
                return;
        }
    }
    async finish(outcome, finalUrl) {
        if (this.phase.state !== 'waiting' || this.finishing)
            return;
        this.finishing = true;
        const waiting = this.phase;
        try {
            let identity;
            if (outcome === 'done' && finalUrl) {
                try {
                    const loginPageUrl = waiting.lastLoginPageUrl ?? waiting.humanPageUrl ?? waiting.loginUrl;
                    identity = await this.host.identities.capture(waiting.loginUrl, finalUrl, loginPageUrl);
                }
                catch (err) {
                    logDaemon(`identity capture failed: ${errorText(err)}`);
                }
                if (waiting.loginAccount) {
                    try {
                        const urls = [finalUrl, waiting.loginUrl, waiting.lastLoginPageUrl].filter((item) => Boolean(item));
                        this.host.noteLoginAccount?.(waiting.loginAccount, urls);
                    }
                    catch (err) {
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
            if (outcome === 'done')
                notify('已登录，relaywright 继续执行', identity?.name ?? '');
            if (outcome === 'timeout')
                notify('relaywright 登录等待超时', waiting.reason, waiting.siteHost || undefined);
            const waiters = this.waiters.splice(0);
            for (const waiter of waiters)
                waiter();
        }
        finally {
            await this.disarmLoginWatch();
            this.finishing = false;
        }
    }
    async armLoginWatch(page, waiting) {
        if (page.isClosed() || this.armedPages.has(page))
            return;
        this.armedPages.add(page);
        let cdp;
        try {
            cdp = await page.createCDPSession();
        }
        catch (err) {
            this.armedPages.delete(page);
            logDaemon(`login watch: ${errorText(err)}`);
            return;
        }
        this.loginSessions.push(cdp);
        try {
            await cdp.send('Runtime.addBinding', { name: 'rwLoginAccount' });
        }
        catch {
            // The binding already exists on this target. The listener below still receives calls.
        }
        cdp.on('Runtime.bindingCalled', (event) => {
            if (event.name !== 'rwLoginAccount' || this.phase !== waiting)
                return;
            const account = readBindingPayload(event.payload);
            if (account)
                waiting.loginAccount = account;
        });
        const source = loginAccountWatchSource();
        try {
            await cdp.send('Page.enable');
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
            await cdp.send('Runtime.evaluate', { expression: source });
        }
        catch (err) {
            logDaemon(`login watch inject: ${errorText(err)}`);
        }
    }
    async disarmLoginWatch() {
        const sessions = this.loginSessions.splice(0);
        this.armedPages.clear();
        await Promise.all(sessions.map((session) => session.detach().catch(() => undefined)));
    }
}
async function raiseWindow(browser, page) {
    let pageSession = null;
    let browserSession = null;
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
    }
    catch (err) {
        logDaemon(`handoff raise failed: ${errorText(err)}`);
    }
    finally {
        await pageSession?.detach().catch(() => undefined);
        await browserSession?.detach().catch(() => undefined);
    }
}
let passwordRead = null;
async function passwordPresence(page) {
    if (!passwordRead) {
        const reading = readVisiblePassword(page).finally(() => {
            if (passwordRead === reading)
                passwordRead = null;
        });
        passwordRead = reading;
    }
    try {
        // A timed-out read still means "password present" so a blip cannot finish the handoff.
        // The read itself stays single-flight so a slow evaluate cannot pile up on the page.
        return await Promise.race([
            passwordRead.then((value) => (value ? 'yes' : 'no')),
            delay(1_000).then(() => 'unknown'),
        ]);
    }
    catch {
        return 'unknown';
    }
}
async function readLoginAccount(page) {
    try {
        const value = await Promise.race([page.evaluate(loginAccountEvaluator()), delay(1_000).then(() => '')]);
        return typeof value === 'string' ? value.trim() : '';
    }
    catch {
        return '';
    }
}
async function readVisiblePassword(page) {
    try {
        const value = await page.evaluate(visiblePasswordEvaluator());
        return value === true;
    }
    catch {
        return true;
    }
}
async function pageText(page) {
    try {
        return await Promise.race([
            page.evaluate(() => {
                const doc = globalThis.document;
                return doc?.body?.innerText ?? '';
            }),
            delay(1_000).then(() => ''),
        ]);
    }
    catch {
        return '';
    }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=handoff.js.map