export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  expires?: number;
  sourceScheme?: 'Secure' | 'NonSecure' | 'Unset';
  sourcePort?: number;
  partitionKey?: unknown;
}

export interface SetCookieParams {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires: number;
  sameSite?: string;
  priority?: string;
  domain?: string;
  url?: string;
  sourceScheme?: 'Secure' | 'NonSecure';
  sourcePort?: number;
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
const PRIORITY = new Set(['Low', 'Medium', 'High']);

export function cookieInDomains(cookieDomain: string, domains: readonly string[]): boolean {
  const host = cookieDomain.replace(/^\./, '').toLowerCase();
  return domains.some((domain) => {
    const root = domain.toLowerCase().replace(/^\./, '');
    return host === root || host.endsWith(`.${root}`);
  });
}

/** Session cookies become persistent. Host-only cookies (no leading dot) keep a url and no domain. */
export function persistentCookieParams(cookie: StoredCookie, nowSeconds: number, persistDays: number): SetCookieParams | null {
  if (cookie.partitionKey != null) return null;
  if (!cookie.session) return null;
  const expires = nowSeconds + persistDays * 24 * 60 * 60;
  const params: SetCookieParams = {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires,
  };
  if (cookie.sameSite && SAME_SITE.has(cookie.sameSite)) params.sameSite = cookie.sameSite;
  if (cookie.priority && PRIORITY.has(cookie.priority)) params.priority = cookie.priority;
  applySource(params, cookie);
  if (cookie.domain.startsWith('.')) {
    params.domain = cookie.domain;
    return params;
  }
  params.url = hostCookieUrl(cookie, params.path);
  return params;
}

export function deleteCookieParams(cookie: StoredCookie): { name: string; domain?: string; path?: string; url?: string } {
  const path = cookie.path || '/';
  if (cookie.domain.startsWith('.')) return { name: cookie.name, domain: cookie.domain, path };
  return { name: cookie.name, url: hostCookieUrl(cookie, path) };
}

function applySource(params: SetCookieParams, cookie: StoredCookie): void {
  if (cookie.sourceScheme === 'Secure' || cookie.sourceScheme === 'NonSecure') params.sourceScheme = cookie.sourceScheme;
  const port = cookie.sourcePort;
  if (typeof port === 'number' && Number.isInteger(port) && port > 0) params.sourcePort = port;
}

/** Chrome binds a cookie to the scheme and port it was set on, not only the Secure flag. */
function hostCookieUrl(cookie: StoredCookie, path: string): string {
  const https = cookie.secure || cookie.sourceScheme === 'Secure';
  const scheme = https ? 'https' : 'http';
  const host = cookie.domain.replace(/^\./, '');
  const port = cookie.sourcePort;
  const includePort = typeof port === 'number' && Number.isInteger(port) && port > 0 && port !== (https ? 443 : 80);
  const authority = includePort ? `${host}:${port}` : host;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${scheme}://${authority}${suffix}`;
}
