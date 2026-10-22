import type { ModelItem } from '../perception/snapshot.js';

export type LocatorKind = 'role_name' | 'css' | 'text' | 'role_name_contains';

export interface LocatorHit {
  locator: LocatorKind;
  backend: number;
}

export interface LocateTarget {
  role: string;
  name: string;
  css?: string;
  text?: string;
  frame?: { name: string; url: string };
}

const TEXT_ROLES = new Set(['clickable', 'button', 'link']);

/** First unique hit wins. An ambiguous level falls through to the next locator. */
export function chooseLocator(items: readonly ModelItem[], target: LocateTarget, cssBackends: readonly number[] = []): LocatorHit | null {
  const scoped = items.filter((item) => frameOk(item, target));
  if (target.role && target.name) {
    const exact = scoped.filter((item) => item.role === target.role && item.name === target.name);
    if (exact.length === 1 && exact[0]) return { locator: 'role_name', backend: exact[0].backend };
  }
  if (target.css && cssBackends.length === 1 && cssBackends[0] !== undefined) {
    return { locator: 'css', backend: cssBackends[0] };
  }
  if (target.text) {
    const textual = scoped.filter((item) => textMatches(item, target.text ?? ''));
    if (textual.length === 1 && textual[0]) return { locator: 'text', backend: textual[0].backend };
  }
  if (target.role && target.name) {
    const partial = scoped.filter((item) => item.role === target.role && item.name.includes(target.name));
    if (partial.length === 1 && partial[0]) return { locator: 'role_name_contains', backend: partial[0].backend };
  }
  return null;
}

function textMatches(item: ModelItem, text: string): boolean {
  if (!text || !TEXT_ROLES.has(item.role)) return false;
  if (item.text !== undefined) return item.text === text;
  return item.name === text;
}

function frameOk(item: ModelItem, target: LocateTarget): boolean {
  if (!target.frame) return true;
  if (!item.frame) return false;
  if (target.frame.name && item.frame.name !== target.frame.name) return false;
  if (target.frame.url && item.frame.url !== target.frame.url) return false;
  return true;
}
