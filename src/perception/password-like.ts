/** Visible text inputs that sites use instead of type=password. type=password stays a password on its own. */

export const PASSWORD_TEXT_SOURCE = '密码|口令|password|passwd|pwd|passcode';
export const PASSWORD_EXACT_SOURCE = '^(mm|pass)$';

export interface PasswordHints {
  placeholder?: string;
  ariaLabel?: string;
  label?: string;
  name?: string;
  id?: string;
}

const textPattern = new RegExp(PASSWORD_TEXT_SOURCE, 'i');
const exactPattern = new RegExp(PASSWORD_EXACT_SOURCE, 'i');

export function looksLikePassword(hints: PasswordHints): boolean {
  if (textPattern.test(hints.placeholder ?? '')) return true;
  if (textPattern.test(hints.ariaLabel ?? '')) return true;
  if (textPattern.test(hints.label ?? '')) return true;
  const name = (hints.name ?? '').trim();
  const id = (hints.id ?? '').trim();
  if (textPattern.test(name) || textPattern.test(id)) return true;
  if (exactPattern.test(name) || exactPattern.test(id)) return true;
  return false;
}

/** Page-world helpers. Keep in step with looksLikePassword. */
export const PASSWORD_FIELD_HELPERS = `
function rwTextLikeInput(el) {
  if (!el || String(el.tagName || '').toUpperCase() !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return type === 'text' || type === 'search' || type === 'tel' || type === 'email' || type === 'url' || type === 'number';
}
function rwShown(el) {
  if (!el || el.nodeType !== 1) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function rwControlText(el) {
  const bits = [];
  const aria = el.getAttribute('aria-label') || '';
  if (aria) bits.push(aria);
  const labelled = el.getAttribute('aria-labelledby') || '';
  const doc = el.ownerDocument;
  if (labelled && doc) {
    const ids = labelled.split(/\\s+/);
    for (const id of ids) {
      if (!id) continue;
      const node = doc.getElementById(id);
      if (node) bits.push(node.textContent || '');
    }
  }
  if (el.id && doc) {
    try {
      const label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) bits.push(label.textContent || '');
    } catch (err) {}
  }
  if (typeof el.closest === 'function') {
    const wrap = el.closest('label');
    if (wrap) bits.push(wrap.textContent || '');
  }
  return bits.join(' ');
}
function rwPasswordLike(el) {
  if (!rwTextLikeInput(el)) return false;
  const text = /${PASSWORD_TEXT_SOURCE}/i;
  const exact = /${PASSWORD_EXACT_SOURCE}/i;
  const placeholder = el.getAttribute('placeholder') || '';
  const name = (el.getAttribute('name') || '').trim();
  const id = (el.id || '').trim();
  if (text.test(placeholder) || text.test(rwControlText(el))) return true;
  if (text.test(name) || text.test(id) || exact.test(name) || exact.test(id)) return true;
  return false;
}
`;

/** Runs in the page. True when a visible password or password-like field is showing. */
export function visiblePasswordEvaluator(): () => boolean {
  const body = `${PASSWORD_FIELD_HELPERS}
function rwWalk(doc) {
  if (!doc || !doc.querySelectorAll) return false;
  const inputs = doc.querySelectorAll('input');
  for (const input of inputs) {
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') continue;
    if (type === 'password') {
      if (rwShown(input)) return true;
      continue;
    }
    if (rwShown(input) && rwPasswordLike(input)) return true;
  }
  const frames = doc.querySelectorAll('iframe, frame');
  for (const frame of frames) {
    try {
      if (rwWalk(frame.contentDocument)) return true;
    } catch (err) {}
  }
  return false;
}
return rwWalk(document);`;
  return new Function(body) as () => boolean;
}
