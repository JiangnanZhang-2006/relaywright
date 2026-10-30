import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { RelayError } from '../errors.js';
import type { GlobalConfig } from '../privacy/store.js';
import { readDevToolsEndpoint, type DevToolsRead } from './launch.js';

export const ATTACH_TIMEOUT_MS = 60_000;

export const ATTACH_ALLOW_HINT = '请在 Chrome 里点「允许」以连接 relaywright';

export const ATTACH_TRANSFERS_MESSAGE =
  'attach_downloads_disabled: downloads and PDF export are off while attached to an existing Chrome, because the download folder cannot be limited to relaywright tabs without changing that profile.';

export const DEFAULT_INSPECT_PORT = 9222;

export type EndpointKind = 'devtools-file' | 'cdp-http' | 'cdp-ws';

/** Why DevToolsActivePort was skipped. The endpoint is then the inspect-port fallback. */
export interface InspectFallback {
  read: 'missing' | 'denied';
  code?: string;
  profileDir: string;
  port: number;
}

export interface ResolvedAttach {
  mode: 'daily' | 'cdp';
  endpoint: string;
  endpointKind: EndpointKind;
  userDataDir?: string;
  cdpUrl?: string;
  inspectFallback?: InspectFallback;
}

export interface InspectProbe {
  port?: number;
  portOpen?: (port: number) => Promise<boolean>;
}

export interface AttachRequest {
  auto?: boolean;
  cdpUrl?: string;
  userDataDir?: string;
}

export function defaultChromeUserDataDir(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'Google', 'Chrome', 'User Data');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return join(homedir(), '.config', 'google-chrome');
}

export function shouldWarmOnStartup(config: GlobalConfig): boolean {
  const mode = config.browser?.mode ?? 'separate';
  if (mode === 'separate') return true;
  return (config.attach?.reconnect ?? 'lazy') === 'eager';
}

export function attachIsDeferred(config: GlobalConfig, phase: string, connected: boolean): boolean {
  if (connected || phase !== 'idle') return false;
  const mode = config.browser?.mode ?? 'separate';
  if (mode !== 'daily' && mode !== 'cdp') return false;
  return (config.attach?.reconnect ?? 'lazy') !== 'eager';
}

/** Uses DevToolsActivePort when it can be read. Otherwise probes 127.0.0.1:9222. */
export async function resolveDevToolsFile(profileDir: string, probe: InspectProbe = {}): Promise<ResolvedAttach> {
  const read = readDevToolsEndpoint(profileDir);
  if (read.kind === 'ok') {
    return {
      mode: 'daily',
      endpoint: read.browserWSEndpoint,
      endpointKind: 'devtools-file',
      userDataDir: profileDir,
    };
  }
  const port = probe.port ?? DEFAULT_INSPECT_PORT;
  const fallback = inspectFallbackFor(read, profileDir, port);
  const versionUrl = await probeVersion(new URL(`http://127.0.0.1:${port}/`));
  if (versionUrl) {
    return { mode: 'cdp', endpoint: versionUrl, endpointKind: 'cdp-http', cdpUrl: versionUrl, inspectFallback: fallback };
  }
  const open = await (probe.portOpen ?? portAccepts)(port);
  if (open) {
    const endpoint = inspectBrowserWs(port);
    return { mode: 'cdp', endpoint, endpointKind: 'cdp-ws', cdpUrl: endpoint, inspectFallback: fallback };
  }
  throw new RelayError('attach_failed', devToolsClosedPortMessage(fallback));
}

