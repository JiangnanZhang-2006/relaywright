import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { RelayError } from '../errors.js';
import { readDevToolsEndpoint } from './launch.js';
export const ATTACH_TIMEOUT_MS = 60_000;
export const ATTACH_ALLOW_HINT = '请在 Chrome 里点「允许」以连接 relaywright';
export const ATTACH_TRANSFERS_MESSAGE = 'attach_downloads_disabled: downloads and PDF export are off while attached to an existing Chrome, because the download folder cannot be limited to relaywright tabs without changing that profile.';
export function defaultChromeUserDataDir() {
    if (process.platform === 'win32')
        return join(process.env.LOCALAPPDATA ?? homedir(), 'Google', 'Chrome', 'User Data');
    if (process.platform === 'darwin')
        return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    return join(homedir(), '.config', 'google-chrome');
}
export function shouldWarmOnStartup(config) {
    const mode = config.browser?.mode ?? 'separate';
    if (mode === 'separate')
        return true;
    return (config.attach?.reconnect ?? 'lazy') === 'eager';
}
export function attachIsDeferred(config, phase, connected) {
    if (connected || phase !== 'idle')
        return false;
    const mode = config.browser?.mode ?? 'separate';
    if (mode !== 'daily' && mode !== 'cdp')
        return false;
    return (config.attach?.reconnect ?? 'lazy') !== 'eager';
}
/** Reads DevToolsActivePort only. Does not open /json/version. */
export function resolveDevToolsFile(profileDir) {
    const existing = readDevToolsEndpoint(profileDir);
    if (!existing) {
        throw new RelayError('attach_failed', `No DevToolsActivePort in ${profileDir}. Open chrome://inspect/#remote-debugging and allow remote debugging for this browser.`);
    }
    return {
        mode: 'daily',
        endpoint: existing.browserWSEndpoint,
        endpointKind: 'devtools-file',
        userDataDir: profileDir,
    };
}
export async function resolveCdpUrl(cdpUrl) {
    const trimmed = cdpUrl.trim();
    if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
        return { mode: 'cdp', endpoint: trimmed, endpointKind: 'cdp-ws', cdpUrl: trimmed };
    }
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new RelayError('bad_request', 'cdp_url must be an http(s) or ws(s) URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RelayError('bad_request', 'cdp_url must be an http(s) or ws(s) URL');
    }
    const probed = await probeVersion(url);
    if (probed)
        return { mode: 'cdp', endpoint: probed, endpointKind: 'cdp-http', cdpUrl: trimmed };
    if (url.pathname.startsWith('/devtools/')) {
        const ws = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${url.pathname}`;
        return { mode: 'cdp', endpoint: ws, endpointKind: 'cdp-ws', cdpUrl: trimmed };
    }
    throw new RelayError('attach_failed', '/json/version did not return a WebSocket URL. Pass the ws URL from DevToolsActivePort, or attach with --user-data-dir.');
}
export async function resolveAttachRequest(input) {
    const chosen = [input.auto ? 'auto' : '', input.cdpUrl ? 'cdp' : '', input.userDataDir ? 'dir' : ''].filter((item) => item.length > 0);
    if (chosen.length !== 1)
        throw new RelayError('bad_request', 'Choose one of --auto, --cdp-url, or --user-data-dir');
    if (input.cdpUrl)
        return resolveCdpUrl(input.cdpUrl);
    return resolveDevToolsFile(input.userDataDir || defaultChromeUserDataDir());
}
export async function resolveStoredAttach(config) {
    const mode = config.browser?.mode;
    if (mode === 'cdp') {
        const cdpUrl = config.browser?.cdp_url;
        if (!cdpUrl)
            throw new RelayError('attach_failed', 'cdp mode has no cdp_url. Run: relaywright daemon attach --cdp-url <url>');
        return resolveCdpUrl(cdpUrl);
    }
    if (mode === 'daily')
        return resolveDevToolsFile(config.browser?.user_data_dir || defaultChromeUserDataDir());
    throw new RelayError('attach_failed', 'Browser mode is separate');
}
export async function connectWebSocket(endpoint, timeoutMs) {
    return puppeteer.connect({
        browserWSEndpoint: endpoint,
        defaultViewport: null,
        protocolTimeout: timeoutMs,
        wsOptions: { handshakeTimeout: timeoutMs },
    });
}
export function mapAttachError(err) {
    if (err instanceof RelayError)
        return err;
    const message = err instanceof Error ? err.message : 'Could not attach';
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || /timed out|timeout/i.test(message)) {
        return new RelayError('attach_timeout', `Timed out waiting for Chrome to allow the debugger. ${ATTACH_ALLOW_HINT}`);
    }
    return new RelayError('attach_failed', message);
}
async function probeVersion(base) {
    const version = new URL('/json/version', `${base.protocol}//${base.host}`);
    try {
        const response = await fetch(version, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
        if (!response.ok)
            return null;
        const body = (await response.json());
        return typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=connect.js.map