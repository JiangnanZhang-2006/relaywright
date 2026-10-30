import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordAudit } from '../audit/log.js';
import { errorText, identitiesDir, identityPath, logDaemon, readTextFile } from '../config/paths.js';
import { RelayError } from '../errors.js';
import { cookieInDomains, deleteCookieParams, persistentCookieParams } from './cookies.js';
import { hostOfUrl, registrableDomain } from './domain.js';
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,253}$/;
const DEFAULT_PERSIST_DAYS = 7;
const TOUCH_MS = 60_000;
const touchedAt = new Map();
export class IdentityStore {
    browser;
    constructor(browser) {
        this.browser = browser;
    }
    list() {
        const dir = identitiesDir();
        if (!existsSync(dir))
            return [];
        const identities = [];
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.json'))
                continue;
            const meta = readIdentity(name.slice(0, -'.json'.length));
            if (meta)
                identities.push(meta);
        }
        identities.sort((left, right) => left.name.localeCompare(right.name));
        return identities;
    }
    findByUrl(url) {
        const host = hostOfUrl(url);
        if (!host)
            return undefined;
        const domain = registrableDomain(host);
        return this.list().find((identity) => identity.domains.includes(domain) || identity.name === domain);
    }
    matchUrls(urls) {
        const domains = new Set();
        for (const url of urls) {
            const host = hostOfUrl(url);
            if (!host)
                continue;
            domains.add(registrableDomain(host));
        }
        if (domains.size === 0)
            return undefined;
        const hits = this.list().filter((identity) => [...domains].every((domain) => identity.domains.includes(domain)));
        hits.sort((left, right) => left.domains.length - right.domains.length || left.name.localeCompare(right.name));
        return hits[0]?.name;
    }
    touch(url) {
        try {
            const host = hostOfUrl(url);
            if (!host)
                return;
            const domain = registrableDomain(host);
            const now = Date.now();
            for (const identity of this.list()) {
                if (!identity.domains.includes(domain))
                    continue;
                const last = touchedAt.get(identity.name) ?? 0;
                if (now - last < TOUCH_MS)
                    continue;
                touchedAt.set(identity.name, now);
                writeIdentity({ ...identity, last_used_at: new Date(now).toISOString() });
            }
        }
        catch (err) {
            logDaemon(`identity touch failed: ${errorText(err)}`);
        }
    }
    async saveManual(input) {
        const host = hostOfUrl(input.pageUrl);
        if (!host)
            throw new RelayError('bad_request', 'The active tab has no http(s) URL');
        const fallback = registrableDomain(host);
        const name = input.name?.trim() || fallback;
        assertName(name);
        const domains = (input.domains && input.domains.length > 0 ? input.domains : [fallback]).map((domain) => registrableDomain(domain));
        return this.upsert({ name, domains, loginHosts: [host] });
    }
    async capture(loginUrl, finalUrl, loginPageUrl) {
        const loginHost = hostOfUrl(loginUrl) ?? hostOfUrl(finalUrl);
        const finalHost = hostOfUrl(finalUrl) ?? loginHost;
        const pageHost = loginPageUrl ? hostOfUrl(loginPageUrl) : undefined;
        if (!loginHost || !finalHost)
            throw new Error('Login did not land on an http(s) URL');
        const hosts = [loginHost, finalHost, ...(pageHost ? [pageHost] : [])];
        const name = registrableDomain(loginHost);
        const domains = [...new Set(hosts.map((host) => registrableDomain(host)))];
        return this.upsert({ name, domains, loginHosts: [...new Set(hosts)], loginPageUrl });
    }
    async revoke(name) {
        assertName(name);
        const meta = readIdentity(name);
        if (!meta)
            throw new RelayError('bad_request', `Unknown identity ${name}`);
        await this.withCookies(async (cdp) => {
            const cookies = await listCookies(cdp);
            const pageSession = await this.pageCookieSession();
            try {
                for (const cookie of cookies) {
                    if (!cookieInDomains(cookie.domain, meta.domains))
                        continue;
                    await deleteCookie(pageSession, cookie);
                }
            }
            finally {
                if (pageSession !== cdp)
                    await pageSession.detach().catch(() => undefined);
            }
        });
        rmSync(identityPath(name), { force: true });
        touchedAt.delete(name);
        recordAudit('identity_revoked', { name });
    }
    async persistAll() {
        const identities = this.list();
        if (identities.length === 0 || !this.browser())
            return;
        await this.withCookies(async (cdp) => {
            const cookies = await listCookies(cdp);
            const now = Date.now() / 1000;
            for (const identity of identities) {
                const converted = await convertSessions(cdp, cookies, identity.domains, identity.persist_days, now);
                const matched = cookies.filter((cookie) => cookieInDomains(cookie.domain, identity.domains)).length;
                if (converted === 0 && matched === identity.cookie_count)
                    continue;
                writeIdentity({
                    ...identity,
                    cookie_count: matched,
                    saved_at: new Date().toISOString(),
                });
                if (converted > 0) {
                    recordAudit('identity_saved', { name: identity.name, cookie_count: matched, converted_count: converted });
                }
            }
        });
    }
    async upsert(input) {
        assertName(input.name);
        const domains = [...new Set(input.domains.map((domain) => registrableDomain(domain)).filter((domain) => domain.length > 0))];
        if (domains.length === 0)
            throw new RelayError('bad_request', 'Identity needs a domain');
        const existing = readIdentity(input.name);
        const now = new Date().toISOString();
        const loginUrl = input.loginPageUrl || existing?.login_url;
        const meta = {
            name: input.name,
            domains: [...new Set([...(existing?.domains ?? []), ...domains])],
            login_hosts: [...new Set([...(existing?.login_hosts ?? []), ...input.loginHosts])],
            created_at: existing?.created_at ?? now,
            saved_at: now,
            last_used_at: now,
            persist_days: existing?.persist_days ?? DEFAULT_PERSIST_DAYS,
            cookie_count: existing?.cookie_count ?? 0,
            ...(existing?.login_check ? { login_check: existing.login_check } : {}),
            ...(loginUrl ? { login_url: loginUrl } : {}),
        };
        const counts = await this.withCookies(async (cdp) => {
            const cookies = await listCookies(cdp);
            const converted = await convertSessions(cdp, cookies, meta.domains, meta.persist_days, Date.now() / 1000);
            const matched = (await listCookies(cdp)).filter((cookie) => cookieInDomains(cookie.domain, meta.domains)).length;
            return { converted, matched };
        });
        meta.cookie_count = counts.matched;
        writeIdentity(meta);
        touchedAt.set(meta.name, Date.now());
        if (!existing)
            recordAudit('identity_created', { name: meta.name, domains: meta.domains });
        recordAudit('identity_saved', { name: meta.name, cookie_count: counts.matched, converted_count: counts.converted });
        return meta;
    }
    async withCookies(fn) {
        const browser = this.browser();
        if (!browser)
            throw new RelayError('browser_not_ready', 'Browser is not connected');
        const cdp = await browser.target().createCDPSession();
        try {
            return await fn(cdp);
        }
        finally {
            await cdp.detach().catch(() => undefined);
        }
    }
    /** Network.deleteCookies is implemented on a page target, not the browser target. */
    async pageCookieSession() {
        const browser = this.browser();
        if (!browser)
            throw new RelayError('browser_not_ready', 'Browser is not connected');
        const pages = await browser.pages();
        const page = pages.find((item) => !item.isClosed());
        if (!page)
            return browser.target().createCDPSession();
        return page.createCDPSession();
    }
}
async function deleteCookie(cdp, cookie) {
    const params = deleteCookieParams(cookie);
    try {
        await cdp.send('Network.deleteCookies', params);
        return;
    }
    catch (err) {
        logDaemon(`cookie delete via network failed: ${errorText(err)}`);
    }
    await cdp.send('Storage.setCookies', {
        cookies: [
            {
                name: cookie.name,
                value: '',
                path: cookie.path || '/',
                expires: 1,
                ...(params.url ? { url: params.url } : {}),
                ...(params.domain ? { domain: params.domain } : {}),
            },
        ],
    });
}
async function listCookies(cdp) {
    const listed = await cdp.send('Storage.getCookies');
    return listed.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        session: cookie.session,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        ...(cookie.priority ? { priority: cookie.priority } : {}),
        expires: cookie.expires,
        sourceScheme: cookie.sourceScheme,
        sourcePort: cookie.sourcePort,
        ...(cookie.partitionKey !== undefined ? { partitionKey: cookie.partitionKey } : {}),
    }));
}
async function convertSessions(cdp, cookies, domains, persistDays, nowSeconds) {
    const next = [];
    for (const cookie of cookies) {
        if (!cookieInDomains(cookie.domain, domains))
            continue;
        const params = persistentCookieParams(cookie, nowSeconds, persistDays);
        if (!params)
            continue;
        next.push(params);
    }
    if (next.length === 0)
        return 0;
    await cdp.send('Storage.setCookies', {
        cookies: next.map((params) => ({
            name: params.name,
            value: params.value,
            path: params.path,
            secure: params.secure,
            httpOnly: params.httpOnly,
            expires: params.expires,
            ...(params.domain ? { domain: params.domain } : {}),
            ...(params.url ? { url: params.url } : {}),
            ...(params.sourceScheme ? { sourceScheme: params.sourceScheme } : {}),
            ...(params.sourcePort !== undefined ? { sourcePort: params.sourcePort } : {}),
            ...(params.sameSite === 'Strict' || params.sameSite === 'Lax' || params.sameSite === 'None' ? { sameSite: params.sameSite } : {}),
            ...(params.priority === 'Low' || params.priority === 'Medium' || params.priority === 'High' ? { priority: params.priority } : {}),
        })),
    });
    return next.length;
}
function assertName(name) {
    if (!NAME_PATTERN.test(name))
        throw new RelayError('bad_request', `Invalid identity name ${name}`);
}
function readIdentity(name) {
    if (!NAME_PATTERN.test(name))
        return null;
    try {
        const parsed = JSON.parse(readTextFile(identityPath(name)));
        if (!parsed || parsed.name !== name || !Array.isArray(parsed.domains))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function writeIdentity(meta) {
    mkdirSync(identitiesDir(), { recursive: true });
    const path = identityPath(meta.name);
    const tmp = join(identitiesDir(), `.${meta.name}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    try {
        renameSyncReplace(tmp, path);
    }
    catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}
function renameSyncReplace(from, to) {
    try {
        renameSync(from, to);
    }
    catch (err) {
        const code = err.code;
        if (code !== 'EPERM' && code !== 'EEXIST')
            throw err;
        rmSync(to, { force: true });
        renameSync(from, to);
    }
}
//# sourceMappingURL=identity.js.map