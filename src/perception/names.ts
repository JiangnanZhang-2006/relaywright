const GENERIC_TOKENS = new Set(['ng-star-inserted', 'icon', 'fa', 'fas', 'far', 'fab', 'material-icons', 'svg-icon']);

export interface NameParts {
  ariaLabel?: string;
  title?: string;
  className?: string;
  imgAlt?: string;
  imgTitle?: string;
  imgSrc?: string;
}

/** Fallback when an interactive control has no accessible name. */
export function fallbackControlName(parts: NameParts): string {
  const aria = compact(parts.ariaLabel ?? '');
  if (aria) return aria;
  const title = compact(parts.title ?? '');
  if (title) return title;
  const alt = compact(parts.imgAlt ?? '');
  if (alt) return alt;
  const imgTitle = compact(parts.imgTitle ?? '');
  if (imgTitle) return imgTitle;
  const token = classToken(parts.className ?? '');
  if (token) return `icon: ${token}`;
  const stem = fileStem(parts.imgSrc ?? '');
  if (stem && !generic(stem)) return `icon: ${stem}`;
  return '';
}

function classToken(className: string): string {
  for (const token of className.split(/\s+/)) {
    if (!token || generic(token) || token.startsWith('ant-')) continue;
    return token;
  }
  return '';
}

function generic(token: string): boolean {
  return GENERIC_TOKENS.has(token.toLowerCase());
}

function fileStem(src: string): string {
  const clean = src.split('?')[0]?.split('#')[0] ?? '';
  const base = clean.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  return base.slice(0, dot);
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
