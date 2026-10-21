/** Shared page-world helpers. Inserted into isolated-world expressions and callFunctionOn bodies. */
export const BROWSER_HELPERS = `
function rwCompact(value) {
  return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
}
function rwVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function rwCleanLabel(text) {
  return rwCompact(text).replace(/^\\*+\\s*/, '').replace(/[：:]\\s*$/, '');
}
function rwSemanticInteractive(el) {
  const tag = el.tagName;
  if (tag === 'A' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return type !== 'hidden';
  }
  const role = (el.getAttribute('role') || '').toLowerCase();
  return role === 'button' || role === 'link' || role === 'textbox' || role === 'combobox' || role === 'checkbox' || role === 'radio' || role === 'tab' || role === 'menuitem' || role === 'option' || role === 'searchbox' || role === 'switch' || role === 'slider';
}
function rwPrecedingLabel(container, select) {
  const labels = container.querySelectorAll('label, .control-label');
  let best = '';
  for (const label of labels) {
    if (label.contains(select)) continue;
    const position = label.compareDocumentPosition(select);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      const cleaned = rwCleanLabel(label.textContent || '');
      if (cleaned) best = cleaned;
    }
  }
  return best;
}
function rwLabel(select) {
  if (select.id) {
    const explicit = document.querySelector('label[for="' + CSS.escape(select.id) + '"]');
    if (explicit) {
      const cleaned = rwCleanLabel(explicit.textContent || '');
      if (cleaned) return cleaned;
    }
  }
  const aria = select.getAttribute('aria-label');
  if (aria) {
    const cleaned = rwCleanLabel(aria);
    if (cleaned) return cleaned;
  }
  const scoped = select.closest('.form-group, .layui-form-item, tr');
  if (scoped) {
    const found = rwPrecedingLabel(scoped, select);
    if (found) return found;
  }
  let parent = select.parentElement;
  for (let depth = 0; depth < 3 && parent; depth += 1) {
    const found = rwPrecedingLabel(parent, select);
    if (found) return found;
    parent = parent.parentElement;
  }
  return '';
}
function rwClassWidget(select, className) {
  const parent = select.parentElement;
  if (!parent) return null;
  for (const sibling of parent.children) {
    if (sibling !== select && sibling.classList.contains(className) && rwVisible(sibling)) return sibling;
  }
  return null;
}
function rwFindWidget(select) {
  if (select.id) {
    const byId = document.getElementById(select.id + '_chosen');
    if (byId && rwVisible(byId)) return byId;
  }
  const chosen = rwClassWidget(select, 'chosen-container');
  if (chosen) return chosen;
  const select2 = rwClassWidget(select, 'select2-container');
  if (select2) return select2;
  const layui = rwClassWidget(select, 'layui-form-select');
  if (layui) return layui;
  const bootstrap = select.closest('.bootstrap-select');
  if (bootstrap && bootstrap !== select && rwVisible(bootstrap)) return bootstrap;
  const next = select.nextElementSibling;
  if (next && rwVisible(next)) {
    const selected = select.options[select.selectedIndex];
    const text = selected ? rwCompact(selected.text) : '';
    if (text && rwCompact(next.textContent || '').includes(text)) return next;
  }
  return null;
}
function rwElementText(el) {
  return rwCompact(el.innerText || el.textContent || '').slice(0, 80);
}
`;

export const INSPECT_EXPRESSION = `(() => {
${BROWSER_HELPERS}
  const clickables = [];
  const clickableTexts = [];
  const elements = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of elements) {
    if (clickables.length >= 300) break;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') continue;
    if (!rwVisible(el)) continue;
    const onclick = el.hasAttribute('onclick') || typeof el.onclick === 'function';
    const parent = el.parentElement;
    const pointer = getComputedStyle(el).cursor === 'pointer' && !(parent && getComputedStyle(parent).cursor === 'pointer');
    // Only an explicit tabindex counts; many non-interactive elements are focusable by default.
    const tab = el.hasAttribute('tabindex') && el.tabIndex >= 0 && !rwSemanticInteractive(el);
    if (!onclick && !pointer && !tab) continue;
    clickables.push(el);
    clickableTexts.push(rwElementText(el));
  }
  const selects = [];
  for (const select of document.querySelectorAll('select')) {
    if (rwVisible(select)) continue;
    const widget = rwFindWidget(select);
    if (!widget) continue;
    const options = [];
    for (const option of select.options) options.push({ value: option.value, text: option.text });
    const selected = select.options[select.selectedIndex];
    selects.push({
      select: select,
      widget: widget,
      label: rwLabel(select),
      selectedText: selected ? selected.text : '',
      optionsJson: JSON.stringify(options),
    });
  }
  const passwords = [];
  for (const input of document.querySelectorAll('input[type="password"]')) passwords.push(input);
  return { clickables: clickables, clickableTextJson: JSON.stringify(clickableTexts), selects: selects, passwords: passwords };
})()`;