export function inspectBrowserWs(port: number): string {
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

export function devToolsFileProblem(fallback: InspectFallback): string {
  const file = join(fallback.profileDir, 'DevToolsActivePort');
  if (fallback.read === 'denied') {
    return `The process running relaywright cannot read ${file} (${fallback.code ?? 'EPERM'}). That host has no permission to read Chrome's configuration folder.`;
  }
  return `No DevToolsActivePort in ${fallback.profileDir}.`;
}

export function devToolsClosedPortMessage(fallback: InspectFallback): string {
  const problem = devToolsFileProblem(fallback);
  if (fallback.read === 'denied') {
    return `${problem} Nothing answered on 127.0.0.1:${fallback.port}. Attach with cdp_url ${inspectBrowserWs(fallback.port)}.`;
  }
  return `${problem} Nothing answered on 127.0.0.1:${fallback.port}. Open chrome://inspect/#remote-debugging and allow remote debugging for this browser.`;
}

export async function resolveCdpUrl(cdpUrl: string): Promise<ResolvedAttach> {
  const trimmed = cdpUrl.trim();
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return { mode: 'cdp', endpoint: trimmed, endpointKind: 'cdp-ws', cdpUrl: trimmed };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RelayError('bad_request', 'cdp_url must be an http(s) or ws(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayError('bad_request', 'cdp_url must be an http(s) or ws(s) URL');
  }
  const probed = await probeVersion(url);
  if (probed) return { mode: 'cdp', endpoint: probed, endpointKind: 'cdp-http', cdpUrl: trimmed };
  const ws = devtoolsWs(url);
  return { mode: 'cdp', endpoint: ws, endpointKind: 'cdp-ws', cdpUrl: ws };
}

export async function resolveAttachRequest(input: AttachRequest): Promise<ResolvedAttach> {
  const chosen = [input.auto ? 'auto' : '', input.cdpUrl ? 'cdp' : '', input.userDataDir ? 'dir' : ''].filter((item) => item.length > 0);
  if (chosen.length !== 1) throw new RelayError('bad_request', 'Choose one of --auto, --cdp-url, or --user-data-dir');
  if (input.cdpUrl) return resolveCdpUrl(input.cdpUrl);
  return resolveDevToolsFile(input.userDataDir || defaultChromeUserDataDir());
}

export async function resolveStoredAttach(config: GlobalConfig): Promise<ResolvedAttach> {
  const mode = config.browser?.mode;
  if (mode === 'cdp') {
    const cdpUrl = config.browser?.cdp_url;
    if (!cdpUrl) throw new RelayError('attach_failed', 'cdp mode has no cdp_url. Run: relaywright daemon attach --cdp-url <url>');
    return resolveCdpUrl(cdpUrl);
  }
  if (mode === 'daily') return resolveDevToolsFile(config.browser?.user_data_dir || defaultChromeUserDataDir());
  throw new RelayError('attach_failed', 'Browser mode is separate');
}

export async function connectWebSocket(endpoint: string, timeoutMs: number): Promise<Browser> {
  return puppeteer.connect({
    browserWSEndpoint: endpoint,
    defaultViewport: null,
    protocolTimeout: timeoutMs,
    wsOptions: { handshakeTimeout: timeoutMs },
  });
}

export function mapAttachError(err: unknown): RelayError {
  if (err instanceof RelayError) return err;
  const message = err instanceof Error ? err.message : 'Could not attach';
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || /timed out|timeout/i.test(message)) {
    return new RelayError('attach_timeout', `Timed out waiting for Chrome to allow the debugger. ${ATTACH_ALLOW_HINT}`);
  }
  return new RelayError('attach_failed', message);
}

/** Keeps a DevToolsActivePort failure visible when the inspect-port fallback also fails to connect. */
export function explainAttachFailure(target: ResolvedAttach, err: unknown): RelayError {
  const mapped = mapAttachError(err);
  if (!target.inspectFallback) return mapped;
  return new RelayError(mapped.code, `${devToolsFileProblem(target.inspectFallback)} ${mapped.message}`);
}

function inspectFallbackFor(read: DevToolsRead, profileDir: string, port: number): InspectFallback {
  if (read.kind === 'denied') return { read: 'denied', code: read.code, profileDir, port };
  return { read: 'missing', profileDir, port };
}

function devtoolsWs(url: URL): string {
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.pathname.startsWith('/devtools/')) return `${scheme}//${url.host}${url.pathname}`;
  return `${scheme}//${url.host}/devtools/browser`;
}

export function portAccepts(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function probeVersion(base: URL): Promise<string | null> {
  const version = new URL('/json/version', `${base.protocol}//${base.host}`);
  try {
    const response = await fetch(version, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!response.ok) return null;
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}
