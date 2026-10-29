import { RelayError } from '../errors.js';
import { readGlobalConfig } from '../privacy/store.js';
import { hostOfUrl, registrableDomain } from './domain.js';

export type BrowserModeName = 'separate' | 'daily' | 'cdp';

/** about:blank and browser-internal pages are not sites the allowlist can name. */
export function isUngatedUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  if (!value || value === 'about:blank') return true;
  return value.startsWith('about:') || value.startsWith('chrome:') || value.startsWith('chrome-error:') || value.startsWith('devtools:');
}

export function normalizeAllowDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) throw new RelayError('bad_request', 'domain is required');
  let host = trimmed;
  if (trimmed.includes('://')) {
    const parsed = hostOfUrl(trimmed);
    if (!parsed) throw new RelayError('bad_request', 'domain is not an http(s) host');
    host = parsed;
  } else {
    host = trimmed.split('/')[0] ?? '';
    if (host.includes(':') && !host.startsWith('[')) host = host.replace(/:\d+$/, '');
  }
  host = host.replace(/\.$/, '');
  if (!host || host === '.' || host.includes('..')) throw new RelayError('bad_request', 'domain is not a hostname');
  return registrableDomain(host);
}

export function readAllowDomains(root?: string): string[] {
  const raw = readGlobalConfig(root).allow_domains ?? [];
  const domains = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    try {
      domains.add(normalizeAllowDomain(item));
    } catch {
      // A bad stored entry must not block reading the rest of the list.
    }
  }
  return [...domains];
}

export type NavigationDecision = { ok: true } | { ok: false; domain: string };

/**
 * Daily and cdp always enforce the list. Separate mode enforces it only when the
 * list is non-empty, so existing profiles keep working until someone sets one.
 */
export function navigationDecision(
  url: string,
  mode: BrowserModeName,
  allow: readonly string[],
  grants: readonly string[],
): NavigationDecision {
  if (isUngatedUrl(url)) return { ok: true };
  const host = hostOfUrl(url);
  if (!host) return { ok: false, domain: url.slice(0, 120) };
  const domain = registrableDomain(host);
  const permitted = new Set([...allow, ...grants]);
  if (mode === 'separate' && allow.length === 0 && grants.length === 0) return { ok: true };
  if (permitted.has(domain)) return { ok: true };
  return { ok: false, domain };
}

export function domainNotAllowed(domain: string): RelayError {
  return new RelayError(
    'domain_not_allowed',
    `${domain} is not allowed. Call browser_request_access with this domain and a short reason.`,
  );
}
