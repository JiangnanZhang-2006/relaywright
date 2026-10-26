export const HANDOFF_TIMEOUT_MS = 10 * 60_000;
export const HANDOFF_STABLE_MS = 1_500;
export const LOGIN_PATH = /login|logon|signin|sign-in|slogin|cas|sso|oauth|auth/i;

export interface LoginCheck {
  url_contains?: string;
  text_absent?: string;
}

/**
 * A password field on the document the skill opened is part of that page (the timetable
 * fixture has one). A gate is a login-like path, or a landing path that is not the start path.
 */
export function pageNeedsLogin(currentUrl: string, startUrl: string, visiblePassword: boolean): boolean {
  let current: URL;
  let start: URL;
  try {
    current = new URL(currentUrl);
    start = new URL(startUrl);
  } catch {
    return visiblePassword;
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') return false;
  const loginPath = LOGIN_PATH.test(current.pathname);
  if (current.origin !== start.origin && loginPath) return true;
  if (!visiblePassword) return false;
  if (loginPath) return true;
  return normalizePath(current.pathname) !== normalizePath(start.pathname);
}

/** Default completion, or an identity login_check when one is present. */
export function handoffDone(
  loginUrl: string,
  currentUrl: string,
  visiblePassword: boolean,
  check?: LoginCheck,
  text = '',
): boolean {
  if (check && (check.url_contains || check.text_absent)) {
    if (check.url_contains && !currentUrl.includes(check.url_contains)) return false;
    if (check.text_absent && text.includes(check.text_absent)) return false;
    return true;
  }
  let start: URL;
  let current: URL;
  try {
    start = new URL(loginUrl);
    current = new URL(currentUrl);
  } catch {
    return false;
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') return false;
  if (current.origin === start.origin && current.pathname === start.pathname) return false;
  if (visiblePassword) return false;
  if (LOGIN_PATH.test(current.pathname)) return false;
  return true;
}

export function isLoginPath(url: string): boolean {
  try {
    return LOGIN_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function sameDocument(leftUrl: string, rightUrl: string): boolean {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

export function sameLocation(leftUrl: string, rightUrl: string): boolean {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    left.hash = '';
    right.hash = '';
    return left.href === right.href;
  } catch {
    return leftUrl === rightUrl;
  }
}

/** Where to send the tab when a handoff starts. Null means stay on the current page. */
export function handoffStartUrl(input: {
  currentUrl: string;
  explicitUrl?: string;
  loginPage: boolean;
  rememberedLoginUrl?: string;
}): string | null {
  if (input.explicitUrl) return sameLocation(input.currentUrl, input.explicitUrl) ? null : input.explicitUrl;
  if (!input.loginPage || !input.rememberedLoginUrl) return null;
  if (sameDocument(input.rememberedLoginUrl, input.currentUrl)) return null;
  return input.rememberedLoginUrl;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}
